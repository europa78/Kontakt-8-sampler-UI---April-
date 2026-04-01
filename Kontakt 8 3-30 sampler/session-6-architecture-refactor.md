# Session 6 — Multi-File Architecture Refactor (Split Into Modules)

Read CLAUDE.md and the full codebase. This session focuses on one thing: breaking the monolithic single-file React component into a proper multi-file module architecture. After Sessions 1-5, this codebase has grown into a massive single JSX file containing the audio engine, granular DSP, convolution reverb, WAV encoder, MIDI handling, waveform rendering, UI components, and state management all tangled together. That ends now.

## Why this matters

The single-file architecture was fine for prototyping but it's now a liability:

- Every edit requires scrolling through thousands of lines to find the right section
- Claude Code loses context and introduces regressions because it can't hold the entire file in working memory
- Audio DSP code is mixed with React rendering code — different concerns, different change frequencies
- No ability to unit test individual systems in isolation
- The audio engine is tightly coupled to React state — it should work independently as a standalone library
- Adding features means the file keeps growing linearly with no organizational boundary

## Target architecture

```
leap-sampler/
├── public/
│   └── index.html
├── src/
│   ├── index.jsx                          # Entry point — mounts App
│   ├── App.jsx                            # Top-level layout, tab routing, global state provider
│   │
│   ├── audio/                             # ── Pure audio engine, zero React dependency ──
│   │   ├── AudioEngine.js                 # Master audio context, master gain, bus routing
│   │   ├── VoiceManager.js                # Voice pool, allocation, stealing, polyphony limits
│   │   ├── Voice.js                       # Single voice: BufferSource → Filter → Drive → ADSR → output
│   │   ├── GranularEngine.js              # Granular timestretch (Session 3 code, extracted)
│   │   ├── ConvolverReverb.js             # Convolver reverb bus + IR generation (Session 4 code)
│   │   ├── DelayBus.js                    # Delay effect bus (ping-pong, feedback, wet/dry)
│   │   ├── IRGenerator.js                 # Algorithmic impulse response generation (all 7 presets)
│   │   ├── WAVEncoder.js                  # WAV file encoding (16/24/32-bit) + ZIP bundler
│   │   ├── OfflineRenderer.js             # OfflineAudioContext rendering (Session 5 code)
│   │   ├── SampleBuffer.js                # Sample loading, decoding, BPM detection, normalization
│   │   └── constants.js                   # Audio constants: default ADSR, filter ranges, CC mappings
│   │
│   ├── midi/                              # ── MIDI I/O, zero React dependency ──
│   │   ├── MIDIManager.js                 # Web MIDI API access, hot-plug, device enumeration
│   │   ├── MIDIRouter.js                  # Note/CC/PB routing, channel filtering, learn mode
│   │   └── LaunchkeyMap.js                # Novation Launchkey 25 specific mappings + defaults
│   │
│   ├── dsp/                               # ── DSP utilities, pure functions ──
│   │   ├── HitPointDetector.js            # Transient detection algorithm
│   │   ├── WaveformAnalyzer.js            # Peak calculation, RMS, BPM detection
│   │   └── WindowFunctions.js             # Hanning, Hamming, Blackman for granular grains
│   │
│   ├── components/                        # ── React UI components ──
│   │   ├── Header.jsx                     # Top bar: logo, kit name, tab navigation
│   │   ├── WaveformEditor/
│   │   │   ├── WaveformEditor.jsx         # Container: overview + detail panes
│   │   │   ├── WaveformCanvas.jsx         # Canvas rendering: waveform, markers, grid, hit points
│   │   │   ├── MarkerDrag.js              # S/L/E marker drag logic (non-React, pure pointer math)
│   │   │   └── GridOverlay.js             # Grid line calculation for snap-to-grid
│   │   ├── EngineControls/
│   │   │   ├── EngineControls.jsx         # Engine params: TYPE, HQ, Formants, Reverse, Sync, BPM
│   │   │   ├── GranularControls.jsx       # Grain size, overlap, pitch, stretch (visible in granular mode)
│   │   │   └── PlaybackControls.jsx       # Loop, trigger style, choke, legato
│   │   ├── PadGrid/
│   │   │   ├── PadGrid.jsx               # 16-pad grid container + group/single mode
│   │   │   ├── Pad.jsx                    # Single circular pad with infinity symbol + active state
│   │   │   ├── PadContextMenu.jsx         # Right-click menu: export, copy, paste, reset
│   │   │   └── PadToolbar.jsx             # Follow, quantize, start key, tonality, scroll arrows
│   │   ├── SignalChain/
│   │   │   ├── SignalChainPanel.jsx        # Container for per-pad controls
│   │   │   ├── EnvelopeControls.jsx       # ADSR knobs for selected pad
│   │   │   ├── FilterControls.jsx         # Filter type + freq + Q for selected pad
│   │   │   ├── DriveControls.jsx          # Drive amount + curve for selected pad
│   │   │   ├── SendControls.jsx           # Delay send + reverb send for selected pad
│   │   │   └── ReverbPanel.jsx            # Reverb preset selector, decay, damping, IR preview
│   │   ├── Keyboard/
│   │   │   ├── MIDIKeyboard.jsx           # 61-key piano + zone highlights + pitch/mod wheels
│   │   │   ├── PianoKey.jsx               # Single key with black/white/active/zone styling
│   │   │   └── MIDIStatus.jsx             # Connection dot, device name, MIDI learn log
│   │   ├── ExportPanel/
│   │   │   ├── ExportPanel.jsx            # Export tab: mode selector, format options, render button
│   │   │   ├── SequenceRecorder.jsx       # Record/stop/play transport + quantize controls
│   │   │   └── RenderProgress.jsx         # Progress bar, preview, download button
│   │   ├── shared/
│   │   │   ├── Knob.jsx                   # Draggable rotary knob (extracted from current inline)
│   │   │   ├── Toggle.jsx                 # Toggle button (extracted from current inline)
│   │   │   ├── Slider.jsx                 # Horizontal slider for SIZE macro, sensitivity, etc.
│   │   │   └── WheelControl.jsx           # Pitch/mod wheel vertical strip
│   │   └── GridControls.jsx               # Grid on/off, width, snap mode, hit points, slice-to-pads
│   │
│   ├── state/                             # ── State management ──
│   │   ├── SamplerContext.jsx             # React context provider: all sampler state + dispatch
│   │   ├── useSamplerState.js             # Custom hook: initializes and returns sampler state
│   │   ├── useMIDI.js                     # Custom hook: MIDI setup, message routing, ref sync
│   │   ├── useKeyboard.js                 # Custom hook: keyboard shortcut mapping
│   │   ├── useAudioEngine.js              # Custom hook: bridges React state ↔ AudioEngine
│   │   └── padReducer.js                  # Reducer for pad state: trigger, release, update params, copy/paste
│   │
│   ├── utils/                             # ── Shared utilities ──
│   │   ├── noteUtils.js                   # Note name ↔ MIDI number conversion
│   │   ├── formatters.js                  # Display formatters: Hz, ms, dB, percentage, BPM
│   │   └── seededRNG.js                   # Deterministic PRNG for IR generation (from Session 4)
│   │
│   └── styles/
│       ├── theme.js                       # Color palette, spacing, typography constants
│       └── mixins.js                      # Reusable style objects: section, paramRow, paramLabel, etc.
│
├── CLAUDE.md
├── package.json
└── prompts/
    ├── session-1-audioworklet.md
    ├── session-2-per-pad-chains.md
    ├── session-3-granular-timestretch.md
    ├── session-4-convolver-reverb.md
    ├── session-5-wav-export.md
    └── session-6-architecture-refactor.md
```

