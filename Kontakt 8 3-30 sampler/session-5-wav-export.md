# Session 5 — WAV Export (Offline Rendering)

Read CLAUDE.md and the full codebase. This session focuses on one thing: offline rendering and WAV file export. The user needs to be able to bounce any pad, any slice, any loop, or a full performance sequence to a downloadable WAV file. This uses the Web Audio API's OfflineAudioContext to render audio faster-than-realtime without playing through speakers.

## How offline rendering works

The Web Audio API provides `OfflineAudioContext` — a special audio context that renders to a buffer instead of the speakers. You build the exact same node graph (sources, filters, gains, effects) but connect them to an OfflineAudioContext instead of the regular AudioContext. Then call `startRendering()` which returns a Promise that resolves with the rendered AudioBuffer. This runs as fast as the CPU allows — a 30-second render might complete in 1-2 seconds.

The rendered AudioBuffer then gets encoded to WAV format (raw PCM) and offered as a file download.

## What to build

### OfflineRenderEngine

Create a new module on AudioCtx that handles all offline rendering:

```js
AudioCtx.offlineRenderer = {
  // Render a single pad's slice with its full signal chain
  async renderPad(padIndex, options) → AudioBuffer,
  
  // Render the full sample between two markers with global FX
  async renderRange(startNorm, endNorm, options) → AudioBuffer,
  
  // Render a sequence of pad triggers (pattern/performance)
  async renderSequence(events, options) → AudioBuffer,
  
  // Encode AudioBuffer to WAV Blob
  encodeWAV(audioBuffer, bitDepth) → Blob,
  
  // Trigger download
  downloadWAV(blob, filename),
  
  // State
  isRendering: false,
  progress: 0,  // 0-1
}
```

### renderPad(padIndex, options)

Renders a single pad's assigned slice through its complete per-pad signal chain:

```
BufferSource (or GranularEngine if granular mode) 
  → Pad Filter → Pad Drive → Pad ADSR Gain 
  → Pad Delay Send → shared Delay Bus clone
  → Pad Reverb Send → shared Reverb Bus clone
  → Offline destination
```

Options:
```js
{
  duration: null,        // Duration in seconds. null = auto (slice length + release tail + reverb tail)
  includeEffects: true,  // Include delay and reverb tails
  tailPadding: 2.0,      // Extra seconds after note-off for FX tails to decay
  velocity: 1.0,         // Trigger velocity
  normalize: false,      // Peak normalize to -0.1dB after render
  bitDepth: 24,          // 16 or 24 or 32
  sampleRate: 44100,     // Output sample rate
}
```

The auto-duration calculation should be:
```js
const sliceDuration = (pad.sliceEnd - pad.sliceStart) * buffer.duration;
const releaseTail = pad.adsr.release;
const fxTail = includeEffects ? Math.max(delayTailTime, reverbDecayTime) : 0;
const totalDuration = sliceDuration + releaseTail + fxTail + tailPadding;
```

Implementation steps:
1. Create an OfflineAudioContext with the calculated duration and desired sampleRate
2. Rebuild the pad's signal chain on the offline context — create new BiquadFilter, GainNodes, etc. with the same parameter values as the pad's current settings
3. If includeEffects is true, clone the delay bus and reverb bus onto the offline context (create a new ConvolverNode with the same IR buffer, same delay settings, same feedback)
4. Create a BufferSource (or GranularEngine in granular mode) and connect it through the chain
5. Schedule note-on at time 0, note-off at sliceDuration (trigger ADSR release)
6. Call offlineCtx.startRendering()
7. Return the rendered AudioBuffer

### renderRange(startNorm, endNorm, options)

Renders a section of the raw sample between two normalized positions (typically the S and E markers). This is a simpler render — straight BufferSource playback with optional global FX:

```js
{
  includeEffects: true,
  applyEngine: true,     // Apply current engine settings (speed, reverse, pitch)
  normalize: false,
  bitDepth: 24,
  sampleRate: 44100,
}
```

