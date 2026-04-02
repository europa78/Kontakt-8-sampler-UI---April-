# Session 7 — Preset/Kit Save & Load System

Read CLAUDE.md and the full codebase. This session focuses on one thing: persistent storage so the sampler remembers everything between sessions. Right now every pad assignment, every knob position, every slice point, every reverb preset vanishes the moment you close the browser. That makes this a toy. Preset/kit persistence makes it a production tool.

We're building two layers of storage: IndexedDB for automatic local persistence (your work survives closing the tab), and JSON file export/import for sharing kits, backing up, and moving between machines.

## What gets saved

### Kit (full sampler state)

A kit captures the ENTIRE sampler state — everything needed to reconstruct the exact session:

```js
{
  // Kit metadata
  meta: {
    name: "Lockdown Kit v2",
    author: "",
    created: "2026-04-01T12:00:00Z",
    modified: "2026-04-01T14:30:00Z",
    version: "1.0.0",            // Schema version for forward compatibility
    leapVersion: "1.0.0",        // App version that created this kit
    description: "",
    tags: [],                     // ["drums", "hip-hop", "128bpm"]
  },
  
  // Sample data
  sample: {
    name: "Drums[128] GalaxyFold",
    fileName: "galaxyfold_drums.wav",
    sampleRate: 44100,
    duration: 7.2,
    channels: 1,
    bpmDetected: 128.0,
    // The actual audio data — base64-encoded WAV
    // This makes the kit file self-contained and portable
    audioData: "UklGRi4AAABXQVZFZm10IBAAAA...",
  },
  
  // Engine settings
  engine: {
    type: "melody",              // "melody" | "shift" | "env order" | "granular"
    hq: false,
    formants: false,
    reverse: false,
    bpm: 128.0,
    sync: true,
    speed: 1.0,
    tonality: "None",
    tune: 0.0,
    loop: true,
    triggerStyle: "Latch",
    choke: "Off",
  },
  
  // Granular params (if applicable)
  granular: {
    grainSize: 0.06,
    grainOverlap: 0.5,
    pitchShift: 0,
    timeStretch: 1.0,
  },
  
  // All 16 pads with per-pad signal chains
  pads: [
    {
      id: 1,
      assigned: true,
      sliceStart: 0.0,           // Normalized 0-1
      sliceEnd: 0.0625,
      adsr: { attack: 0.005, decay: 0.1, sustain: 0.7, release: 0.2 },
      filter: { type: "lowpass", freq: 8000, q: 1 },
      drive: { amount: 0, curve: "soft" },
      delaySend: 0,
      reverbSend: 0.3,
      volume: 1.0,
      pan: 0,
    },
    // ... pads 2-16
  ],
  
  // Markers
  markers: {
    S: 0.0,
    L: 0.5,
    E: 1.0,
  },
  
  // View state
  view: {
    viewRange: { start: 0, end: 1 },
    gridOn: true,
    gridWidth: "1/16",
    snapMode: "Grid",
    showHitPoints: false,
    hitSensitivity: 50,
  },
  
  // Delay bus settings
  delay: {
    time: 0.3,
    feedback: 0.3,
    mix: 0.3,
  },
  
  // Reverb bus settings
  reverb: {
    preset: "hall",
    decay: 2.0,
    preDelay: 0.015,
    damping: 6000,
    brightness: 200,
    wet: 0.35,
    dry: 1.0,
    size: 0.5,
    // If using a loaded IR file, store it too
    customIR: null,              // base64-encoded WAV of the IR, or null if using preset
    customIRName: null,
  },
  
  // Pad grid settings
  padGrid: {
    mode: "group",
    startKey: "C3",
    tonalityLock: "G min",
    quantize: "Off",
    selectedPad: 0,
  },
  
  // Global
  global: {
    masterVolume: 0.8,
    voices: 8,
    mono: true,
  },
}
```

### Pad Preset (single pad)

A pad preset captures just one pad's settings for reuse across kits:

```js
{
  meta: {
    name: "Punchy Kick",
    created: "2026-04-01T12:00:00Z",
    version: "1.0.0",
    tags: ["kick", "punchy", "808"],
  },
  
  // Pad config (same structure as one entry in kits pads array)
  pad: {
    sliceStart: 0.0,
    sliceEnd: 0.0625,
    adsr: { attack: 0.005, decay: 0.1, sustain: 0.7, release: 0.2 },
    filter: { type: "lowpass", freq: 8000, q: 1 },
    drive: { amount: 0, curve: "soft" },
    delaySend: 0,
    reverbSend: 0.3,
    volume: 1.0,
    pan: 0,
  },
  
  // Optional: include the slice audio data so the pad preset is self-contained
  // This is a base64-encoded WAV of JUST the slice, not the entire sample
  sliceAudioData: null,          // null = uses whatever sample is loaded in the kit
}
```

