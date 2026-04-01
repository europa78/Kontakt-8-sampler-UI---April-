# Session 4 — Convolver Reverb (IR Loading + Wet/Dry)

Read CLAUDE.md and the full codebase. This session focuses on one thing: replacing the placeholder reverb with a proper ConvolverNode-based reverb system that supports both algorithmically generated impulse responses and user-loaded IR files. The reverb bus was scaffolded in Session 2 as a shared bus — now we make it real.

## How convolution reverb works

A ConvolverNode takes an impulse response (IR) — a short audio recording of a real space's acoustic signature — and mathematically convolves it with the input signal. The result is the input signal sounding like it was played in that space. This is how every professional reverb plugin works (Altiverb, Space Designer, Valhalla Room's hybrid mode, Kontakt's convolution FX).

The Web Audio API has a built-in ConvolverNode that handles the heavy FFT-based convolution on a separate thread. We just need to feed it an AudioBuffer containing the IR and route audio through it.

## What to build

### Algorithmic IR Generator

Build a function that creates synthetic impulse responses as AudioBuffers. This lets the sampler ship with built-in reverb presets without needing to load external files. Generate these IR types:

```js
AudioCtx.generateIR(type, params) → AudioBuffer

// Types:
"room"      // Small room, ~0.3-0.8s decay, early reflections at 5-20ms
"hall"       // Concert hall, ~1.5-3.0s decay, diffuse tail
"plate"      // Plate reverb, bright metallic character, ~1.0-2.5s decay
"chamber"    // Studio live chamber, ~0.8-1.5s decay, warm
"cathedral"  // Large cathedral, ~3.0-6.0s decay, massive tail
"spring"     // Spring reverb, ~0.5-1.5s, characteristic metallic boing
"ambient"    // Shimmer/ambient, very long ~4.0-10.0s, filtered high-end tail
```

Each IR generator should produce a STEREO AudioBuffer (2 channels). The algorithm for each type:

```js
function generateIR(type, params = {}) {
  const sr = ctx.sampleRate;
  const decay = params.decay || defaultDecayForType;
  const length = sr * decay;
  const buffer = ctx.createBuffer(2, length, sr);
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const envelope = Math.exp(-t * (6.0 / decay)); // exponential decay
    
    // Type-specific character:
    // "room" — dense early reflections + fast decay
    // "hall" — sparse early reflections + slow buildup + long tail
    // "plate" — no early reflections, immediate dense onset, bright
    // "spring" — comb-filtered noise with metallic resonances
    // etc.
    
    // Base: filtered noise shaped by envelope
    const noise = (Math.random() * 2 - 1);
    L[i] = noise * envelope * earlyReflectionPattern;
    R[i] = (Math.random() * 2 - 1) * envelope * earlyReflectionPattern;
  }
  
  // Post-process: apply gentle LP filter to darken the tail
  // (high frequencies decay faster in real spaces)
  applyDecayFilter(L, R, sr, type);
  
  return buffer;
}
```

Key characteristics per type:

- **Room**: Inject 4-8 discrete early reflections at specific delays (5ms, 11ms, 17ms, 23ms, etc.) before the diffuse tail. Short pre-delay (1-5ms). Apply strong high-frequency damping to the tail.
- **Hall**: Longer pre-delay (15-30ms). Sparse early reflections. Slow density buildup over first 80-150ms. Very gradual high-frequency rolloff in tail.
- **Plate**: Zero pre-delay. Immediately dense from sample 0. Bright character — minimal high-frequency damping. Slight metallic coloration via subtle comb filtering at very high frequencies.
- **Chamber**: Medium pre-delay (5-15ms). Warm character. Moderate density. Pronounced bass buildup.
- **Cathedral**: Long pre-delay (30-60ms). Very sparse initial reflections. Extremely slow density buildup. Massive tail with distinct low-frequency sustain.
- **Spring**: Short comb-filtered impulse with 2-3 prominent resonant peaks. Characteristic "drip" at onset. Rapid high-frequency decay with sustained low-mid ringing.
- **Ambient**: Apply a bandpass filter (800Hz-4kHz) to the noise before shaping. Very long, smooth, ethereal tail. Subtle pitch modulation via micro-variations in sample spacing.

