# Session 3 — Granular Timestretch Engine

Read CLAUDE.md and the full codebase. This session focuses on one thing: a granular timestretch engine that lets you change playback speed independently of pitch, and change pitch independently of speed. This is the core DSP feature that separates a toy sampler from a real instrument.

## How granular timestretch works

Instead of playing a sample as one continuous BufferSource, we split playback into a stream of tiny overlapping "grains" — typically 20-100ms each. Each grain is a short window of the original audio, faded in/out with a Hanning envelope to prevent clicks. By controlling two things independently:

1. **How fast we advance the read position** through the source buffer (this controls time/speed WITHOUT affecting pitch)
2. **The playbackRate of each grain's BufferSource** (this controls pitch WITHOUT affecting speed)

...we get independent pitch and time control. This is the same approach used in Ableton's Warp, Kontakt's Time Machine, and Serato's keylock.

## What to build

### GranularEngine class

Create a new class `GranularEngine` on the AudioCtx object with these capabilities:

```js
class GranularEngine {
  constructor(ctx, buffer, outputNode) { ... }
  
  // Core params
  grainSize      // 20-200ms, default 60ms
  grainOverlap   // 0.1-0.9, default 0.5 (50% overlap between consecutive grains)
  pitchShift     // -24 to +24 semitones, default 0
  timeStretch    // 0.25x to 4x, default 1x (1 = original speed)
  readPosition   // 0-1 normalized position in buffer
  
  // Methods
  start(startPos, endPos)   // Begin granular playback between two points
  stop()                    // Stop with grain fadeout (no clicks)
  setBuffer(buffer)         // Swap buffer without stopping
  seek(position)            // Jump read position (0-1 normalized)
}
```

### Grain scheduling

Use a scheduling loop that runs on the main thread with setInterval or requestAnimationFrame (NOT in an AudioWorklet for this implementation). The loop should:

1. Calculate when the next grain needs to be scheduled based on grainSize and grainOverlap
2. Create a BufferSource for the grain
3. Set its playbackRate to 2^(pitchShift/12) for pitch shifting
4. Apply a Hanning window via a GainNode envelope:
   - Linear ramp up over first half of grain
   - Linear ramp down over second half of grain
5. Schedule it with Web Audio's precise timing (ctx.currentTime)
6. Advance the read position by (grainSize * timeStretch) worth of samples
7. Handle loop boundaries — when readPosition reaches endPos, wrap to startPos if loop is enabled, or stop if not

### Grain window function

The Hanning envelope is critical for avoiding clicks. Each grain gets:

```
t=0:            gain = 0
t=grainSize/2:  gain = 1  
t=grainSize:    gain = 0
```

Use linearRampToValueAtTime for the ramps. The overlap means multiple grains are always playing simultaneously, and their envelopes sum to roughly constant amplitude when overlapped at 50%.

### Look-ahead scheduling

Don't schedule grains one at a time — use a look-ahead buffer of 50-100ms. The scheduling loop checks "do I need to schedule any grains in the next 100ms?" and schedules them all at once with precise start times. This prevents timing jitter from the main thread being busy.

```js
const LOOK_AHEAD = 0.1;  // 100ms look-ahead
const SCHEDULE_INTERVAL = 25; // check every 25ms

scheduleLoop() {
  while (this.nextGrainTime < this.ctx.currentTime + LOOK_AHEAD) {
    this.scheduleGrain(this.nextGrainTime);
    this.nextGrainTime += this.grainSize * (1 - this.grainOverlap);
    this.readPosition += (this.grainSize * this.timeStretch) / this.buffer.duration;
  }
}
```

## Integration with existing system

### Engine mode switching

Add a new engine mode to the existing TYPE selector. Currently there are "melody", "shift", "env order" modes. Add a "granular" mode:

- When TYPE = "melody" → use the current BufferSource playback (unchanged)
- When TYPE = "granular" → use the GranularEngine for playback

The Engine params section should show different controls based on mode:

- In granular mode, show: GRAIN SIZE (ms), OVERLAP (%), PITCH (st), STRETCH (x), and the existing BPM/Sync controls
- The PITCH knob replaces TUNE in granular mode (semitone control, -24 to +24)
- The STRETCH knob replaces SPEED in granular mode (0.25x to 4x)

### Per-pad integration

Each pad trigger via playSlice should check the engine mode:

```js
if (engine.type === "granular") {
  // Create GranularEngine instance for this voice
  // Connect through the pad's per-pad signal chain (filter → drive → ADSR → sends)
  // The GranularEngine outputs to the pad's filter input
} else {
  // Existing BufferSource path (unchanged)
}
```

The GranularEngine output connects to the SAME per-pad signal chain built in Session 2 — filter, drive, ADSR, sends all still apply on top of the granular output.

### BPM sync for timestretch

When Sync is ON and the engine is in granular mode:

- timeStretch should auto-calculate to match the sample's detected BPM to the engine BPM
- Formula: timeStretch = engine.bpm / sampleBPM
- If sample is 140bpm and engine is 70bpm, timeStretch = 0.5 (half speed, same pitch)
- The STRETCH knob should show the calculated value and be overridable

## UI additions

### Granular controls row

When granular mode is active, show a new control row below the existing engine params:

```
GRAIN SIZE      OVERLAP       PITCH        STRETCH
[===●====]     [===●====]    [===●====]   [===●====]
   60ms           50%          0.0 st        1.00x
```

Use the existing Knob component. These are GLOBAL granular params (not per-pad) since they control the engine behavior.

### Visual feedback

On the detail waveform canvas, draw the current grain read position as a moving vertical line (color: #00ff88, 1px) that advances through the waveform during playback. This gives visual feedback that granular playback is working and shows where in the sample the engine is reading.

Also draw a subtle shaded region showing the current grain window size centered on the read position (same color, 0.1 alpha fill).

## Constraints

- Do NOT touch the MIDI mapping, note-to-pad logic, or CC assignments
- Do NOT modify the per-pad signal chain from Session 2 — connect INTO it
- Do NOT touch the waveform overview canvas or hit point detection
- Do NOT change the keyboard shortcut mapping
- Keep the ref-based stale closure prevention pattern
- The GranularEngine must clean up ALL scheduled grain BufferSources on stop() — no zombie nodes leaking memory
- Cap active grain count at 32 per voice to prevent CPU overload — if grainSize is very small and overlap is very high, clamp the scheduling
- All grain scheduling times must use ctx.currentTime for sample-accurate timing — never use Date.now() or performance.now() for audio scheduling
- Existing "melody" mode playback must remain completely unchanged — granular is an additional mode, not a replacement
- Maintain the cyan-on-dark LEAP aesthetic for all new UI

## Testing

After implementation, verify:

1. Switch to granular mode, trigger a pad — you should hear smooth playback with no clicks or dropouts
2. Set PITCH to +12 st — sample should play one octave up at the SAME speed as original
3. Set STRETCH to 0.5x — sample should play at half speed at the SAME pitch as original
4. Set PITCH to +7 and STRETCH to 2x simultaneously — both should apply independently
5. Set GRAIN SIZE to 20ms vs 200ms — smaller grains = more artifacts but tighter transients, larger grains = smoother but more smeared
6. Enable loop, trigger a pad, change STRETCH in real time — playback should smoothly adapt without stopping
7. Trigger multiple pads in granular mode — each should have its own independent GranularEngine instance
8. Switch back to melody mode — original BufferSource playback should work exactly as before
9. Load a drum break, sync BPM, set engine BPM to half — loop should play at half tempo, same pitch, locked to grid