## Module responsibilities and boundaries

### The golden rule: audio/ and midi/ directories must have ZERO React imports

This is the most important architectural constraint. The audio engine and MIDI system are standalone JavaScript modules that know nothing about React. They expose plain class instances and methods. React hooks in `state/` bridge them to the UI.

This means:
- `AudioEngine.js` does NOT import useState or useRef
- `MIDIManager.js` does NOT import useEffect
- `Voice.js` does NOT call setPads or setActiveKeys
- These modules communicate via callbacks and events, not React state

### audio/AudioEngine.js

The central audio system. Owns the AudioContext, master gain, and bus routing.

```js
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.voiceManager = null;
    this.delayBus = null;
    this.reverbBus = null;
    this.offlineRenderer = null;
    this.isInitialized = false;
  }
  
  init() {
    this.ctx = new AudioContext({ sampleRate: 44100 });
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
    this.voiceManager = new VoiceManager(this.ctx, this.masterGain);
    this.delayBus = new DelayBus(this.ctx, this.masterGain);
    this.reverbBus = new ConvolverReverb(this.ctx, this.masterGain);
    this.offlineRenderer = new OfflineRenderer(this);
    this.isInitialized = true;
  }
  
  // Trigger a pad — returns a voice handle
  triggerPad(padConfig, velocity) → VoiceHandle
  
  // Release a voice
  releaseVoice(voiceHandle)
  
  // Load and decode an audio file
  async loadSample(file) → SampleBuffer
  
  // Generate demo buffer
  generateDemo(type, bpm) → AudioBuffer
  
  // Export
  async renderPad(padConfig, options) → AudioBuffer
  async renderSequence(events, padConfigs, options) → AudioBuffer
  encodeWAV(buffer, bitDepth) → Blob
  downloadWAV(blob, filename)
  
  // Cleanup
  destroy()
}

// Singleton
export const audioEngine = new AudioEngine();
```