When applyEngine is true, apply the current playbackRate, reverse, and (if granular mode) the granular timestretch settings.

### renderSequence(events, options)

Renders a sequence of timed pad triggers. This is for bouncing a performed pattern:

```js
const events = [
  { pad: 0, time: 0.0, velocity: 1.0, duration: 0.5 },
  { pad: 4, time: 0.0, velocity: 0.8, duration: 0.5 },   // simultaneous with pad 0
  { pad: 1, time: 0.5, velocity: 0.9, duration: 0.25 },
  { pad: 2, time: 1.0, velocity: 1.0, duration: 0.5 },
  // ...
];

const options = {
  includeEffects: true,
  tailPadding: 2.0,
  normalize: true,
  bitDepth: 24,
  sampleRate: 44100,
};
```

The total render duration = last event time + last event duration + release + FX tails + padding.

Schedule ALL events onto the offline context before calling startRendering(). Each event creates its own BufferSource → pad signal chain, all summing into the offline destination. This correctly captures polyphonic playback with overlapping voices.

### WAV Encoder

Implement a WAV file encoder that converts an AudioBuffer to a downloadable Blob. Support 16-bit, 24-bit, and 32-bit float PCM:

```js
encodeWAV(audioBuffer, bitDepth = 24) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  
  // WAV file structure:
  // 1. RIFF header (12 bytes)
  // 2. fmt chunk (24 bytes for PCM, 26 for float)
  // 3. data chunk (header 8 bytes + sample data)
  
  const bytesPerSample = bitDepth / 8;
  const dataSize = length * numChannels * bytesPerSample;
  const headerSize = 44; // standard WAV header
  const totalSize = headerSize + dataSize;
  
  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);
  
  // Write RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, 'WAVE');
  
  // Write fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);                              // chunk size
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true);        // format: 1=PCM, 3=float
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  
  // Write data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  
  // Interleave channels and write sample data
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = audioBuffer.getChannelData(ch)[i];
      if (bitDepth === 16) {
        const clamped = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, clamped * 0x7FFF, true);
      } else if (bitDepth === 24) {
        const clamped = Math.max(-1, Math.min(1, sample));
        const intVal = clamped * 0x7FFFFF;
        view.setUint8(offset, intVal & 0xFF);
        view.setUint8(offset + 1, (intVal >> 8) & 0xFF);
        view.setUint8(offset + 2, (intVal >> 16) & 0xFF);
      } else if (bitDepth === 32) {
        view.setFloat32(offset, sample, true);
      }
      offset += bytesPerSample;
    }
  }
  
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}
```

### Download trigger

```js
downloadWAV(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.wav') ? filename : filename + '.wav';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
```

### Filename generation

Auto-generate filenames based on context:

- Pad export: `{sampleName}_pad{N}_128bpm_24bit.wav`
- Range export: `{sampleName}_S-E_128bpm_24bit.wav`
- Sequence export: `{sampleName}_sequence_128bpm_24bit.wav`

## UI additions

### Export panel

Add an EXPORT section accessible via a new tab in the header tabs (alongside Play, Edit, Send FX, Perform FX):

```
[Play] [Edit] [Send FX] [Perform FX] [Export]
```

When the Export tab is active, show the export panel below the engine params:

```
EXPORT ──────────────────────────────────────────────────────────────────

MODE     [Selected Pad]  [All Pads]  [S→E Range]  [Sequence]

PAD      ● 3  (Pad 3 selected — click a pad to change)

FORMAT   ─────────────────────────────────────────
BIT DEPTH    [16-bit]  [24-bit]  [32-bit float]
SAMPLE RATE  [44100]   [48000]   [96000]
CHANNELS     [Mono]    [Stereo]

OPTIONS  ─────────────────────────────────────────
☑ Include FX (delay + reverb tails)
☑ Normalize to -0.1dB
Tail Padding  [==●===]  2.0s

         [▶ RENDER & DOWNLOAD]          [▶ RENDER ALL PADS]

PROGRESS ═══════════════════●═══════════════  67%  Rendering pad 3...
```

