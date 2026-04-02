# Session 8 — Step Sequencer

Read CLAUDE.md and the full codebase. This session focuses on one thing: a 16-step pattern sequencer that turns this sampler into a drum machine. The sequence recorder from Session 5 captures a live performance after the fact. This is fundamentally different — this is grid-based step programming where you place hits on a timeline before playback, exactly like an MPC, TR-808/909, Maschine, or the bottom half of Ableton's Drum Rack.

## How a step sequencer works

A step sequencer divides a musical bar into equal steps (typically 16 steps = sixteenth notes at the given BPM). Each pad has its own row of 16 steps. Each step is either on (trigger the pad) or off (silence). When you press play, a cursor moves across the steps from left to right at the BPM tempo. When the cursor hits an active step, it triggers the corresponding pad.

Beyond simple on/off, each step can have individual velocity (how hard the hit plays), probability (chance the hit actually fires — used for humanization and variation), note repeat/ratchet (subdivide a single step into rapid-fire retriggered hits), and nudge (micro-timing offset ahead or behind the grid for groove).

Patterns can be chained together to form longer sequences — Pattern A plays, then Pattern B, then back to A, creating an arrangement.

## What to build

### StepSequencer class

Create a new module at `src/audio/StepSequencer.js` (no React dependency):

```js
class StepSequencer {
  constructor(audioEngine) {
    this.audioEngine = audioEngine;
    this.isPlaying = false;
    this.isRecording = false;
    this.bpm = 128;
    this.swing = 0;                  // 0-100%, 0 = straight, 50 = full triplet swing
    this.currentStep = -1;
    this.currentPattern = 0;
    this.stepCount = 16;             // Steps per pattern (16 default, expandable to 32/64)
    this.patterns = new Map();       // Pattern bank
    this.chain = [];                 // Pattern chain for arrangement
    this.chainPosition = 0;
    this.loopMode = "pattern";       // "pattern" | "chain"
    
    // Scheduling
    this.nextStepTime = 0;
    this.scheduleIntervalId = null;
    this.lookAhead = 0.1;            // 100ms look-ahead
    this.scheduleInterval = 25;      // 25ms check interval
    
    // Callbacks (React hooks bind to these)
    this.onStepChange = null;        // (step, pattern) => void
    this.onPatternChange = null;     // (patternIndex) => void
    this.onPlayStateChange = null;   // (isPlaying) => void
    this.onTrigger = null;           // (padIndex, velocity, step) => void
  }
  
  // Transport
  play()
  stop()
  pause()
  
  // Pattern operations
  createPattern(name) → patternId
  getPattern(id) → Pattern
  setPattern(id, pattern)
  deletePattern(id)
  duplicatePattern(sourceId) → patternId
  clearPattern(id)
  
  // Step operations (on current pattern)
  toggleStep(padIndex, step)
  setStepVelocity(padIndex, step, velocity)
  setStepProbability(padIndex, step, probability)
  setStepRatchet(padIndex, step, subdivisions)
  setStepNudge(padIndex, step, nudgeMs)
  
  // Chain operations
  setChain(patternIds[])
  getChain() → patternIds[]
  
  // Real-time recording
  startRecording()
  stopRecording()
  recordHit(padIndex, velocity)      // Called during playback to punch-in hits
  
  // Utilities
  getStepDuration() → seconds        // Duration of one step at current BPM
  quantizeToStep(timeInBar) → step   // Snap a time to nearest step
  
  destroy()
}
```

### Pattern data model

Each pattern holds step data for all 16 pads:

```js
class Pattern {
  constructor(name = "Pattern A", stepCount = 16) {
    this.name = name;
    this.stepCount = stepCount;
    
    // 16 pads × N steps
    // Each step stores its full state
    this.tracks = Array.from({ length: 16 }, () => ({
      steps: Array.from({ length: stepCount }, () => ({
        active: false,
        velocity: 100,           // 0-127
        probability: 100,        // 0-100%
        ratchet: 1,              // 1 = normal, 2 = double, 3 = triple, 4 = quadruple
        nudge: 0,                // -50 to +50 ms (negative = ahead, positive = behind)
      })),
      mute: false,               // Mute this pad's track
      solo: false,               // Solo this pad's track
    }));
  }
  
  // Convenience methods
  toggleStep(pad, step)
  getStep(pad, step) → stepData
  setStep(pad, step, data)
  clearTrack(pad)
  clearAll()
  copyTrack(sourcePad, destPad)
  shiftTrack(pad, direction)      // Rotate steps left/right
  reverseTrack(pad)               // Reverse step order
  randomizeTrack(pad, density, velocityRange)
}
```