### audio/VoiceManager.js

Manages the voice pool, polyphony, and voice stealing:

```js
class VoiceManager {
  constructor(ctx, output, maxVoices = 32) { ... }
  
  allocate(buffer, sliceStart, sliceEnd, padConfig, velocity, engineConfig) → Voice
  release(voice)
  releaseAll()
  getActiveCount() → number
}
```

### audio/Voice.js

A single playback voice with its complete signal chain:

```js
class Voice {
  constructor(ctx, buffer, config) { ... }
  
  // The full chain built in constructor:
  // source → filter → drive → adsrGain → [delaySend, reverbSend, dryOutput]
  
  start(startTime)
  stop()       // Triggers ADSR release phase
  kill()       // Immediate stop (voice stealing)
  
  isActive → boolean
  isReleasing → boolean
}
```

### midi/MIDIManager.js

Handles Web MIDI API access with hot-plug and device enumeration:

```js
class MIDIManager {
  constructor() {
    this.access = null;
    this.inputs = new Map();
    this.devices = [];
    this.onMessage = null;       // Callback: (status, byte1, byte2, channel, deviceName) => void
    this.onDeviceChange = null;  // Callback: (devices[]) => void
  }
  
  async init()
  getDevices() → [{ name, manufacturer, state, id }]
  destroy()
}
```

### midi/MIDIRouter.js

Routes MIDI messages to the right handler based on message type:

```js
class MIDIRouter {
  constructor(midiManager) { ... }
  
  onNoteOn = null;     // (note, velocity, channel) => void
  onNoteOff = null;    // (note, channel) => void
  onCC = null;         // (cc, value, channel) => void
  onPitchBend = null;  // (value, channel) => void  // -1 to +1
  onModWheel = null;   // (value) => void            // 0 to 1
  
  // MIDI Learn
  startLearn(callback)  // callback receives raw messages for display
  stopLearn()
}
```

### midi/LaunchkeyMap.js

Novation Launchkey 25 specific defaults:

```js
export const LAUNCHKEY_MAP = {
  // Drum pads: notes 36-51 on channel 10
  drumPads: { startNote: 36, endNote: 51, channel: 9 },
  
  // Keys: notes 48-72 on channel 1
  keys: { startNote: 48, endNote: 72, channel: 0 },
  
  // Rotary knobs: CC 21-28 on channel 1
  knobs: {
    21: 'filterFreq',
    22: 'filterQ',
    23: 'attack',
    24: 'decay',
    25: 'sustain',
    26: 'release',
    27: 'delaySend',
    28: 'reverbSend',
  },
  
  // Map a note to a pad index (0-15), returns -1 if unmapped
  noteToPad(note, channel) { ... },
  
  // Check if a device name matches Launchkey
  isLaunchkey(deviceName) { ... },
};
```