## What to build

### KitManager module

Create a new module at `src/state/KitManager.js` (no React dependency — plain JS class that the React layer wraps via hooks):

```js
class KitManager {
  constructor() {
    this.db = null;              // IndexedDB reference
    this.currentKit = null;      // Currently loaded kit name
    this.isDirty = false;        // Unsaved changes flag
    this.autoSaveInterval = null;
  }
  
  // ── IndexedDB ──
  async initDB()
  
  // ── Kit operations ──
  async saveKit(name, state) → void
  async loadKit(name) → kitData
  async deleteKit(name) → void
  async listKits() → [{ name, modified, description, tags }]
  async duplicateKit(sourceName, newName) → void
  async renameKit(oldName, newName) → void
  
  // ── Pad preset operations ──
  async savePadPreset(name, padConfig) → void
  async loadPadPreset(name) → padConfig
  async deletePadPreset(name) → void
  async listPadPresets() → [{ name, created, tags }]
  
  // ── JSON file export/import ──
  exportKitToJSON(kitData) → Blob        // .leapkit file
  async importKitFromJSON(file) → kitData
  exportPadPresetToJSON(presetData) → Blob   // .leappad file
  async importPadPresetFromJSON(file) → padConfig
  
  // ── Auto-save ──
  startAutoSave(getStateFn, intervalMs)
  stopAutoSave()
  
  // ── State serialization ──
  serializeState(fullAppState) → kitData   // React state → kit JSON
  deserializeState(kitData) → fullAppState // kit JSON → React state
  
  // ── Audio data encoding ──
  async encodeAudioToBase64(audioBuffer) → string
  async decodeBase64ToAudio(base64, audioCtx) → AudioBuffer
}

export const kitManager = new KitManager();
```

### IndexedDB schema

Use IndexedDB (not localStorage — localStorage has a 5-10MB limit which is too small for embedded audio data). The database structure:

```js
// Database: "leap-sampler"
// Version: 1

// Object store: "kits"
// keyPath: "meta.name"
// Indexes: "modified" (meta.modified), "tags" (meta.tags, multiEntry)

// Object store: "padPresets"  
// keyPath: "meta.name"
// Indexes: "created" (meta.created), "tags" (meta.tags, multiEntry)

// Object store: "autosave"
// keyPath: "slot"  — always "current"
// Stores the last auto-saved state
```

Implementation:

```js
async initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("leap-sampler", 1);
    
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      
      if (!db.objectStoreNames.contains("kits")) {
        const kitStore = db.createObjectStore("kits", { keyPath: "meta.name" });
        kitStore.createIndex("modified", "meta.modified", { unique: false });
        kitStore.createIndex("tags", "meta.tags", { unique: false, multiEntry: true });
      }
      
      if (!db.objectStoreNames.contains("padPresets")) {
        const padStore = db.createObjectStore("padPresets", { keyPath: "meta.name" });
        padStore.createIndex("created", "meta.created", { unique: false });
        padStore.createIndex("tags", "meta.tags", { unique: false, multiEntry: true });
      }
      
      if (!db.objectStoreNames.contains("autosave")) {
        db.createObjectStore("autosave", { keyPath: "slot" });
      }
    };
    
    request.onsuccess = (e) => {
      this.db = e.target.result;
      resolve(this.db);
    };
    
    request.onerror = (e) => reject(e.target.error);
  });
}
```

### Audio data embedding

The kit file must be self-contained — if someone sends you a .leapkit file, it should load with all samples included, no missing file errors. This means encoding the AudioBuffer as base64 WAV data inside the JSON.

Use the WAV encoder from Session 5 to encode the buffer, then convert to base64:

```js
async encodeAudioToBase64(audioBuffer) {
  // Reuse WAVEncoder from Session 5
  const wavBlob = WAVEncoder.encode(audioBuffer, 16);  // 16-bit to save space
  const arrayBuffer = await wavBlob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async decodeBase64ToAudio(base64, audioCtx) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return await audioCtx.decodeAudioData(bytes.buffer);
}
```