### Scheduling engine

This is the most critical piece. The sequencer must fire pad triggers with sample-accurate timing using the Web Audio API clock — never setTimeout or Date.now().

Use the same look-ahead scheduling pattern from Session 3's granular engine:

```js
_scheduleLoop() {
  const ctx = this.audioEngine.ctx;
  
  while (this.nextStepTime < ctx.currentTime + this.lookAhead) {
    this._scheduleStep(this.currentStep, this.nextStepTime);
    this._advanceStep();
    this.nextStepTime += this._getStepInterval();
  }
}

_getStepInterval() {
  // Base step duration: one sixteenth note
  const sixteenthDuration = (60 / this.bpm) / 4;
  
  // Apply swing to even-numbered steps (steps 1, 3, 5, 7...)
  // Swing delays the off-beat (even-indexed) steps
  if (this.currentStep % 2 === 1 && this.swing > 0) {
    const swingAmount = (this.swing / 100) * sixteenthDuration * 0.5;
    return sixteenthDuration + swingAmount;
  } else if (this.currentStep % 2 === 0 && this.swing > 0) {
    const swingAmount = (this.swing / 100) * sixteenthDuration * 0.5;
    return sixteenthDuration - swingAmount;
  }
  
  return sixteenthDuration;
}

_scheduleStep(step, time) {
  const pattern = this.getPattern(this.currentPattern);
  if (!pattern) return;
  
  // Check each pad's track for this step
  for (let pad = 0; pad < 16; pad++) {
    const track = pattern.tracks[pad];
    if (track.mute) continue;
    
    // Check solo: if ANY track is soloed, only play soloed tracks
    const anySolo = pattern.tracks.some(t => t.solo);
    if (anySolo && !track.solo) continue;
    
    const stepData = track.steps[step];
    if (!stepData.active) continue;
    
    // Probability gate
    if (stepData.probability < 100) {
      if (Math.random() * 100 > stepData.probability) continue;
    }
    
    // Apply nudge (micro-timing offset)
    const nudgeSeconds = stepData.nudge / 1000;
    const triggerTime = time + nudgeSeconds;
    
    // Handle ratchet (note repeat within the step)
    if (stepData.ratchet > 1) {
      const stepDuration = this._getStepInterval();
      const ratchetInterval = stepDuration / stepData.ratchet;
      for (let r = 0; r < stepData.ratchet; r++) {
        const ratchetTime = triggerTime + (r * ratchetInterval);
        const ratchetVelocity = stepData.velocity * (1 - (r * 0.15));  // Each ratchet slightly quieter
        this._triggerPad(pad, Math.max(1, ratchetVelocity), ratchetTime);
      }
    } else {
      this._triggerPad(pad, stepData.velocity, triggerTime);
    }
  }
  
  // Notify UI of step change (for cursor animation)
  this.onStepChange?.(step, this.currentPattern);
}

_triggerPad(padIndex, velocity, time) {
  // Schedule the pad trigger at the precise Web Audio time
  // This calls into AudioEngine which creates the voice with a start time
  this.audioEngine.triggerPadAtTime(padIndex, velocity / 127, time);
  this.onTrigger?.(padIndex, velocity, this.currentStep);
}

_advanceStep() {
  this.currentStep++;
  
  if (this.currentStep >= this.stepCount) {
    this.currentStep = 0;
    
    // If in chain mode, advance to next pattern in chain
    if (this.loopMode === "chain" && this.chain.length > 0) {
      this.chainPosition = (this.chainPosition + 1) % this.chain.length;
      this.currentPattern = this.chain[this.chainPosition];
      this.onPatternChange?.(this.currentPattern);
    }
  }
}
```

### AudioEngine.triggerPadAtTime()

Add a new method to AudioEngine that schedules a pad trigger at a specific Web Audio time (as opposed to "now"):

```js
triggerPadAtTime(padIndex, velocity, startTime) {
  // Same as triggerPad but uses startTime instead of ctx.currentTime
  // The BufferSource.start(startTime, offset, duration) handles the scheduling
  // The ADSR envelope automation also uses startTime as the base
}
```

