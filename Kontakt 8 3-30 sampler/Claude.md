# LEAP Sampler Engine

## What this is
Browser-based audio sampler modeled after Native Instruments LEAP/Kontakt 8.
Pure Web Audio API + AudioWorklet DSP. React JSX single-file architecture.

## Architecture
- Single React component (leap-sampler.jsx) with embedded AudioCtx engine object
- AudioWorklet-based DSP (sampler-worklet-processor.js): sample playback, biquad filter, ADSR envelope, drive/saturation, granular timestretch — all on the audio thread
- Per-pad independent signal chains: each of 16 pads has own ADSR, filter, drive, volume, pan, delay send, reverb send
- Shared send buses: delay bus (feedback delay) + reverb bus (ConvolverNode with algorithmic IR)
- Signal chain per voice: AudioWorkletNode → VolumeGain → StereoPanner → MasterGain + DelaySendGain → DelayBus + ReverbSendGain → ReverbBus
- Web MIDI API: Launchkey 25 support (pads 36-51 ch10, keys 60-75 ch1, CC 21-28 → selected pad params)
- Canvas-based waveform rendering (dual-pane overview + zoomable detail)
- Hit point transient detection with slice-to-pads auto-mapping
- Drag-and-drop audio loading, per-pad waveform thumbnails
- Undo/redo system with gesture-level snapshots (one undo per knob drag)
- WAV export via OfflineAudioContext rendering

## Key constraints
- NO Tone.js — pure Web Audio API only
- AudioWorklet for all sample-accurate DSP processing
- No allocations in audio callback path
- All state refs must be kept in sync for MIDI callback (stale closure prevention)
- Cyan-on-dark aesthetic matching LEAP/Kontakt 8 UI

## Current state
- Working: AudioWorklet DSP engine, per-pad signal chains, biquad filter (LP/HP/BP/Notch),
  ADSR envelope, drive/saturation (soft/hard/clip), granular timestretch, convolver reverb,
  shared delay/reverb buses, waveform editor with zoom/scroll, 16-pad grid with mini waveforms,
  MIDI input with velocity, keyboard triggers, hit point detection, drag-and-drop loading,
  undo/redo, WAV export, pad copy/paste