For IndexedDB storage (local), store the full 24-bit audio to preserve quality. For JSON file export, use 16-bit to keep file sizes manageable. A 7-second stereo sample at 44.1kHz/16-bit is about 1.2MB as base64 — large but acceptable for a self-contained kit file.

### File format

Kit files use the extension `.leapkit` and pad presets use `.leappad`. Both are just JSON files with these extensions. The file picker filters should reflect this:

```js
// Kit save
const blob = new Blob([JSON.stringify(kitData, null, 2)], { type: 'application/json' });
downloadFile(blob, `${kitName}.leapkit`);

// Kit load
fileInput.accept = '.leapkit,.json';
```

### Schema versioning

Every kit file includes a `version` field in meta. When loading a kit, check the version and run migrations if needed:

```js
function migrateKit(kitData) {
  const version = kitData.meta?.version || "0.0.0";
  
  // v0 → v1: added per-pad drive stage
  if (semverLt(version, "1.0.0")) {
    kitData.pads.forEach(p => {
      if (!p.drive) p.drive = { amount: 0, curve: "soft" };
    });
  }
  
  // v1.0 → v1.1: added granular params
  if (semverLt(version, "1.1.0")) {
    if (!kitData.granular) {
      kitData.granular = { grainSize: 0.06, grainOverlap: 0.5, pitchShift: 0, timeStretch: 1.0 };
    }
  }
  
  // Always update version to current
  kitData.meta.version = CURRENT_SCHEMA_VERSION;
  return kitData;
}
```

This ensures old kit files always load in newer versions of the app without data loss.

### Validation

When loading a kit (from IndexedDB or JSON file), validate the data before applying it:

```js
function validateKit(kitData) {
  const errors = [];
  
  if (!kitData.meta?.name) errors.push("Missing kit name");
  if (!kitData.pads || kitData.pads.length !== 16) errors.push("Invalid pad count");
  
  // Validate each pad's params are within range
  kitData.pads?.forEach((pad, i) => {
    if (pad.adsr) {
      if (pad.adsr.attack < 0 || pad.adsr.attack > 10) errors.push(`Pad ${i+1}: attack out of range`);
      if (pad.adsr.sustain < 0 || pad.adsr.sustain > 1) errors.push(`Pad ${i+1}: sustain out of range`);
    }
    if (pad.filter) {
      if (pad.filter.freq < 20 || pad.filter.freq > 20000) errors.push(`Pad ${i+1}: filter freq out of range`);
    }
    if (pad.sliceStart < 0 || pad.sliceStart > 1) errors.push(`Pad ${i+1}: sliceStart out of range`);
    if (pad.sliceEnd < 0 || pad.sliceEnd > 1) errors.push(`Pad ${i+1}: sliceEnd out of range`);
  });
  
  // Clamp out-of-range values instead of rejecting — be permissive on load
  if (errors.length > 0) {
    console.warn("Kit validation warnings:", errors);
    clampValues(kitData);
  }
  
  return { valid: errors.length === 0, errors, data: kitData };
}
```

Be permissive: clamp out-of-range values to valid ranges rather than rejecting the kit entirely. A kit from an older version with slightly different ranges should still load.

## Auto-save system

### How it works

Every 30 seconds, if `isDirty` is true, automatically serialize the current state and write it to the "autosave" object store in IndexedDB. Also auto-save on `beforeunload` (tab close/refresh).

```js
startAutoSave(getStateFn, intervalMs = 30000) {
  this.autoSaveInterval = setInterval(async () => {
    if (this.isDirty) {
      const state = getStateFn();
      const kitData = this.serializeState(state);
      kitData.meta.name = "__autosave__";
      await this.saveToStore("autosave", { slot: "current", data: kitData, timestamp: Date.now() });
      this.isDirty = false;
    }
  }, intervalMs);
  
  // Also save on tab close
  window.addEventListener("beforeunload", () => {
    if (this.isDirty) {
      const state = getStateFn();
      const kitData = this.serializeState(state);
      // Use synchronous fallback for beforeunload — IndexedDB transaction
      // may not complete, so also store a minimal state snapshot in sessionStorage
      try {
        sessionStorage.setItem("leap-sampler-emergency", JSON.stringify({
          kitName: kitData.meta.name,
          timestamp: Date.now()
        }));
      } catch {}
    }
  });
}
```

### Recovery on launch

When the app initializes, check for an autosave:

```js
async checkAutoSave() {
  const autosave = await this.loadFromStore("autosave", "current");
  if (autosave) {
    return {
      exists: true,
      timestamp: autosave.timestamp,
      age: Date.now() - autosave.timestamp,   // How old is the autosave in ms
      data: autosave.data,
    };
  }
  return { exists: false };
}
```