This is the key difference from the existing `triggerPad` — the existing method triggers immediately, this one schedules for a future time. Both go through the same Voice creation and signal chain, just with a different start time.

### Real-time step recording

When recording is enabled during playback, incoming pad triggers (from MIDI, mouse, or keyboard) get quantized to the nearest step and written into the current pattern:

```js
recordHit(padIndex, velocity) {
  if (!this.isPlaying || !this.isRecording) return;
  
  // Quantize to nearest step
  const step = this.currentStep;
  
  const pattern = this.getPattern(this.currentPattern);
  const stepData = pattern.tracks[padIndex].steps[step];
  stepData.active = true;
  stepData.velocity = velocity;
}
```

This is "grid record" mode — hits snap to the current step position. The pad still triggers audibly in real-time (for monitoring), but the step data gets written at the quantized position.

## UI additions

### Sequencer panel

Add a new view accessible from a "Seq" tab in the header:

```
[Play] [Edit] [Send FX] [Perform FX] [Export] [Seq]
```

When the Seq tab is active, replace the waveform editor and signal chain sections with the step sequencer grid:

```
SEQUENCER ──────────────────────────────────────────────────────────────────

TRANSPORT ─────────────────────────────────────────────────────────────────
[▶ Play]  [■ Stop]  [● Rec]     BPM: [128.00]     SWING: [===●===] 50%

PATTERN: [A ▼]  [B]  [C]  [D]     [Copy]  [Paste]  [Clear]  [Random]
STEPS:   [16]  [32]  [64]         CHAIN: [A→B→A→B]  [Edit Chain]

STEP GRID ─────────────────────────────────────────────────────────────────
                 1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16
          ┌─────────────────────────────────────────────────────────────────┐
 PAD 1  M S│ [●] [○] [○] [○] [●] [○] [○] [○] [●] [○] [○] [○] [●] [○] [○] [○] │  KICK
 PAD 2  M S│ [○] [○] [○] [○] [●] [○] [○] [○] [○] [○] [○] [○] [●] [○] [○] [○] │  SNARE
 PAD 3  M S│ [●] [●] [●] [●] [●] [●] [●] [●] [●] [●] [●] [●] [●] [●] [●] [●] │  HAT
 PAD 4  M S│ [○] [○] [○] [○] [○] [○] [●] [○] [○] [○] [○] [○] [○] [○] [●] [○] │  OPEN HAT
 PAD 5  M S│ [○] [○] [○] [○] [○] [○] [○] [○] [○] [○] [○] [●] [○] [○] [○] [○] │  CLAP
  ...      │                                                                     │
 PAD 16 M S│ [○] [○] [○] [○] [○] [○] [○] [○] [○] [○] [○] [○] [○] [○] [○] [○] │  ---
          └─────────────────────────────────────────────────────────────────┘
                 ▲                             (cursor position)

VELOCITY LANE ─────────────────────────────────────────────────────────────
(for selected pad row)
  127 │  █           █                 █                 █                 │
      │  █           █                 █                 █                 │
      │  █           █                 █                 █                 │
   0  └─────────────────────────────────────────────────────────────────────┘
       1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16
```

### Step grid details

Each cell in the grid is a clickable step:

- **Click** — toggles step on/off
- **Shift+click** — opens step detail popover for velocity/probability/ratchet/nudge
- **Click+drag up/down** — adjust velocity for that step (quick velocity editing)
- **Right-click** — context menu: Copy Step, Paste Step, Clear Step, Set Ratchet, Set Probability