### state/SamplerContext.jsx

React context that holds all UI state and provides dispatch:

```jsx
const SamplerContext = createContext();

export function SamplerProvider({ children }) {
  // All state lives here:
  const [buffer, setBuffer] = useState(null);
  const [pads, dispatch] = useReducer(padReducer, initialPads);
  const [selectedPad, setSelectedPad] = useState(0);
  const [engine, setEngine] = useState(defaultEngine);
  const [granular, setGranular] = useState(defaultGranular);
  // ... all other state from the current monolith
  
  // Audio engine ref (not state — doesn't trigger renders)
  const engineRef = useRef(audioEngine);
  
  // Bridge: React state → audio engine
  useAudioEngine(engineRef, buffer, pads, engine, ...);
  
  // MIDI
  useMIDI(engineRef, pads, selectedPad, ...);
  
  // Keyboard
  useKeyboard(engineRef, pads, ...);
  
  return (
    <SamplerContext.Provider value={{ buffer, pads, dispatch, selectedPad, engine, ... }}>
      {children}
    </SamplerContext.Provider>
  );
}

export const useSampler = () => useContext(SamplerContext);
```

### state/useAudioEngine.js

The critical bridge between React state and the audio engine:

```js
export function useAudioEngine(engineRef, buffer, pads, engineConfig, ...) {
  // Keep refs in sync for MIDI callbacks (the stale closure pattern)
  const bufferRef = useRef(buffer);
  const padsRef = useRef(pads);
  useEffect(() => { bufferRef.current = buffer; }, [buffer]);
  useEffect(() => { padsRef.current = pads; }, [pads]);
  
  // Expose trigger/release via refs so MIDI callback can access them
  const triggerNote = useCallback((note, velocity, channel) => {
    const buf = bufferRef.current;
    const currentPads = padsRef.current;
    if (!buf) return;
    // ... trigger logic using engineRef.current
  }, []);
  
  const releaseNote = useCallback((note, channel) => {
    // ... release logic
  }, []);
  
  return { triggerNote, releaseNote, triggerNoteRef, releaseNoteRef };
}
```

### state/padReducer.js

Reducer for all pad state mutations:

```js
export function padReducer(state, action) {
  switch (action.type) {
    case 'TRIGGER':
      return state.map((p, i) => i === action.pad ? { ...p, active: true } : p);
    case 'RELEASE':
      return state.map((p, i) => i === action.pad ? { ...p, active: false } : p);
    case 'UPDATE_PARAM':
      return state.map((p, i) => i === action.pad ? { ...p, [action.key]: { ...p[action.key], ...action.value } } : p);
    case 'SET_SLICE':
      return state.map((p, i) => i === action.pad ? { ...p, sliceStart: action.start, sliceEnd: action.end } : p);
    case 'COPY':
      return state; // handled externally via clipboard state
    case 'PASTE':
      return state.map((p, i) => i === action.pad ? { ...action.source, id: p.id, active: p.active } : p);
    case 'SLICE_TO_PADS':
      return action.pads;
    case 'RESET':
      return state.map((p, i) => i === action.pad ? { ...defaultPad, id: p.id } : p);
    default:
      return state;
  }
}
```

### styles/theme.js

Extract all hardcoded colors and styling constants:

```js
export const theme = {
  colors: {
    bg: '#0a0e14',
    bgDeep: '#060a0f',
    bgPanel: '#0d1117',
    bgElevated: '#0d1520',
    border: '#1a2030',
    borderLight: '#1a2535',
    
    cyan: '#00e5ff',
    cyanDim: '#00e5ff44',
    cyanGlow: 'rgba(0,229,255,0.4)',
    
    green: '#00ff88',
    red: '#ff3366',
    amber: '#ffc800',
    purple: '#aa88ff',
    orange: '#ff8800',
    
    textPrimary: '#c8d6e5',
    textSecondary: '#8899aa',
    textDim: '#556677',
    textMuted: '#445566',
    textDark: '#334455',
  },
  
  fonts: {
    mono: "'JetBrains Mono', 'SF Mono', monospace",
  },
  
  sizes: {
    headerHeight: 40,
    padSize: 48,
    knobDefault: 36,
    knobSmall: 28,
    keyWhiteWidth: 24,
    keyBlackWidth: 18,
    keyWhiteHeight: 72,
    keyBlackHeight: 50,
  },
  
  spacing: {
    sectionPadding: '8px 16px',
    gap: {
      xs: 2, sm: 4, md: 8, lg: 12, xl: 16, xxl: 24,
    },
  },
};
```