Show a recovery prompt on startup if an autosave exists:

```
┌──────────────────────────────────────────────────┐
│  Unsaved session found                           │
│  "Lockdown Kit v2" — saved 3 minutes ago         │
│                                                  │
│  [Restore Session]     [Start Fresh]             │
└──────────────────────────────────────────────────┘
```

## UI additions

### Kit management bar

Add a persistent bar below the header that shows the current kit status:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  KIT: Lockdown Kit v2 ●                    [Save] [Save As] [Load] [New] │
└──────────────────────────────────────────────────────────────────────────┘
```

- The dot `●` next to the kit name indicates unsaved changes (cyan when clean, amber when dirty)
- **Save**: Saves to IndexedDB under the current name. If no name yet, prompts for one.
- **Save As**: Prompts for a new name, saves as a new kit.
- **Load**: Opens the kit browser modal.
- **New**: Resets everything to defaults. If there are unsaved changes, prompts "Save changes to [kit name]?" with [Save] [Don't Save] [Cancel].

### Kit browser modal

When the user clicks Load, show a full-screen modal with all saved kits:

```
┌─────────────────────────────────────────────────────────────────┐
│  LOAD KIT                                              [✕]     │
│                                                                 │
│  SEARCH  [_________________________________]                    │
│                                                                 │
│  LOCAL KITS (IndexedDB)                                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Lockdown Kit v2          Modified: 2 hours ago         │   │
│  │  Tags: drums, hip-hop     128 BPM                       │   │
│  │  [Load]  [Duplicate]  [Export .leapkit]  [Delete]       │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │  80s New Wave Kit         Modified: yesterday           │   │
│  │  Tags: synth, 80s         128 BPM                       │   │
│  │  [Load]  [Duplicate]  [Export .leapkit]  [Delete]       │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │  Boom Bap Chops           Modified: 3 days ago          │   │
│  │  Tags: boombap, chops     92 BPM                        │   │
│  │  [Load]  [Duplicate]  [Export .leapkit]  [Delete]       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  IMPORT FROM FILE                                               │
│  [Import .leapkit File]                                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Features:
- Search filters by name, tags, and description
- Sort by name or modified date
- Delete confirmation: "Delete 'Lockdown Kit v2'? This cannot be undone." [Delete] [Cancel]
- Duplicate creates a copy with " (copy)" appended to the name
- Export downloads the kit as a .leapkit JSON file
- Import reads a .leapkit file and adds it to IndexedDB

### Pad preset browser

Accessible from the pad context menu (right-click a pad) or from a small dropdown in the signal chain panel:

```
┌─────────────────────────────────────┐
│  PAD 3 PRESET                       │
│                                     │
│  [Save Current as Preset]           │
│  [Load Preset ▼]                    │
│  ┌─────────────────────────────┐   │
│  │  Punchy Kick                │   │
│  │  Filtered Snare             │   │
│  │  Lo-Fi Hat                  │   │
│  │  Sub Bass                   │   │
│  │  ─────────────────────────  │   │
│  │  [Import .leappad]          │   │
│  └─────────────────────────────┘   │
│                                     │
│  [Export Pad as .leappad]           │
└─────────────────────────────────────┘
```

Loading a pad preset applies the preset's ADSR, filter, drive, sends, volume, and pan to the selected pad. It does NOT change the slice assignment — the pad keeps its current slice but gets the preset's sound.

If the pad preset includes `sliceAudioData`, offer the option: "This preset includes sample data. Replace current slice? [Yes] [No, keep current slice]"

### Save dialog

When saving a kit for the first time or using Save As:

```
┌─────────────────────────────────────────────┐
│  SAVE KIT                                   │
│                                             │
│  Name:        [Lockdown Kit v2_________]    │
│  Description: [Hard-hitting drum kit___]    │
│  Tags:        [drums, hip-hop, 128bpm__]    │
│                                             │
│  ☑ Include sample audio data                │
│    (Makes kit file self-contained but       │
│     increases file size by ~1-5 MB)         │
│                                             │
│             [Cancel]    [Save]              │
└─────────────────────────────────────────────┘
```

The "Include sample audio data" checkbox controls whether the AudioBuffer gets base64-encoded into the kit. When checked, the kit is portable — send it to anyone and it works. When unchecked, the kit only stores the sample filename and metadata — lighter file but requires the same sample to be loaded manually.

### Dirty state tracking