Step visual states:
- **Off** `[○]` — empty circle, dim (#1a2535)
- **On** `[●]` — filled circle, brightness proportional to velocity (low velocity = dim cyan, full velocity = bright cyan with glow)
- **On with reduced probability** `[◐]` — half-filled or dotted outline to indicate it won't always fire
- **On with ratchet** `[●●]` — small dots inside or below the step indicating subdivision count
- **Current playback position** — column highlight with a brighter background strip (#00e5ff10) that sweeps across during playback

### Step colors by velocity

Steps should visually communicate velocity through color intensity:

```
Velocity 1-30:    dim cyan, barely visible    (#00e5ff33)
Velocity 31-60:   low cyan                    (#00e5ff66)  
Velocity 61-90:   medium cyan                 (#00e5ff99)
Velocity 91-110:  bright cyan                 (#00e5ffcc)
Velocity 111-127: full cyan with glow         (#00e5ff, box-shadow)
```

### Track controls (per row)

Each pad row has controls on the left side:

- **M** — Mute toggle (dims the row, step triggers are skipped)
- **S** — Solo toggle (only soloed tracks play, all others mute)
- **Pad name label** — shows the pad number and optionally a user label. Click to select this pad row for velocity lane editing.
- Click the pad name to trigger the pad for auditioning (hear what's on that pad without starting the sequencer)

### Velocity lane

Below the step grid, show a velocity bar graph for the currently selected pad row. Each step gets a vertical bar whose height represents velocity (0-127). The user can:

- **Click+drag** on a bar to set velocity for that step
- **Draw mode** — click and drag across multiple bars to "draw" a velocity curve
- **Shift+click** on a bar to type an exact velocity value

The velocity lane should be 60-80px tall and use the same step spacing as the grid above it so bars align with their steps.

### Probability and ratchet indicators

Below the velocity lane, show two thin indicator rows for the selected pad:

```
PROB  │100│100│100│100│ 50│100│100│100│100│100│100│ 75│100│100│100│100│
RATCH │ 1 │ 1 │ 1 │ 1 │ 1 │ 1 │ 2 │ 1 │ 1 │ 1 │ 1 │ 1 │ 1 │ 1 │ 4 │ 1 │
```

These are compact — just small text values below each step. Click to edit.

### Step detail popover

When Shift+clicking a step, show a small popover anchored to that step:

```
┌────────────────────┐
│ STEP 7 — PAD 3     │
│                    │
│ VEL   [===●===] 95 │
│ PROB  [===●===] 50%│
│ RATCH [1] [2] [3] [4]│
│ NUDGE [===●===] -5ms│
│                    │
│ [Copy] [Clear]     │
└────────────────────┘
```

### Pattern selector

The pattern bank shows 4 pattern slots (A, B, C, D) as toggle buttons. The active pattern is highlighted in cyan. Clicking a different pattern switches to it — if the sequencer is playing, the switch happens at the END of the current pattern (quantized pattern switching, not immediate — no mid-bar jumps).

Patterns are independent — Pattern A can have a kick-snare-hat groove while Pattern B has a fill. They share the same pad sounds but have different step programming.

Additional pattern buttons:
- **Copy** — copies the current pattern into a clipboard
- **Paste** — pastes the clipboard over the current pattern (with confirmation)
- **Clear** — clears all steps in the current pattern (with confirmation)
- **Random** — generates a random pattern with configurable density. Opens a small popover:

```
┌─────────────────────────┐
│ RANDOMIZE               │
│                         │
│ Density  [===●===] 40%  │
│ Vel Min  [===●===] 60   │
│ Vel Max  [===●===] 127  │
│ Pads     [All] [Active] │
│                         │
│ [Generate]  [Cancel]    │
└─────────────────────────┘
```

### Pattern chain editor

When the user clicks "Edit Chain", show a chain programming interface:

```
┌────────────────────────────────────────────┐
│ PATTERN CHAIN                              │
│                                            │
│ Drag patterns to build a chain:            │
│                                            │
│ Available: [A] [B] [C] [D]                 │
│                                            │
│ Chain: [A] → [A] → [B] → [A] → [B] → [+] │
│                                            │
│ Click [+] to add, click entry to remove    │
│                                            │
│ LOOP  ☑ Loop chain                         │
│       ○ Play once and stop                 │
│                                            │
│ [Clear Chain]  [Done]                      │
└────────────────────────────────────────────┘
```

In chain mode, the transport shows which pattern in the chain is currently playing:

```
CHAIN: A → A → [B] → A → B    (bar 3 of 5)
```

### Transport bar

```
[▶ Play]  [■ Stop]  [● Rec]  [⟳ Loop]

BPM: 128.00  [Tap]            SWING: [===●===] 50%
```

- **Play** — starts the sequencer from step 1 (or current position if paused)
- **Stop** — stops playback and resets to step 1. Double-tap stop = panic (kills all active voices)
- **Rec** — toggles record arm. When armed and playing, incoming pad triggers write to the grid.
- **Loop** — toggles between pattern loop and chain mode
- **Tap** — tap tempo. Click 4+ times and BPM is calculated from the average interval between taps. Minimum 3 taps to calculate, smoothed with the last 4 intervals. Updates the engine BPM globally.

### Swing explanation

Swing delays every other step (the "off-beats" — steps 2, 4, 6, 8, 10, 12, 14, 16) by a percentage of the step duration. At 0% swing, all steps are evenly spaced (straight time). At 50% swing, the off-beat steps are delayed to the triplet position — this is classic MPC/SP-1200 swing that makes hip-hop feel "bouncy." At 100% swing (not commonly used), off-beats are delayed to the next on-beat position (effectively halving the resolution).

The swing value should sync with the engine BPM — changing BPM recalculates step intervals but preserves the swing ratio.

### Track operations toolbar

Row of buttons for batch operations on the selected pad's track:

```
[Shift ←] [Shift →] [Reverse] [Double] [Halve] [Invert] [Clear Track]
```

- **Shift ←/→** — rotates all steps in the track one position left or right (wraps around)
- **Reverse** — reverses the order of steps
- **Double** — copies first 8 steps to last 8 (useful for building variations)
- **Halve** — copies only odd steps into all 16 positions (compresses pattern)
- **Invert** — flips active/inactive for all steps
- **Clear Track** — clears only this pad's steps (not the whole pattern)

## Kit integration

### Saving patterns with kits

Patterns are part of the kit state. Update the kit schema from Session 7 to include sequencer data:

```js
// Add to kit data structure:
{
  // ... existing kit fields ...
  
  sequencer: {
    bpm: 128,
    swing: 0,
    stepCount: 16,
    currentPattern: 0,
    loopMode: "pattern",
    chain: [0, 0, 1, 0],
    patterns: [
      {
        name: "Pattern A",
        stepCount: 16,
        tracks: [
          {
            mute: false,
            solo: false,
            steps: [
              { active: true, velocity: 100, probability: 100, ratchet: 1, nudge: 0 },
              // ... 15 more steps
            ],
          },
          // ... 15 more tracks
        ],
      },
      // ... patterns B, C, D
    ],
  },
}
```

Run the Session 7 schema migration for this addition:

```js
// Migration: add sequencer to kits that don't have it
if (!kitData.sequencer) {
  kitData.sequencer = {
    bpm: kitData.engine?.bpm || 128,
    swing: 0,
    stepCount: 16,
    currentPattern: 0,
    loopMode: "pattern",
    chain: [],
    patterns: [createEmptyPattern("Pattern A")],
  };
}
```

### BPM sync

The sequencer BPM and the engine BPM must stay in sync. When the user changes BPM in either the sequencer transport or the engine params, both update. Use a single source of truth — the engine BPM — and have the sequencer read from it:

```js
// In StepSequencer:
get bpm() { return this.audioEngine.bpm; }
set bpm(val) { this.audioEngine.bpm = val; }
```

### WAV export integration

The existing sequence recorder from Session 5 should be updated to also export step sequencer patterns. When in the Export tab with "Sequence" mode selected:

- If there are recorded real-time events (Session 5), offer to export those
- If there are programmed step patterns, offer to export the current pattern or the full chain
- "Export Pattern" renders one pass through the current pattern
- "Export Chain" renders the full chain sequence

## Keyboard shortcuts for sequencer

When the Seq tab is active, add these shortcuts:

```
Space         — Play/Stop toggle
R             — Toggle record arm
1-9, 0        — Toggle steps 1-10 for selected pad row
Shift+1-6     — Toggle steps 11-16 for selected pad row
←/→           — Move step cursor (for keyboard step entry)
Enter         — Toggle step at cursor position for selected pad
↑/↓           — Select previous/next pad row
M             — Toggle mute on selected pad row
S             — Toggle solo on selected pad row
[             — Shift selected track left
]             — Shift selected track right
Tab           — Switch to next pattern (A→B→C→D→A)
```

## Constraints

- Do NOT touch the audio engine signal chain, MIDI mapping, or per-pad processing from Sessions 2-4
- Do NOT touch the waveform editor, canvas rendering, or hit point detection
- Do NOT modify the WAV encoder from Session 5 — extend the OfflineRenderer to support pattern rendering by feeding it the sequencer events
- Do NOT break the kit save/load system from Session 7 — extend the schema with sequencer data and add a migration for kits without it
- StepSequencer.js must have ZERO React imports — it's a plain JS class in `src/audio/`
- Follow the dependency rules from Session 6: StepSequencer lives in `audio/`, imports from `audio/` and `utils/`, never from `components/` or `state/`
- ALL timing must use `audioEngine.ctx.currentTime` — never setTimeout, Date.now(), or performance.now() for scheduling audio triggers. The setInterval for the look-ahead scheduler is fine (it doesn't schedule audio, it just checks what needs scheduling).
- Pattern switching during playback must be quantized — the new pattern starts on the next bar boundary, not immediately. Queue the switch and apply it when currentStep wraps to 0.
- Swing must be applied in the scheduling math, NOT by offsetting step positions in the UI. The grid always shows evenly-spaced steps — swing is a playback timing modifier only.
- Probability rolls (Math.random) must happen at schedule time, not at pattern creation time. Each loop through the pattern should re-roll probability for all steps — the same step might fire on one pass and not on the next.
- Ratchet retriggering must go through the same Voice/signal chain as normal triggers — don't create a separate playback path for ratcheted hits
- Mute/solo logic: if ANY track has solo enabled, ONLY soloed tracks play. If no tracks are soloed, all unmuted tracks play. Mute and solo are independent — a track can be both muted and soloed (solo wins).
- The step grid must be scrollable horizontally when in 32 or 64 step mode — don't try to squeeze 64 tiny cells onto screen. Show 16 at a time with scroll.
- Voice count during sequencer playback can spike quickly (16 pads × ratchets × reverb tails). Ensure the VoiceManager's voice stealing from Session 6 handles this gracefully — oldest voice gets stolen when the pool is exhausted.
- The playback cursor animation in the UI must be visually synced with the audio. Use the `onStepChange` callback to update React state, but accept that there will be ~25ms visual latency due to the scheduling interval. This is normal and acceptable — the AUDIO timing is sample-accurate, the VISUAL cursor is approximate.
- Maintain the cyan-on-dark LEAP aesthetic. Active steps use the standard cyan. Muted tracks use dimmed colors. The cursor column uses a subtle cyan highlight.
- Auto-save from Session 7 must capture the current sequencer state including all patterns and chain

## Testing

After implementation, verify:

1. Open the Seq tab. Click steps on pad 1's row to create a four-on-the-floor kick pattern (steps 1, 5, 9, 13). Press Play — kick fires on every beat at the correct BPM.
2. Add a snare on pad 2 at steps 5 and 13. Add hi-hats on pad 3 at all 16 steps. Press Play — standard drum beat plays with all three parts in time.
3. Set swing to 50%. Press Play — off-beat steps (hats on even steps) should have a noticeable shuffle feel. Set swing back to 0% — straight time again.
4. Shift+click step 7 on pad 3. Set ratchet to 4. Press Play — step 7 should play four rapid-fire hits within that single step duration.
5. Set probability to 50% on pad 3's hi-hat step 11. Play the pattern in a loop — step 11 should fire roughly half the time, creating variation.
6. Click+drag on the velocity lane to draw a crescendo across pad 3's steps (low velocity on step 1, max velocity on step 16). Press Play — hi-hats should get progressively louder.
7. Program Pattern A with a groove. Switch to Pattern B, program a fill. Set chain to A→A→A→B. Press Play in chain mode — the groove plays 3 times then the fill plays, then loops.
8. During playback with Rec armed, hit pad 5 via MIDI or keyboard — the hit should land on the nearest step and appear in the grid.
9. Click Shift → on pad 1's track — the entire kick pattern shifts one step right. Click Reverse — the pattern reverses.
10. Click Random with density 40% — a new random pattern generates across all pads. Steps should have varied velocities within the configured range.
11. Mute pad 3 (M button) — hi-hats stop playing. Solo pad 1 (S button) — only kick plays even though pad 2 (snare) is unmuted. Un-solo pad 1 — snare returns, hat stays muted.
12. Save the kit (Session 7). Refresh the page. Load the kit — all patterns, chain, swing, and step data should restore exactly.
13. Switch to Export tab, select Sequence mode, choose "Export Pattern" — the rendered WAV should sound identical to the live sequencer playback.
14. Change BPM in the sequencer transport — the engine BPM updates. Change BPM in the engine params — the sequencer follows.
15. In 32-step mode, the grid should scroll horizontally to show all steps. The playback cursor should scroll the view to stay visible.
16. Play a pattern with pad reverb sends — reverb tails from step triggers should ring out naturally, overlapping with subsequent hits.
17. Tap the Tap button 4 times at roughly 120bpm — the BPM should update to approximately 120.