## Extraction order

Do the refactor in this exact sequence to minimize breakage at each step. After each step, the app must still work — no big-bang refactor.

### Step 1: Extract shared UI components (Knob, Toggle, Slider, WheelControl)

These are pure presentational components with zero audio or state dependencies. Easiest to extract. Pull them out of the monolith into `components/shared/`. Update imports in the monolith. Verify the app still renders.

### Step 2: Extract theme and styles

Pull all hardcoded color values, font strings, and spacing values into `styles/theme.js`. Replace inline color strings throughout the monolith with theme references. This is tedious but mechanical.

### Step 3: Extract the audio engine core

This is the biggest and most critical extraction. Pull the AudioCtx object out into `audio/AudioEngine.js`, `audio/Voice.js`, `audio/VoiceManager.js`, `audio/DelayBus.js`. These modules must have ZERO React imports. The monolith imports `audioEngine` from `audio/AudioEngine.js` and uses it the same way it currently uses the AudioCtx object.

### Step 4: Extract MIDI

Pull MIDI handling into `midi/MIDIManager.js`, `midi/MIDIRouter.js`, `midi/LaunchkeyMap.js`. Create the `state/useMIDI.js` hook that bridges the MIDIRouter callbacks to React state updates (setPads, setActiveKeys, etc.).

### Step 5: Extract DSP utilities

Pull hit point detection into `dsp/HitPointDetector.js`, waveform analysis into `dsp/WaveformAnalyzer.js`, window functions into `dsp/WindowFunctions.js`.

### Step 6: Extract GranularEngine and ConvolverReverb

Pull `audio/GranularEngine.js`, `audio/ConvolverReverb.js`, `audio/IRGenerator.js` from the monolith. These depend on AudioEngine but not on React.

### Step 7: Extract WAV export

Pull `audio/WAVEncoder.js`, `audio/OfflineRenderer.js` from the monolith.

### Step 8: Extract React components

Now break the monolith's render method into component files. Start with the largest sections:
1. `components/WaveformEditor/` — canvas rendering + marker drag
2. `components/PadGrid/` — 16 pads + toolbar
3. `components/Keyboard/` — piano keys + MIDI status
4. `components/EngineControls/` — engine params section
5. `components/SignalChain/` — ADSR, filter, drive, sends, reverb panel
6. `components/ExportPanel/` — export tab
7. `components/Header.jsx` — top bar
8. `components/GridControls.jsx` — grid/snap/hit point controls

### Step 9: Create state management

Create `state/SamplerContext.jsx` with all state moved into the provider. Create `state/padReducer.js`. Create custom hooks. Update all components to use `useSampler()` instead of props drilling.

### Step 10: Create App.jsx and index.jsx

Wire everything together. App.jsx wraps children in SamplerProvider. index.jsx mounts App.

## Import rules

Enforce these dependency directions — violations mean the architecture is broken:

```
audio/  → imports from: audio/, dsp/, utils/         → NEVER imports from: components/, state/, midi/
midi/   → imports from: midi/, utils/                 → NEVER imports from: components/, state/, audio/
dsp/    → imports from: dsp/, utils/                  → NEVER imports from: anything else
state/  → imports from: state/, audio/, midi/, utils/  → NEVER imports from: components/
components/ → imports from: components/, state/, utils/, styles/ → NEVER imports from: audio/, midi/ directly
utils/  → imports from: nothing                       → Pure standalone utilities
styles/ → imports from: nothing                       → Pure constants
```