Track `isDirty` by detecting any state change after the last save. Set dirty on:
- Any pad parameter change (ADSR, filter, drive, sends, volume, pan)
- Slice point changes
- Marker changes (S, L, E)
- Engine parameter changes
- Reverb/delay setting changes
- Loading a new sample
- Slice to pads
- Any knob turn or toggle click that modifies a persistent value

Clear dirty on:
- Successful save
- Successful auto-save
- Loading a kit (freshly loaded = clean)

Display the dirty indicator next to the kit name — amber dot when dirty, cyan dot when clean. Also update the browser tab title: "● Lockdown Kit v2 — LEAP Sampler" when dirty, "Lockdown Kit v2 — LEAP Sampler" when clean.

### Unsaved changes guard

Intercept navigation away from the page when dirty:

```js
useEffect(() => {
  const handler = (e) => {
    if (isDirty) {
      e.preventDefault();
      e.returnValue = "You have unsaved changes. Are you sure you want to leave?";
    }
  };
  window.addEventListener("beforeunload", handler);
  return () => window.removeEventListener("beforeunload", handler);
}, [isDirty]);
```

Also guard the New and Load actions — prompt to save before discarding current state.

## React integration

### useKitManager hook

Create `src/state/useKitManager.js`:

```js
export function useKitManager() {
  const [kitName, setKitName] = useState("Untitled Kit");
  const [isDirty, setIsDirty] = useState(false);
  const [savedKits, setSavedKits] = useState([]);
  const [padPresets, setPadPresets] = useState([]);
  const [showBrowser, setShowBrowser] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState(null);
  const [recoveryPrompt, setRecoveryPrompt] = useState(null);
  
  // Initialize DB and check for autosave on mount
  useEffect(() => {
    (async () => {
      await kitManager.initDB();
      const autosave = await kitManager.checkAutoSave();
      if (autosave.exists && autosave.age < 24 * 60 * 60 * 1000) {
        setRecoveryPrompt(autosave);
      }
      setSavedKits(await kitManager.listKits());
      setPadPresets(await kitManager.listPadPresets());
    })();
  }, []);
  
  // Mark dirty on any state change
  // (called by SamplerContext whenever relevant state updates)
  const markDirty = useCallback(() => setIsDirty(true), []);
  
  const saveKit = useCallback(async (name, state, includeAudio) => {
    const kitData = kitManager.serializeState(state);
    kitData.meta.name = name;
    kitData.meta.modified = new Date().toISOString();
    if (includeAudio && state.buffer) {
      kitData.sample.audioData = await kitManager.encodeAudioToBase64(state.buffer);
    }
    await kitManager.saveKit(name, kitData);
    setKitName(name);
    setIsDirty(false);
    setSavedKits(await kitManager.listKits());
  }, []);
  
  const loadKit = useCallback(async (name) => {
    const kitData = await kitManager.loadKit(name);
    const migrated = migrateKit(kitData);
    const { valid, errors, data } = validateKit(migrated);
    // Decode audio buffer if embedded
    let buffer = null;
    if (data.sample?.audioData) {
      buffer = await kitManager.decodeBase64ToAudio(data.sample.audioData, audioEngine.ctx);
    }
    setKitName(data.meta.name);
    setIsDirty(false);
    return { ...kitManager.deserializeState(data), buffer };
  }, []);
  
  // ... export, import, pad preset operations
  
  return {
    kitName, isDirty, savedKits, padPresets,
    showBrowser, setShowBrowser,
    showSaveDialog, setShowSaveDialog,
    recoveryPrompt, setRecoveryPrompt,
    markDirty, saveKit, loadKit,
    exportKit, importKit,
    savePadPreset, loadPadPreset,
  };
}
```

### Wiring into SamplerContext

The `markDirty` function from useKitManager should be called in SamplerContext whenever any saveable state changes. Wrap the existing state setters:

```js
// In SamplerContext.jsx
const { markDirty, ... } = useKitManager();

// Wrap state updates to track dirty
const setEngineTracked = useCallback((updater) => {
  setEngine(updater);
  markDirty();
}, [markDirty]);

// Same for setPads dispatch, setFilter, setAdsr, etc.
```

Do NOT make every single useState call trigger markDirty — only the ones that represent persistent kit state. Transient UI state like selectedPad, activeTab, midiLearn mode, and view zoom should NOT mark dirty.

## Factory presets

Ship with 3 built-in factory presets that are always available even if IndexedDB is empty:

