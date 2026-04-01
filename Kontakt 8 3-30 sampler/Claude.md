# LEAP Sampler Engine

## What this is
Browser-based audio sampler modeled after Native Instruments LEAP/Kontakt 8.
Pure Web Audio API + AudioWorklet DSP. React JSX single-file architecture.

## Architecture
- Single React component with embedded AudioCtx engine object
- Web Audio API: BufferSource → BiquadFilter → Gain (ADSR) → Delay → Master
- Web MIDI API: Launchkey 25 support (pads 36-51 ch10, keys 60-75 ch1, CC 21-28)
- Canvas-based waveform rendering (dual-pane overview + detail)
- Hit point transient detection with slice-to-pads auto-mapping

## Key constraints
- NO Tone.js — pure Web Audio API only
- AudioWorklet for any sample-accurate DSP processing
- No allocations in audio callback path
- All state refs must be kept in sync for MIDI callback (stale closure prevention)
- Cyan-on-dark aesthetic matching LEAP/Kontakt 8 UI

## Current state
- Working: waveform editor, 16-pad grid, ADSR/filter/delay chain, 
  MIDI input with velocity, keyboard triggers, hit point detection
- Needs work: AudioWorklet migration, granular timestretch, 
  convolver reverb, per-pad FX chains, WAV export