### IR File Loading

Add the ability to load external WAV/MP3 IR files from disk:

```js
AudioCtx.loadIR(file) → Promise<AudioBuffer>
```

Decode the file using `ctx.decodeAudioData()`. If the file is mono, duplicate it to stereo. Normalize the IR to prevent level jumps when switching between presets.

### Reverb Bus Architecture

Refactor the existing reverb bus (from Session 2) to use the ConvolverNode:

```
Per-pad reverbSend gain → Pre-EQ (BiquadFilter) → ConvolverNode → Post-EQ (BiquadFilter) → Wet Gain → Master

                                                                                          → Dry path is handled by the per-pad direct connection to master
```

The reverb bus should be a persistent singleton on AudioCtx:

```js
AudioCtx.reverbBus = {
  input: GainNode,          // Sum of all per-pad reverb sends
  preEQ: BiquadFilter,      // Pre-convolution tone shaping
  convolver: ConvolverNode,  // The actual reverb processor
  postEQ: BiquadFilter,     // Post-convolution tone shaping  
  wetGain: GainNode,        // Master wet level
  
  // State
  currentIR: null,           // Current AudioBuffer
  currentPreset: "hall",     // Current preset name
  
  // Methods
  setPreset(type, params),   // Generate and load algorithmic IR
  loadFile(file),            // Load external IR file
  setWetLevel(value),        // 0-1
  setPreDelay(ms),           // 0-100ms additional pre-delay
  setDamping(freq),          // LP filter freq on the tail (pre-EQ)
  setBrightness(freq),       // HP filter on output (post-EQ)
}
```

The pre-EQ controls input tone going into the convolver (damping = lowpass to darken input). The post-EQ shapes the reverb output (brightness = highpass to thin out low-end mud).

### Pre-Delay

Add a DelayNode between the input and the ConvolverNode for adjustable pre-delay (0-100ms). This separates the dry signal from the reverb onset, adding clarity. This is NOT the same as the delay effect — this is a short fixed delay before the reverb tail begins.

```
reverbSend → Pre-Delay (DelayNode, 0-100ms) → Pre-EQ → ConvolverNode → Post-EQ → Wet Gain → Master
```

## UI changes

### Reverb controls section

Replace the current minimal reverb SIZE/MIX knobs with a full reverb control panel. This should appear in the signal chain section where the current REVERB knobs are:

```
REVERB ─────────────────────────────────────────────────────────
PRESET  [Room] [Hall] [Plate] [Chamber] [Cathedral] [Spring] [Ambient] [FILE]
                                                                         
DECAY       PRE-DELAY     DAMPING      BRIGHTNESS     WET         DRY
[==●===]    [==●===]     [==●===]     [==●===]     [==●===]    [==●===]
  2.0s        15ms        6.0kHz       200Hz         35%        100%

SIZE ──── [==============●===============] ──── scales decay + IR length
```

- **PRESET buttons**: Toggle buttons for each IR type. The FILE button opens a file picker to load an external IR.
- **DECAY knob**: 0.1s to 10.0s — regenerates the algorithmic IR when changed. Disabled when using a loaded file.
- **PRE-DELAY knob**: 0ms to 100ms
- **DAMPING knob**: 500Hz to 20kHz — controls the pre-EQ lowpass frequency
- **BRIGHTNESS knob**: 50Hz to 2kHz — controls the post-EQ highpass frequency
- **WET knob**: 0-100% — master wet level of the reverb bus
- **DRY knob**: 0-100% — kept at 100% by default, but allows ducking dry signal for 100% wet ambient effects
- **SIZE slider**: A macro control that proportionally scales decay time and IR length. Quick way to make any preset bigger or smaller without touching individual params.

### File loading indicator

When a user loads an IR file, show the filename next to the PRESET buttons:

```
PRESET  [Room] [Hall] [Plate] [...] [FILE ✓]  "Lexicon_480L_Large_Hall.wav"
```

### Visual IR display

Add a small waveform display (120px wide × 40px tall) next to the reverb controls that shows the current impulse response waveform. This gives visual feedback on the IR shape — users can see the difference between a short room and a long cathedral at a glance. Use the existing drawWaveform utility but with a simplified single-pass render (no markers, no grid, no hit points). Color: #aa88ff (purple to distinguish from the main cyan waveform).

## Constraints

- Do NOT touch the MIDI mapping, note-to-pad logic, or CC assignments
- Do NOT modify the per-pad signal chain routing from Session 2 — the per-pad reverbSend gain already exists, just make sure it connects to the new reverbBus.input
- Do NOT touch the GranularEngine from Session 3
- Do NOT touch the waveform editor canvases or hit point detection
- Do NOT touch the delay bus — it remains separate from reverb
- Keep the ref-based stale closure prevention pattern
- The ConvolverNode MUST be created once and reused — do NOT create a new ConvolverNode every time the preset changes. Just swap the .buffer property on the existing node.
- Normalize all generated IRs to -1.0/+1.0 peak to prevent level jumps between presets
- When generating IRs, use a Web Worker or do it asynchronously if the buffer is longer than 3 seconds — don't block the main thread. For shorter IRs, synchronous generation is fine.
- The reverb bus must handle the case where no IR is loaded (bypass mode) — don't error out with a null convolver buffer
- All IR AudioBuffers should be STEREO (2 channels) for proper spatial imaging
- IR generation must be deterministic for a given set of params — use a seeded PRNG, not Math.random(), so the same preset always sounds the same. Implement a simple mulberry32 or xoshiro128 seeded RNG.
- Maintain the cyan-on-dark LEAP aesthetic for all new UI. The IR waveform display should use #aa88ff (purple) to visually separate it from the main sample waveform.
- The FILE button should accept .wav, .mp3, .ogg, .flac, and .aif formats

## Performance considerations

- ConvolverNode with long IRs (>3s at 44.1kHz = >132k samples) is CPU-intensive. The browser handles this on a separate thread, but monitor for audio dropouts.
- Pre-generate all 7 algorithmic IRs on initialization and cache them in a Map. Switching presets should be instant (just swap the buffer reference), not require regeneration.
- When the DECAY knob changes, debounce the IR regeneration by 100ms so dragging the knob doesn't trigger 60 regenerations per second.
- The IR preview waveform should only redraw when the IR actually changes, not on every render cycle.

## Testing

After implementation, verify:

1. Click through all 7 preset buttons — each should produce a distinctly different reverb character. Room should be tight and short, cathedral should be massive and long.
2. Load an external IR WAV file — reverb should switch to the loaded IR. The filename should display. The DECAY knob should become disabled (can't change decay on a loaded file).
3. Play a drum hit with reverb send at 100% — you should hear a clear reverb tail that matches the selected preset character.
4. Adjust DAMPING from 20kHz down to 500Hz — the reverb tail should progressively darken and lose high-end sparkle.
5. Adjust PRE-DELAY from 0ms to 100ms — there should be an audible gap between the dry hit and the reverb onset at higher values.
6. Switch between presets while audio is playing — the transition should be smooth with no clicks or pops (the ConvolverNode handles buffer swaps gracefully).
7. Set WET to 100% and DRY to 0% — you should hear only the reverb signal, no dry signal. This is the "ambient wash" configuration.
8. Verify the IR preview waveform updates when switching presets — room should show a short spike, cathedral should show a long gradual decay.
9. Trigger multiple pads with different reverbSend levels — pad with 0% send should be completely dry, pad with 50% should have moderate reverb, pad with 100% should be fully wet.
10. Use the SIZE slider as a macro — dragging it up should make any preset sound bigger, dragging it down should make it tighter. The DECAY knob value should update to reflect the scaled value.