Components NEVER touch the audio engine or MIDI directly. They go through hooks in `state/` which bridge the gap. This is what makes the audio engine testable and reusable independently.

## Package.json setup

```json
{
  "name": "leap-sampler",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.2.0",
    "vite": "^5.0.0"
  }
}
```

Use Vite, not Create React App. CRA is deprecated and slow. Vite gives you instant HMR, fast builds, and native ES module support. The vite config is minimal:

```js
// vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
  },
});
```

## CLAUDE.md update

After the refactor is complete, update CLAUDE.md to reflect the new architecture:

```markdown
# LEAP Sampler Engine

## Architecture
Multi-module React + Vite application.

### Directory structure
- `src/audio/` — Pure JS audio engine (no React). Entry: AudioEngine.js
- `src/midi/` — Pure JS MIDI system (no React). Entry: MIDIManager.js  
- `src/dsp/` — Pure function DSP utilities
- `src/components/` — React UI components
- `src/state/` — React context, hooks, reducers
- `src/utils/` — Shared utilities
- `src/styles/` — Theme constants

### Dependency rule
audio/ and midi/ must NEVER import React.
components/ must NEVER import audio/ or midi/ directly — always go through state/ hooks.

### Key files
- AudioEngine.js — singleton, owns AudioContext and all buses
- VoiceManager.js — voice pool with allocation and stealing
- MIDIRouter.js — routes MIDI messages to callbacks
- SamplerContext.jsx — React state provider, single source of truth
- useAudioEngine.js — bridges React state ↔ AudioEngine via refs

### Running
npm install && npm run dev
```

## Constraints

- Every step must leave the app in a working state — no step should break functionality
- Do NOT change any DSP logic, audio routing, MIDI mapping, or behavioral logic — this is PURELY a structural refactor
- Do NOT rename functions or methods unless necessary for the module API (e.g., AudioCtx.playSlice becomes audioEngine.triggerPad)
- Do NOT add new features — resist the urge to "improve" things while refactoring
- Do NOT introduce any new dependencies beyond Vite and its React plugin — no state management libraries (Redux, Zustand, Jotai), no CSS frameworks, no utility libraries
- The stale closure prevention pattern (refs for MIDI callbacks) must survive the refactor intact in useAudioEngine.js and useMIDI.js
- All 7 reverb IR presets must still generate identically (seeded RNG must produce same output)
- The Launchkey 25 MIDI mapping must work exactly as before
- Keyboard shortcuts (Z-M, A-K) must work exactly as before
- WAV export must produce bit-identical output
- The Knob component must support both mouse and touch drag (verify the touch handlers survive extraction)
- Do NOT use TypeScript — keep everything as plain JS/JSX. TypeScript migration is a separate session if desired.
- Maintain the exact same visual appearance — no CSS changes beyond moving values into theme.js

## Testing

After the full refactor is complete, verify:

1. `npm run dev` starts the dev server with no console errors
2. Click INITIALIZE — audio context starts, demo buffer loads, waveform renders
3. Click/trigger all 16 pads via mouse — each plays its slice with correct per-pad settings
4. Plug in Launchkey 25 — device name appears, green dot, drum pads 36-51 trigger pads, keys 60-75 trigger pads, CC knobs 21-28 control selected pad params
5. Keyboard shortcuts Z-M and A-K trigger the correct pads
6. Load a WAV file — waveform updates, sample name displays, hit points detect
7. Enable hit points, click Slice → Pads — pads remap to transient boundaries
8. Switch to granular mode — grain controls appear, playback uses granular engine
9. Change reverb preset — reverb character changes, IR preview waveform updates
10. Export a pad — WAV file downloads, sounds identical to live playback
11. Export all pads — ZIP downloads with individual WAV files
12. Record a sequence — plays back correctly, exports correctly
13. All knobs respond to mouse drag and touch drag
14. Right-click a pad — context menu appears with export/copy/paste/reset options
15. Switch between all tabs (Play, Edit, Send FX, Perform FX, Export) — each shows correct panel
16. `npm run build` produces a production bundle with no errors