### Export mode descriptions

- **Selected Pad**: Exports the currently selected pad's slice with its full per-pad signal chain + FX. Single file download.
- **All Pads**: Batch exports all 16 pads (or only assigned pads) as individual WAV files. Downloads as a ZIP file or sequential downloads.
- **S→E Range**: Exports the raw sample between the S and E markers with current engine settings applied.
- **Sequence**: Records a sequence of pad triggers and exports the result. Show a simple record button — user hits Record, plays pads in real-time, hits Stop, then exports the captured performance.

### Pad export context menu

Add a right-click (or long-press on mobile) context menu to each pad in the pad grid:

```
┌─────────────────────┐
│ Export Pad 3         │
│ Export Pad 3 (Dry)   │
│ Copy Pad Settings    │
│ Paste Pad Settings   │
│ Reset Pad            │
└─────────────────────┘
```

"Export Pad 3" uses the selected bit depth and includes FX. "Export Pad 3 (Dry)" exports without delay/reverb processing.

### Progress indicator

During rendering, show:
- A progress bar (OfflineAudioContext doesn't expose native progress, so estimate based on render duration vs elapsed wall-clock time)
- The current operation: "Rendering pad 3..." or "Encoding WAV..." or "Generating ZIP..."
- A cancel button that aborts the render if possible

### Render preview

After rendering but before downloading, play a quick preview of the rendered buffer through the regular AudioContext so the user can verify it sounds right before saving. Show a small play/stop button next to the download button:

```
[▶ Preview]  [⬇ Download]   "pad3_128bpm_24bit.wav"  (2.4 MB, 3.2s)
```

Display file size and duration after render completes.

## Sequence recording

### Record mode

When Sequence export mode is selected, show a transport bar:

```
[● REC]  [■ STOP]  [▶ PLAY]  [⬇ EXPORT]     00:00.000 / --:--
```

- **REC**: Arms recording. From this point, every pad trigger (MIDI, mouse, or keyboard) is captured as an event with timestamp and velocity.
- **STOP**: Stops recording. The captured events populate the events array.
- **PLAY**: Plays back the recorded sequence through the live audio context (for preview before export).
- **EXPORT**: Runs renderSequence() with the captured events and triggers download.

Capture events relative to the recording start time:

```js
const recordStartTime = AudioCtx.ctx.currentTime;

// On each pad trigger during recording:
recordedEvents.push({
  pad: padIndex,
  time: AudioCtx.ctx.currentTime - recordStartTime,
  velocity: velocity,
  duration: 0  // filled in on note-off
});

// On note-off, find the matching event and set duration:
const event = recordedEvents.findLast(e => e.pad === padIndex && e.duration === 0);
if (event) event.duration = AudioCtx.ctx.currentTime - recordStartTime - event.time;
```

### Quantize recorded sequence

After recording, offer optional quantization before export:

```
QUANTIZE  [Off]  [1/4]  [1/8]  [1/16]  [1/32]    BPM: 128.00
```

When quantize is enabled, snap all event start times to the nearest grid division based on BPM. This cleans up sloppy timing without re-recording.

## Batch export (All Pads)

When "All Pads" mode is selected and the user clicks RENDER ALL PADS:

1. Iterate through all 16 pads (skip unassigned pads)
2. Render each one sequentially (not in parallel — OfflineAudioContext is CPU-heavy)
3. Update progress: "Rendering pad 1 of 12..."
4. Collect all WAV blobs
5. If more than 1 pad: bundle into a ZIP file using a lightweight ZIP encoder (implement a minimal ZIP creator — the format is simple: local file headers + data + central directory + end record. No compression needed since WAV is already uncompressed — just use STORE method)
6. Download as `{sampleName}_all_pads_24bit.zip`

### Minimal ZIP encoder

Implement a bare-minimum ZIP file creator. WAV files are uncompressed audio, so using ZIP STORE (no compression, method=0) is the right call — it adds almost zero overhead and avoids needing a deflate implementation:

```js
function createZIP(files) {
  // files = [{ name: "pad1.wav", data: Uint8Array }, ...]
  
  // ZIP format:
  // For each file: Local File Header (30 + nameLen bytes) + file data
  // Central Directory: For each file: Central Dir Header (46 + nameLen bytes)
  // End of Central Directory Record (22 bytes)
  
  // Calculate total size, allocate ArrayBuffer, write headers + data
  // Return Blob
}
```

## Constraints

- Do NOT touch the MIDI mapping, note-to-pad logic, or CC assignments
- Do NOT modify the per-pad signal chain from Session 2 — replicate it faithfully on the OfflineAudioContext
- Do NOT touch the GranularEngine internals from Session 3 — but DO support rendering granular playback offline by instantiating a GranularEngine on the OfflineAudioContext
- Do NOT modify the reverb IR generation from Session 4 — reuse the same IR buffers for offline rendering
- Do NOT touch the waveform editor canvases or hit point detection
- Keep the ref-based stale closure prevention pattern
- The WAV encoder must handle both mono and stereo buffers correctly
- 24-bit encoding must use proper little-endian 3-byte signed integer packing — this is the most error-prone part of WAV encoding, test thoroughly
- The offline render must exactly match what the user hears through the speakers — same filter settings, same ADSR timing, same FX levels. No approximations.
- OfflineAudioContext.startRendering() returns a Promise — use async/await, do not block the UI thread
- Clean up all nodes created on the OfflineAudioContext after rendering completes — they won't be garbage collected automatically if references are held
- For the ZIP encoder, do NOT use any external libraries — implement the minimal STORE-only ZIP format inline. The spec is simple enough.
- File downloads must work on both desktop Chrome and mobile Chrome/Safari
- Maintain the cyan-on-dark LEAP aesthetic. The Export tab should use a distinct accent color for export-related UI elements: #ff8800 (amber/orange) for render buttons and progress bar to visually separate export actions from playback actions.

## Testing

After implementation, verify:

1. Select pad 1, click RENDER & DOWNLOAD — a WAV file should download. Open it in Reaper or any audio editor and verify it sounds identical to what you hear when triggering pad 1 live.
2. Export the same pad at 16-bit and 24-bit — the 24-bit file should be ~50% larger. Both should play correctly in any audio player.
3. Export with FX enabled vs disabled — the FX version should have audible reverb/delay tails, the dry version should cut off cleanly after the ADSR release.
4. Click RENDER ALL PADS — a ZIP file should download containing individual WAV files for each assigned pad. Extract and verify each file plays correctly.
5. Record a 4-bar sequence using the keyboard or MIDI controller. Play it back via the PLAY button — it should sound exactly like what you played. Export it — the WAV should match the playback.
6. Record a sloppy sequence, apply 1/16 quantize, play back — timing should snap to grid.
7. Export with normalize ON — the loudest peak in the file should be at approximately -0.1dB. Verify in Reaper by looking at the waveform peak level.
8. Export a pad in granular mode with pitch shift +7 and stretch 0.5x — the exported WAV should match what you hear live (pitched up a fifth, half speed).
9. Set a pad's reverb send to 100%, export with FX included — the reverb tail should be fully captured in the WAV, extending well past the dry signal.
10. Preview a render before downloading — the preview playback should sound identical to the eventual downloaded file.
11. Export a stereo sample — the WAV should be stereo (2 channels). Export a mono sample — the WAV should be mono (1 channel) unless the stereo option is selected, in which case it should be dual-mono.
