Read CLAUDE.md and the full codebase. This session focuses on one thing: 
per-pad independent signal chains. Right now all 16 pads share a single 
global filter, ADSR, delay, and reverb. I need each pad to have its own 
isolated signal chain.

## What to build

Each of the 16 pads gets its own:
- ADSR envelope (attack, decay, sustain, release) 
- Multi-mode filter (lowpass, highpass, bandpass, notch) with freq + Q
- Drive/saturation stage (waveshaper with adjustable curve)
- Send levels to a shared delay bus and shared reverb bus

The signal flow per pad should be:
BufferSource → Filter → Drive → ADSR Gain → dry to Master + send to Delay Bus + send to Reverb Bus

The delay and reverb remain global shared buses — don't duplicate those 
per pad. Each pad just gets its own send level (0-1) to each bus.

## Data model

Refactor the pad state from the current flat structure:
```js
{ id, active, assigned, sliceStart, sliceEnd }
```
to:
```js
{
  id, active, assigned, sliceStart, sliceEnd,
  adsr: { attack: 0.005, decay: 0.1, sustain: 0.7, release: 0.2 },
  filter: { type: "lowpass", freq: 8000, q: 1 },
  drive: { amount: 0, curve: "soft" },
  delaySend: 0,
  reverbSend: 0,
  volume: 1,
  pan: 0
}
```

When a pad is triggered via MIDI or mouse, playSlice should pull the 
per-pad params — NOT the global ones. The global ADSR/filter controls 
should become the "edit" controls that modify whichever pad is currently 
selected (selectedPad state already exists).

## UI changes

- The existing knob section (ENVELOPE, FILTER, DELAY, REVERB) should 
  display and edit the SELECTED pad's values, not global values
- Add a small label above the knob section showing which pad is being 
  edited: "PAD 3" in cyan
- Add per-pad VOLUME and PAN knobs in that same section
- Add DELAY SEND and REVERB SEND knobs (these control per-pad send levels)
- When you click a different pad, the knobs update to show that pad's values
- Add a "COPY" and "PASTE" button next to the pad label so you can copy 
  one pad's settings to another

## Shared buses

Create the delay and reverb as persistent nodes that live on AudioCtx, 
not recreated per voice:
- AudioCtx.delayBus — CreateDelay + feedback loop + wet gain → master
- AudioCtx.reverbBus — ConvolverNode (generate a simple impulse response 
  algorithmically, don't load an IR file) + wet gain → master
- Each voice connects to these buses through its own send gain node

## Constraints

- Do NOT touch the MIDI mapping or note-to-pad logic — it works correctly
- Do NOT touch the waveform rendering or canvas code
- Do NOT touch the hit point detection or slice-to-pads logic
- Do NOT change the keyboard shortcut mapping
- Keep the ref-based stale closure prevention pattern for MIDI callbacks — 
  add padsRef sync for the new per-pad params
- No allocations in the audio path that can be pre-allocated
- The Launchkey CC knobs (21-28) should now control the SELECTED pad's 
  params instead of globals: CC21→filter freq, CC22→filter Q, CC23→attack, 
  CC24→decay, CC25→sustain, CC26→release, CC27→delay send, CC28→reverb send
- Maintain the cyan-on-dark LEAP/Kontakt 8 aesthetic for any new UI elements

## Testing

After implementation, verify:
1. Trigger pad 1 with a long release, trigger pad 2 with a short release — 
   they should behave independently
2. Set pad 1 filter to 200Hz LP, pad 2 to 8000Hz — they should sound different
3. Click between pads — knobs should update to show each pad's values
4. CC knobs on Launchkey should modify the selected pad only
5. Copy pad 1 settings, paste to pad 5 — pad 5 should now sound identical to pad 1