```js
const FACTORY_PRESETS = [
  {
    meta: { name: "Default Kit", tags: ["factory"], description: "Clean starting point with equal 16-slice mapping" },
    // Default state with 16 equal slices, neutral ADSR/filter, hall reverb
  },
  {
    meta: { name: "Drum Break Kit", tags: ["factory", "drums"], description: "Optimized for chopping drum breaks" },
    // Short attack/release, snappy filter, room reverb, 1/16 grid
  },
  {
    meta: { name: "Ambient Pad Kit", tags: ["factory", "ambient"], description: "Long sustain, cathedral reverb, granular mode" },
    // Long attack/release, open filter, cathedral reverb, granular engine
  },
];
```

Factory presets show in the kit browser with a "FACTORY" badge and cannot be deleted or overwritten. They can be duplicated.

## Constraints

- Do NOT touch the audio engine, MIDI mapping, DSP code, or any audio routing
- Do NOT touch the waveform rendering or canvas code
- Do NOT touch the WAV export system from Session 5
- Do NOT touch the granular engine or convolver reverb internals
- KitManager.js must have ZERO React imports — it's a plain JS class in `src/state/`
- Follow the dependency rules from Session 6: KitManager sits in `state/`, imports from `audio/` (for WAVEncoder) and `utils/`, but NEVER from `components/`
- IndexedDB operations must be wrapped in try/catch with meaningful error messages — IndexedDB can fail in private browsing mode, when storage is full, or when the database is corrupted
- The base64 audio encoding for JSON export must use 16-bit WAV to keep file sizes reasonable — a 10-second stereo sample at 16-bit should produce a kit file under 5MB
- For IndexedDB storage (local persistence), store the audio at original quality (24-bit or whatever the source was) since size is less constrained
- All modal dialogs must be closable with Escape key and by clicking outside the modal
- The kit browser search must be instant (client-side filtering, no async) since all kit metadata is already loaded
- Auto-save must NOT encode the full audio buffer on every save cycle — cache the base64 audio and only re-encode when the sample changes
- The dirty state indicator must be visually obvious but not annoying — a color change on the kit name dot is sufficient
- Kit names must be unique — attempting to save with an existing name should prompt "Overwrite existing kit [name]?" [Overwrite] [Cancel]
- Handle the edge case where a kit file is loaded but has no embedded audio — show a clear message: "This kit requires sample: galaxyfold_drums.wav. Load the sample file to continue." with a file picker button
- Maintain the cyan-on-dark LEAP aesthetic. Modal overlays should use a dark semi-transparent backdrop (#0a0e14cc). Modal panels use the elevated background (#0d1520) with the standard border color.

## Testing

After implementation, verify:

1. Click Save — enter a kit name — kit saves to IndexedDB. Refresh the page. Click Load — the kit appears in the browser. Load it — all pad settings, engine params, reverb preset, markers, and the sample itself restore exactly.
2. Make a change (turn a knob). The dirty indicator turns amber. Click Save — indicator turns cyan. Refresh — auto-save recovery prompt appears. Click Restore — state matches exactly what was saved.
3. Close the tab with unsaved changes — browser shows "unsaved changes" warning.
4. Export a kit as .leapkit file. Open the file in a text editor — it's readable JSON with base64 audio data. Import the file on a different machine (or after clearing IndexedDB) — kit loads with sample data intact.
5. Save a pad preset from pad 3. Select pad 7. Load the preset onto pad 7 — pad 7 now has pad 3's ADSR, filter, and FX settings but keeps its own slice assignment.
6. Export a pad preset as .leappad. Import it — preset appears in the pad preset list.
7. Create 5 kits with different names and tags. Open the kit browser. Type a tag into the search — list filters correctly. Sort by date — most recent appears first.
8. Load a factory preset. Try to delete it — should be prevented. Duplicate it — copy appears and IS deletable.
9. Load a kit that was saved WITHOUT embedded audio — the app should display a message asking you to load the sample file manually. After loading the correct sample, all slice points should align correctly.
10. Test the auto-save: make changes, wait 30+ seconds, force-kill the tab (don't close normally — kill the process). Reopen — recovery prompt should appear with state from the auto-save.
11. Save a kit, then save another kit with the same name — should prompt for overwrite confirmation.
12. Open the app in a private/incognito browser window — IndexedDB may be unavailable. The app should still work but show a subtle warning that local storage is not available. JSON export/import should still work.
13. Load a .leapkit file that was created by a hypothetical future version (with extra unknown fields) — the app should ignore unknown fields and load what it can without crashing.
