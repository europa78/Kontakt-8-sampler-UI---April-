import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ─── Audio Engine Context ───
const AudioCtx = {
  ctx: null,
  masterGain: null,
  delayBus: null,
  reverbBus: null,
  voices: new Map(),
  buffers: new Map(),
  midiAccess: null,
  workletReady: false,
  // Cache extracted channel data per AudioBuffer to avoid re-copying
  _bufferCache: new WeakMap(),
  init() {
    if (this.ctx) return this.ctx;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.8;
    this.masterGain.connect(this.ctx.destination);
    // Shared delay bus
    this._initDelayBus();
    // Shared reverb bus
    this._initReverbBus();
    return this.ctx;
  },
  _initDelayBus() {
    const ctx = this.ctx;
    this.delayBus = { input: ctx.createGain() };
    this.delayBus.input.gain.value = 1;
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.3;
    const fb = ctx.createGain();
    fb.gain.value = 0.3;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    this.delayBus.input.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    wet.connect(this.masterGain);
    this.delayBus.delay = delay;
    this.delayBus.feedback = fb;
    this.delayBus.wet = wet;
  },
  _initReverbBus() {
    const ctx = this.ctx;
    this.reverbBus = { input: ctx.createGain() };
    this.reverbBus.input.gain.value = 1;
    // Generate algorithmic impulse response
    const sr = ctx.sampleRate;
    const len = sr * 2; // 2 second IR
    const irBuf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = irBuf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        // Exponential decay with diffuse noise
        d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.6));
      }
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = irBuf;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    this.reverbBus.input.connect(convolver);
    convolver.connect(wet);
    wet.connect(this.masterGain);
    this.reverbBus.convolver = convolver;
    this.reverbBus.wet = wet;
  },
  async initWorklet() {
    if (this.workletReady) return;
    const ctx = this.init();
    await ctx.audioWorklet.addModule("sampler-worklet-processor.js");
    this.workletReady = true;
  },
  async initMidi(onMessage) {
    try {
      this.midiAccess = await navigator.requestMIDIAccess();
      for (const input of this.midiAccess.inputs.values()) {
        input.onmidimessage = onMessage;
      }
      return true;
    } catch { return false; }
  },
  // Extract and cache channel data from an AudioBuffer for worklet transfer
  _getChannelData(buffer) {
    let cached = this._bufferCache.get(buffer);
    if (cached) return cached;
    const channelData = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      channelData.push(new Float32Array(buffer.getChannelData(ch)));
    }
    this._bufferCache.set(buffer, channelData);
    return channelData;
  },
  generateDemoBuffer(type = "drums", bpm = 128) {
    const ctx = this.init();
    const sr = ctx.sampleRate;
    const dur = (60 / bpm) * 4;
    const len = sr * dur;
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const beatLen = sr * (60 / bpm);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const beatPos = (i % beatLen) / beatLen;
      const barPos = i / len;
      if (type === "drums") {
        // Kick on 1,3
        const kickBeat = Math.floor((i / beatLen)) % 4;
        if ((kickBeat === 0 || kickBeat === 2) && beatPos < 0.08) {
          const env = Math.exp(-beatPos * 40);
          d[i] += Math.sin(2 * Math.PI * (60 - beatPos * 400) * t) * env * 0.7;
        }
        // Snare on 2,4
        if ((kickBeat === 1 || kickBeat === 3) && beatPos < 0.1) {
          const env = Math.exp(-beatPos * 30);
          d[i] += (Math.random() * 2 - 1) * env * 0.4;
          d[i] += Math.sin(2 * Math.PI * 200 * t) * env * 0.3;
        }
        // Hi-hat
        if (beatPos < 0.02) {
          const env = Math.exp(-beatPos * 80);
          d[i] += (Math.random() * 2 - 1) * env * 0.15;
        }
        // Open hat on off-beats
        if (Math.floor((i / (beatLen / 2))) % 2 === 1 && (i % (beatLen / 2)) / (beatLen / 2) < 0.05) {
          const p = (i % (beatLen / 2)) / (beatLen / 2);
          const env = Math.exp(-p * 20);
          d[i] += (Math.random() * 2 - 1) * env * 0.1;
        }
      } else {
        // Synth pad
        const freq = 130.81 * Math.pow(2, Math.floor(barPos * 4) / 12);
        d[i] = Math.sin(2 * Math.PI * freq * t) * 0.3 +
               Math.sin(2 * Math.PI * freq * 2.01 * t) * 0.15 +
               Math.sin(2 * Math.PI * freq * 3.99 * t) * 0.05;
        d[i] *= 0.5 + Math.sin(2 * Math.PI * 0.5 * t) * 0.3;
      }
    }
    return buf;
  },
  playSlice(buffer, start, end, params = {}) {
    if (!this.ctx || !buffer || !this.workletReady) return null;
    const sr = this.ctx.sampleRate;
    const startSample = Math.floor(start * sr);
    const endSample = Math.floor(end * sr);
    const vel = params.velocity !== undefined ? params.velocity : 1;

    const procOpts = {
      velocity: vel,
      speed: params.speed || 1,
      reverse: params.reverse || false,
      loop: params.loop || false,
      attack: params.attack || 0.005,
      decay: params.decay || 0.1,
      sustain: params.sustain || 0.7,
      release: params.release || 0.2,
      filterType: params.filterType || "lowpass",
      filterFreq: params.filterFreq || 8000,
      filterQ: params.filterQ || 1,
      driveAmount: params.driveAmount || 0,
      driveCurve: params.driveCurve || "soft",
    };

    // Create AudioWorkletNode for this voice
    const node = new AudioWorkletNode(this.ctx, "sampler-worklet-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [buffer.numberOfChannels],
      processorOptions: procOpts,
    });

    // Send buffer data to the worklet
    const channelData = this._getChannelData(buffer);
    node.port.postMessage({ type: "loadBuffer", channelData });
    node.port.postMessage({ type: "play", startSample, endSample, params: procOpts });

    // Per-voice volume and pan
    const volGain = this.ctx.createGain();
    volGain.gain.value = params.volume !== undefined ? params.volume : 1;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = params.pan || 0;

    // Routing: worklet → volume → pan → dry master + send buses
    node.connect(volGain);
    volGain.connect(panner);
    panner.connect(this.masterGain);

    // Delay send
    const delaySendGain = this.ctx.createGain();
    delaySendGain.gain.value = params.delaySend || 0;
    panner.connect(delaySendGain);
    delaySendGain.connect(this.delayBus.input);

    // Reverb send
    const reverbSendGain = this.ctx.createGain();
    reverbSendGain.gain.value = params.reverbSend || 0;
    panner.connect(reverbSendGain);
    reverbSendGain.connect(this.reverbBus.input);

    // Cleanup when worklet finishes
    const allNodes = [node, volGain, panner, delaySendGain, reverbSendGain];
    node.port.onmessage = (e) => {
      if (e.data.type === "ended") {
        allNodes.forEach(n => { try { n.disconnect(); } catch {} });
      }
    };

    return {
      node,
      stop: () => {
        node.port.postMessage({ type: "release" });
        const r = params.release || 0.2;
        setTimeout(() => {
          allNodes.forEach(n => { try { n.disconnect(); } catch {} });
        }, (r + 0.05) * 1000);
      },
    };
  }
};

// ─── Default per-pad signal chain params ───
const DEFAULT_PAD_PARAMS = {
  adsr: { attack: 0.005, decay: 0.1, sustain: 0.7, release: 0.2 },
  filter: { type: "lowpass", freq: 8000, q: 1 },
  drive: { amount: 0, curve: "soft" },
  delaySend: 0,
  reverbSend: 0,
  volume: 1,
  pan: 0,
};

function createPad(i) {
  return {
    id: i + 1, active: false, assigned: true,
    sliceStart: i / 16, sliceEnd: (i + 1) / 16,
    ...JSON.parse(JSON.stringify(DEFAULT_PAD_PARAMS)),
  };
}

// ─── Waveform Drawing Utils ───
function drawWaveform(canvas, buffer, options = {}) {
  if (!canvas || !buffer) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const data = buffer.getChannelData(0);
  const { start = 0, end = 1, color = "#00e5ff", markers = [], hitPoints = [], slices = [], gridLines = [] } = options;
  const startSample = Math.floor(start * data.length);
  const endSample = Math.floor(end * data.length);
  const range = endSample - startSample;
  ctx.clearRect(0, 0, w, h);
  // Grid
  if (gridLines.length) {
    ctx.strokeStyle = "rgba(0,229,255,0.08)";
    ctx.lineWidth = 1;
    gridLines.forEach(g => {
      const x = ((g - startSample) / range) * w;
      if (x >= 0 && x <= w) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    });
  }
  // Slices bg
  slices.forEach((sl, i) => {
    const x1 = ((sl.start - startSample) / range) * w;
    const x2 = ((sl.end - startSample) / range) * w;
    ctx.fillStyle = i % 2 === 0 ? "rgba(0,229,255,0.03)" : "rgba(0,229,255,0.06)";
    ctx.fillRect(x1, 0, x2 - x1, h);
  });
  // Waveform
  ctx.beginPath();
  const step = Math.max(1, Math.floor(range / w));
  for (let i = 0; i < w; i++) {
    const idx = startSample + Math.floor((i / w) * range);
    let min = 1, max = -1;
    for (let j = 0; j < step; j++) {
      const s = idx + j < data.length ? data[idx + j] : 0;
      if (s < min) min = s;
      if (s > max) max = s;
    }
    const y1 = (1 - max) * h / 2;
    const y2 = (1 - min) * h / 2;
    if (i === 0) { ctx.moveTo(i, y1); } else { ctx.lineTo(i, y1); }
    ctx.lineTo(i, y2);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  // Center fill
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < w; i++) {
    const idx = startSample + Math.floor((i / w) * range);
    let max = -1;
    for (let j = 0; j < step; j++) { const s = idx + j < data.length ? data[idx + j] : 0; if (s > max) max = s; }
    const y = (1 - max) * h / 2;
    if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
  }
  for (let i = w - 1; i >= 0; i--) {
    const idx = startSample + Math.floor((i / w) * range);
    let min = 1;
    for (let j = 0; j < step; j++) { const s = idx + j < data.length ? data[idx + j] : 0; if (s < min) min = s; }
    const y = (1 - min) * h / 2;
    ctx.lineTo(i, y);
  }
  ctx.fill();
  ctx.globalAlpha = 1;
  // Hit points
  hitPoints.forEach(hp => {
    const x = ((hp - startSample) / range) * w;
    if (x >= 0 && x <= w) {
      ctx.strokeStyle = "rgba(255,200,0,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillStyle = "#ffc800";
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 4, 6); ctx.lineTo(x - 4, 6); ctx.fill();
    }
  });
  // S/L/E markers
  const markerColors = { S: "#00ff88", L: "#00e5ff", E: "#ff3366" };
  markers.forEach(m => {
    const x = ((m.pos - startSample) / range) * w;
    if (x < 0 || x > w) return;
    ctx.strokeStyle = markerColors[m.type] || "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.fillStyle = markerColors[m.type] || "#fff";
    ctx.font = "bold 10px monospace";
    const isTop = m.type === "S" || m.type === "L";
    ctx.fillText(m.type, x + 3, isTop ? 12 : h - 4);
    // Drag handle
    ctx.beginPath();
    if (isTop) { ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 8); }
    else { ctx.moveTo(x - 5, h); ctx.lineTo(x + 5, h); ctx.lineTo(x, h - 8); }
    ctx.fill();
  });
}

// ─── Main Component ───
export default function LEAPSampler() {
  const [audioReady, setAudioReady] = useState(false);
  const [buffer, setBuffer] = useState(null);
  const [sampleName, setSampleName] = useState("Drums[128] GalaxyFold");
  const [sampleInfo, setSampleInfo] = useState("00:07 / 128.00bpm / None");
  // Markers (normalized 0-1)
  const [markers, setMarkers] = useState({ S: 0, L: 0.5, E: 1 });
  const [viewRange, setViewRange] = useState({ start: 0, end: 1 });
  // Engine params
  const [engine, setEngine] = useState({
    type: "melody", hq: false, formants: false, reverse: false,
    bpm: 128, sync: true, speed: 1, tonality: "None", tune: 0,
    loop: true, triggerStyle: "Latch", choke: "Off"
  });
  // Pad state (each pad has its own signal chain params)
  const [pads, setPads] = useState(Array.from({ length: 16 }, (_, i) => createPad(i)));
  const [selectedPad, setSelectedPad] = useState(0);
  const [padClipboard, setPadClipboard] = useState(null);
  const [padMode, setPadMode] = useState("group");
  const [startKey, setStartKey] = useState("C3");
  const [tonalityLock, setTonalityLock] = useState("G min");
  const [quantize, setQuantize] = useState("Off");
  // Global shared bus params
  const [lfo1, setLfo1] = useState({ rate: 1, depth: 0, shape: "sine", target: "filter" });
  const [delayBus, setDelayBus] = useState({ time: 0.3, feedback: 0.3 });
  const [reverbBus, setReverbBus] = useState({ size: 0.5, mix: 0.5 });
  // Hit points
  const [hitPoints, setHitPoints] = useState([]);
  const [hitSensitivity, setHitSensitivity] = useState(50);
  const [showHitPoints, setShowHitPoints] = useState(false);
  // Grid
  const [gridOn, setGridOn] = useState(true);
  const [gridWidth, setGridWidth] = useState("1/16");
  const [snapMode, setSnapMode] = useState("Grid");
  // MIDI
  const [midiConnected, setMidiConnected] = useState(false);
  const [midiDeviceName, setMidiDeviceName] = useState("");
  const [midiLearn, setMidiLearn] = useState(false);
  const [midiLog, setMidiLog] = useState([]);
  const [activeKeys, setActiveKeys] = useState(new Set());
  const [pitchBend, setPitchBend] = useState(0);
  const [modWheel, setModWheel] = useState(0);
  // UI state
  const [activeTab, setActiveTab] = useState("edit");
  const [voices, setVoices] = useState(8);
  const [mono, setMono] = useState(true);
  // Refs
  const overviewCanvas = useRef(null);
  const detailCanvas = useRef(null);
  const fileInput = useRef(null);
  const activeVoices = useRef(new Map());
  const dragMarker = useRef(null);
  // Refs for latest state (avoids stale closures in MIDI callback)
  const triggerNoteRef = useRef(null);
  const releaseNoteRef = useRef(null);
  const bufferRef = useRef(null);
  const padsRef = useRef(pads);
  const engineRef = useRef(engine);
  const selectedPadRef = useRef(selectedPad);

  // ─── Keep refs in sync so MIDI callback always has latest state ───
  useEffect(() => { bufferRef.current = buffer; }, [buffer]);
  useEffect(() => { padsRef.current = pads; }, [pads]);
  useEffect(() => { engineRef.current = engine; }, [engine]);
  useEffect(() => { selectedPadRef.current = selectedPad; }, [selectedPad]);

  // ─── Helpers to update selected pad's params ───
  const updatePad = useCallback((idx, updater) => {
    setPads(prev => prev.map((p, i) => i === idx ? (typeof updater === "function" ? updater(p) : { ...p, ...updater }) : p));
  }, []);
  const updateSelectedPadAdsr = useCallback((key, val) => {
    setPads(prev => prev.map((p, i) => i === selectedPad ? { ...p, adsr: { ...p.adsr, [key]: val } } : p));
  }, [selectedPad]);
  const updateSelectedPadFilter = useCallback((key, val) => {
    setPads(prev => prev.map((p, i) => i === selectedPad ? { ...p, filter: { ...p.filter, [key]: val } } : p));
  }, [selectedPad]);
  const updateSelectedPadDrive = useCallback((key, val) => {
    setPads(prev => prev.map((p, i) => i === selectedPad ? { ...p, drive: { ...p.drive, [key]: val } } : p));
  }, [selectedPad]);
  const updateSelectedPadField = useCallback((key, val) => {
    setPads(prev => prev.map((p, i) => i === selectedPad ? { ...p, [key]: val } : p));
  }, [selectedPad]);

  // Sync delay bus params to AudioCtx nodes
  useEffect(() => {
    if (AudioCtx.delayBus) {
      AudioCtx.delayBus.delay.delayTime.value = delayBus.time;
      AudioCtx.delayBus.feedback.gain.value = delayBus.feedback;
    }
  }, [delayBus]);
  // Sync reverb bus params
  useEffect(() => {
    if (AudioCtx.reverbBus) {
      AudioCtx.reverbBus.wet.gain.value = reverbBus.mix;
    }
  }, [reverbBus]);

  // Convenience: current selected pad object
  const selPad = pads[selectedPad] || pads[0];

  // ─── Init Audio ───
  const initAudio = useCallback(async () => {
    AudioCtx.init();
    await AudioCtx.initWorklet();
    const buf = AudioCtx.generateDemoBuffer("drums", 128);
    setBuffer(buf);
    setAudioReady(true);
    // Detect hit points
    detectHitPoints(buf, hitSensitivity);
  }, []);

  // ─── Hit Point Detection ───
  const detectHitPoints = useCallback((buf, sensitivity) => {
    if (!buf) return;
    const data = buf.getChannelData(0);
    const blockSize = 512;
    const thresh = (100 - sensitivity) / 100 * 0.5;
    const points = [];
    let prevEnergy = 0;
    for (let i = 0; i < data.length; i += blockSize) {
      let energy = 0;
      for (let j = i; j < Math.min(i + blockSize, data.length); j++) energy += data[j] * data[j];
      energy /= blockSize;
      if (energy - prevEnergy > thresh && i > 0) points.push(i);
      prevEnergy = energy;
    }
    setHitPoints(points);
  }, []);

  // ─── Load Audio File ───
  const loadFile = useCallback(async (file) => {
    const ctx = AudioCtx.init();
    const arrayBuf = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuf);
    setBuffer(decoded);
    setSampleName(file.name.replace(/\.[^.]+$/, ""));
    const dur = decoded.duration.toFixed(2);
    setSampleInfo(`${dur}s / ${engine.bpm}bpm / None`);
    setMarkers({ S: 0, L: 0.5, E: 1 });
    setViewRange({ start: 0, end: 1 });
    detectHitPoints(decoded, hitSensitivity);
    setAudioReady(true);
  }, [engine.bpm, hitSensitivity]);

  // ─── Draw Waveforms ───
  useEffect(() => {
    if (!buffer) return;
    const len = buffer.getChannelData(0).length;
    const mkrs = [
      { type: "S", pos: markers.S * len },
      { type: "L", pos: markers.L * len },
      { type: "E", pos: markers.E * len }
    ];
    const gridLines = [];
    if (gridOn) {
      const divMap = { "1/4": 4, "1/8": 8, "1/16": 16, "1/32": 32 };
      const divs = divMap[gridWidth] || 16;
      for (let i = 0; i <= divs; i++) gridLines.push(Math.floor((i / divs) * len));
    }
    const slices = pads.map(p => ({ start: p.sliceStart * len, end: p.sliceEnd * len }));
    // Overview
    if (overviewCanvas.current) {
      const c = overviewCanvas.current;
      c.width = c.offsetWidth * 2; c.height = c.offsetHeight * 2;
      const octx = c.getContext("2d"); octx.scale(2, 2);
      drawWaveform(c, buffer, { color: "#00e5ff", markers: mkrs, gridLines, slices });
      // View range highlight
      const ctx2 = c.getContext("2d");
      const w = c.width / 2;
      ctx2.strokeStyle = "#00e5ff";
      ctx2.lineWidth = 1;
      ctx2.strokeRect(viewRange.start * w, 0, (viewRange.end - viewRange.start) * w, c.height / 2);
    }
    // Detail
    if (detailCanvas.current) {
      const c = detailCanvas.current;
      c.width = c.offsetWidth * 2; c.height = c.offsetHeight * 2;
      const dctx = c.getContext("2d"); dctx.scale(2, 2);
      drawWaveform(c, buffer, {
        start: viewRange.start, end: viewRange.end, color: "#00e5ff",
        markers: mkrs, hitPoints: showHitPoints ? hitPoints : [], gridLines, slices
      });
    }
  }, [buffer, markers, viewRange, hitPoints, showHitPoints, gridOn, gridWidth, pads]);

  // ─── Note-to-pad mapping ───
  // Launchkey 25 drum pads: notes 36-51 (C1-D#2) on ch10
  // Launchkey 25 keys: notes 48-72 (C2-C4) on ch1
  // We map both to pads: drum pads directly, keys offset from startKey
  const noteToPadIdx = useCallback((note, channel) => {
    // Drum pads (ch10 = channel 9 zero-indexed): notes 36-51 → pads 0-15
    if (channel === 9 && note >= 36 && note <= 51) return note - 36;
    // Keys: map from startKey (default C3=60) → pad 0-15
    const startNote = 60; // C3
    const idx = note - startNote;
    if (idx >= 0 && idx < 16) return idx;
    return -1;
  }, []);

  // ─── Note Trigger (uses refs for MIDI-safe access) ───
  const triggerNote = useCallback((note, velocity = 0.8, channel = 0) => {
    const buf = bufferRef.current;
    if (!buf) return;
    const padIdx = noteToPadIdx(note, channel);
    if (padIdx < 0 || padIdx >= 16) return;
    const pad = padsRef.current[padIdx];
    if (!pad || !pad.assigned) return;
    const eng = engineRef.current;
    const a = pad.adsr;
    const f = pad.filter;
    const dr = pad.drive;
    const len = buf.duration;
    const voice = AudioCtx.playSlice(buf, pad.sliceStart * len, pad.sliceEnd * len, {
      velocity,
      speed: eng.speed, reverse: eng.reverse, loop: eng.loop,
      attack: a.attack, decay: a.decay, sustain: a.sustain, release: a.release,
      filterType: f.type, filterFreq: f.freq, filterQ: f.q,
      driveAmount: dr.amount, driveCurve: dr.curve,
      delaySend: pad.delaySend, reverbSend: pad.reverbSend,
      volume: pad.volume, pan: pad.pan,
    });
    if (voice) {
      // Choke: stop previous voice on same pad
      const chokeKey = `pad-${padIdx}`;
      const prev = activeVoices.current.get(chokeKey);
      if (prev) prev.stop();
      activeVoices.current.set(chokeKey, voice);
      activeVoices.current.set(note, voice);
      setPads(p => p.map((pd, i) => i === padIdx ? { ...pd, active: true } : pd));
      setActiveKeys(k => new Set(k).add(note));
    }
  }, [noteToPadIdx]);

  const releaseNote = useCallback((note, channel = 0) => {
    const voice = activeVoices.current.get(note);
    if (voice) { voice.stop(); activeVoices.current.delete(note); }
    const padIdx = noteToPadIdx(note, channel);
    if (padIdx >= 0 && padIdx < 16) {
      activeVoices.current.delete(`pad-${padIdx}`);
      setPads(p => p.map((pd, i) => i === padIdx ? { ...pd, active: false } : pd));
    }
    setActiveKeys(k => { const n = new Set(k); n.delete(note); return n; });
  }, [noteToPadIdx]);

  // Keep refs pointing to latest functions
  useEffect(() => { triggerNoteRef.current = triggerNote; }, [triggerNote]);
  useEffect(() => { releaseNoteRef.current = releaseNote; }, [releaseNote]);

  // ─── MIDI Setup (Launchkey-aware, hot-plug, CC mapping) ───
  useEffect(() => {
    let access = null;

    const handleMidiMessage = (msg) => {
      const data = msg.data;
      if (!data || data.length < 2) return;
      const status = data[0];
      const channel = status & 0x0f;
      const cmd = status & 0xf0;
      const byte1 = data[1];
      const byte2 = data.length > 2 ? data[2] : 0;

      // Log for MIDI Learn mode
      setMidiLog(prev => {
        const entry = `ch${channel + 1} ${cmd === 0x90 ? "ON" : cmd === 0x80 ? "OFF" : cmd === 0xB0 ? "CC" : cmd === 0xE0 ? "PB" : "??"} ${byte1} ${byte2}`;
        return [entry, ...prev.slice(0, 7)];
      });

      // Note On
      if (cmd === 0x90 && byte2 > 0) {
        triggerNoteRef.current?.(byte1, byte2 / 127, channel);
      }
      // Note Off
      else if (cmd === 0x80 || (cmd === 0x90 && byte2 === 0)) {
        releaseNoteRef.current?.(byte1, channel);
      }
      // CC messages — Launchkey 25 knobs send CC 21-28 on ch1
      // Now controls the SELECTED pad's params
      else if (cmd === 0xB0) {
        const ccVal = byte2 / 127;
        const si = selectedPadRef.current;
        switch (byte1) {
          case 21: setPads(p => p.map((pd, i) => i === si ? { ...pd, filter: { ...pd.filter, freq: 20 + ccVal * 19980 } } : pd)); break;
          case 22: setPads(p => p.map((pd, i) => i === si ? { ...pd, filter: { ...pd.filter, q: 0.1 + ccVal * 19.9 } } : pd)); break;
          case 23: setPads(p => p.map((pd, i) => i === si ? { ...pd, adsr: { ...pd.adsr, attack: ccVal * 2 } } : pd)); break;
          case 24: setPads(p => p.map((pd, i) => i === si ? { ...pd, adsr: { ...pd.adsr, decay: ccVal * 2 } } : pd)); break;
          case 25: setPads(p => p.map((pd, i) => i === si ? { ...pd, adsr: { ...pd.adsr, sustain: ccVal } } : pd)); break;
          case 26: setPads(p => p.map((pd, i) => i === si ? { ...pd, adsr: { ...pd.adsr, release: ccVal * 5 } } : pd)); break;
          case 27: setPads(p => p.map((pd, i) => i === si ? { ...pd, delaySend: ccVal } : pd)); break;   // Knob 7 → Delay Send
          case 28: setPads(p => p.map((pd, i) => i === si ? { ...pd, reverbSend: ccVal } : pd)); break;  // Knob 8 → Reverb Send
          case 1: setModWheel(ccVal); break;
          default: break;
        }
      }
      // Pitch Bend
      else if (cmd === 0xE0) {
        const bendVal = ((byte2 << 7 | byte1) - 8192) / 8192; // -1 to +1
        setPitchBend(bendVal);
      }
    };

    const bindInputs = (midiAccess) => {
      let foundDevice = false;
      for (const input of midiAccess.inputs.values()) {
        input.onmidimessage = handleMidiMessage;
        // Detect Launchkey by name
        if (input.name && (input.name.toLowerCase().includes("launchkey") || input.name.toLowerCase().includes("novation"))) {
          setMidiDeviceName(input.name);
          foundDevice = true;
        } else if (!foundDevice && input.name) {
          setMidiDeviceName(input.name);
        }
      }
      const hasInputs = midiAccess.inputs.size > 0;
      setMidiConnected(hasInputs);
      if (!hasInputs) { setMidiDeviceName(""); }
    };

    navigator.requestMIDIAccess({ sysex: false }).then(midiAccess => {
      access = midiAccess;
      bindInputs(midiAccess);
      // Hot-plug: re-bind when devices connect/disconnect
      midiAccess.onstatechange = () => bindInputs(midiAccess);
    }).catch(() => {
      setMidiConnected(false);
      setMidiDeviceName("MIDI not available");
    });

    return () => {
      if (access) {
        for (const input of access.inputs.values()) input.onmidimessage = null;
        access.onstatechange = null;
      }
    };
  }, []); // Runs once — uses refs to avoid stale closures

  // ─── Slice to Pads ───
  const sliceToPads = useCallback(() => {
    if (hitPoints.length === 0) return;
    const len = buffer.getChannelData(0).length;
    const pts = [0, ...hitPoints.slice(0, 15), len];
    const newPads = Array.from({ length: 16 }, (_, i) => ({
      ...createPad(i),
      assigned: i < pts.length - 1,
      sliceStart: i < pts.length - 1 ? pts[i] / len : i / 16,
      sliceEnd: i < pts.length - 1 ? pts[i + 1] / len : (i + 1) / 16
    }));
    setPads(newPads);
  }, [hitPoints, buffer]);

  // ─── Keyboard handler (uses refs to avoid stale closures) ───
  useEffect(() => {
    const keyMap = { z: 60, x: 61, c: 62, v: 63, b: 64, n: 65, m: 66, ",": 67,
      a: 68, s: 69, d: 70, f: 71, g: 72, h: 73, j: 74, k: 75 };
    const held = new Set();
    const down = (e) => {
      if (e.repeat) return;
      const n = keyMap[e.key.toLowerCase()];
      if (n && !held.has(n)) { held.add(n); triggerNoteRef.current?.(n, 0.8, 0); }
    };
    const up = (e) => {
      const n = keyMap[e.key.toLowerCase()];
      if (n) { held.delete(n); releaseNoteRef.current?.(n, 0); }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // ─── Marker Drag ───
  const handleCanvasMouseDown = useCallback((e, isOverview) => {
    if (!buffer) return;
    const rect = e.target.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const len = buffer.getChannelData(0).length;
    const norm = isOverview ? x : viewRange.start + x * (viewRange.end - viewRange.start);
    const mEntries = Object.entries(markers);
    let closest = null, minDist = 0.02;
    mEntries.forEach(([type, pos]) => {
      const dist = Math.abs(pos - norm);
      if (dist < minDist) { closest = type; minDist = dist; }
    });
    if (closest) dragMarker.current = { type: closest, isOverview };
  }, [buffer, markers, viewRange]);

  const handleCanvasMouseMove = useCallback((e) => {
    if (!dragMarker.current) return;
    const rect = e.target.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const norm = dragMarker.current.isOverview ? x : viewRange.start + x * (viewRange.end - viewRange.start);
    setMarkers(m => ({ ...m, [dragMarker.current.type]: Math.max(0, Math.min(1, norm)) }));
  }, [viewRange]);

  const handleCanvasMouseUp = useCallback(() => { dragMarker.current = null; }, []);

  // ─── Knob Component ───
  const Knob = ({ value, min = 0, max = 1, onChange, label, size = 36, color = "#00e5ff", displayValue }) => {
    const knobRef = useRef(null);
    const dragRef = useRef(null);
    const angle = ((value - min) / (max - min)) * 270 - 135;
    const handleMouseDown = (e) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startVal: value };
      const move = (ev) => {
        const dy = dragRef.current.startY - ev.clientY;
        const range = max - min;
        const newVal = Math.max(min, Math.min(max, dragRef.current.startVal + (dy / 150) * range));
        onChange(newVal);
      };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, userSelect: "none" }}>
        <div ref={knobRef} onMouseDown={handleMouseDown} onTouchStart={(e) => {
          const touch = e.touches[0];
          dragRef.current = { startY: touch.clientY, startVal: value };
          const move = (ev) => {
            const dy = dragRef.current.startY - ev.touches[0].clientY;
            const range = max - min;
            onChange(Math.max(min, Math.min(max, dragRef.current.startVal + (dy / 150) * range)));
          };
          const end = () => { document.removeEventListener("touchmove", move); document.removeEventListener("touchend", end); };
          document.addEventListener("touchmove", move);
          document.addEventListener("touchend", end);
        }}
          style={{ width: size, height: size, borderRadius: "50%", background: "radial-gradient(circle at 40% 35%, #2a3040, #0d1117)",
            border: `2px solid ${color}33`, cursor: "pointer", position: "relative", boxShadow: `0 0 8px ${color}22` }}>
          <div style={{ position: "absolute", top: "50%", left: "50%", width: 2, height: size * 0.35,
            background: color, borderRadius: 1, transformOrigin: "top center",
            transform: `translate(-50%, 0) rotate(${angle}deg)`, boxShadow: `0 0 4px ${color}` }} />
        </div>
        <span style={{ fontSize: 9, color: "#8899aa", letterSpacing: 0.5 }}>{label}</span>
        {displayValue !== undefined && <span style={{ fontSize: 8, color, fontFamily: "monospace" }}>{displayValue}</span>}
      </div>
    );
  };

  // ─── Toggle Button ───
  const Toggle = ({ active, onClick, children, accent = false }) => (
    <button onClick={onClick} style={{
      background: active ? (accent ? "#00e5ff" : "rgba(0,229,255,0.15)") : "rgba(255,255,255,0.04)",
      color: active ? (accent ? "#0d1117" : "#00e5ff") : "#556677",
      border: `1px solid ${active ? "#00e5ff44" : "#ffffff08"}`,
      borderRadius: 4, padding: "4px 10px", fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
      cursor: "pointer", transition: "all 0.15s", letterSpacing: 0.5, fontWeight: active ? 600 : 400
    }}>{children}</button>
  );

  // ─── Styles ───
  const sty = {
    root: { width: "100%", maxWidth: 1200, margin: "0 auto", background: "#0a0e14",
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace", color: "#c8d6e5", minHeight: "100vh",
      borderRadius: 8, overflow: "hidden", border: "1px solid #1a2030" },
    header: { display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "8px 16px", background: "linear-gradient(180deg, #141a24 0%, #0d1219 100%)",
      borderBottom: "1px solid #1a2030" },
    tabs: { display: "flex", gap: 2 },
    tab: (active) => ({ padding: "6px 14px", cursor: "pointer", fontSize: 11, letterSpacing: 0.8,
      color: active ? "#00e5ff" : "#556677", borderBottom: active ? "2px solid #00e5ff" : "2px solid transparent",
      background: "transparent", border: "none", fontFamily: "inherit", transition: "all 0.15s" }),
    section: { padding: "12px 16px", borderBottom: "1px solid #1a2030" },
    sectionTitle: { fontSize: 9, color: "#445566", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 },
    canvas: { width: "100%", borderRadius: 4, cursor: "crosshair", border: "1px solid #1a2535",
      background: "linear-gradient(180deg, rgba(0,229,255,0.02) 0%, transparent 100%)" },
    paramRow: { display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" },
    paramGroup: { display: "flex", flexDirection: "column", gap: 4 },
    paramLabel: { fontSize: 8, color: "#445566", letterSpacing: 1, textTransform: "uppercase" },
    paramValue: { fontSize: 16, color: "#00e5ff", fontWeight: 600, fontFamily: "inherit" },
    padGrid: { display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 6 },
    pad: (active, assigned, selected) => ({
      aspectRatio: "1", borderRadius: "50%", cursor: "pointer", position: "relative",
      background: active ? "radial-gradient(circle, #00e5ff 0%, #006680 100%)"
        : assigned ? "radial-gradient(circle at 40% 35%, #1a2535 0%, #0d1520 100%)" : "#0a0e14",
      border: `2px solid ${active ? "#00e5ff" : selected ? "#00e5ff88" : assigned ? "#1a3040" : "#0f1520"}`,
      boxShadow: active ? "0 0 20px rgba(0,229,255,0.4), inset 0 0 10px rgba(0,229,255,0.2)"
        : selected ? "0 0 12px rgba(0,229,255,0.15)" : "none",
      display: "flex", alignItems: "center", justifyContent: "center",
      transition: "all 0.1s", transform: active ? "scale(0.95)" : "scale(1)"
    }),
    key: (isBlack, isActive) => ({
      width: isBlack ? 18 : 24, height: isBlack ? 50 : 72,
      background: isActive ? "#00e5ff" : (isBlack ? "linear-gradient(180deg, #1a2030, #0d1117)" : "linear-gradient(180deg, #c8d0d8, #a0a8b0)"),
      border: `1px solid ${isBlack ? "#0a0e14" : "#8890a0"}`,
      borderRadius: isBlack ? "0 0 3px 3px" : "0 0 5px 5px",
      cursor: "pointer", zIndex: isBlack ? 2 : 1,
      marginLeft: isBlack ? -9 : 0, marginRight: isBlack ? -9 : 0,
      boxShadow: isActive ? `0 0 12px ${isBlack ? "#00e5ff88" : "#00e5ff44"}`
        : (isBlack ? "inset 0 -2px 3px rgba(0,0,0,0.3)" : "inset 0 -3px 4px rgba(0,0,0,0.1)"),
      transition: "all 0.05s"
    })
  };

  // ─── Piano keys ───
  const pianoKeys = useMemo(() => {
    const keys = [];
    const pattern = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0]; // 0=white, 1=black
    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    for (let i = 36; i <= 96; i++) { // C2 to C7
      const noteInOctave = i % 12;
      const octave = Math.floor(i / 12) - 1;
      keys.push({ note: i, name: noteNames[noteInOctave] + octave, isBlack: pattern[noteInOctave] === 1 });
    }
    return keys;
  }, []);

  if (!audioReady) {
    return (
      <div style={{ ...sty.root, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh",
        background: "radial-gradient(circle at 50% 40%, #0d1520, #060a0f)" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 36, fontWeight: 200, color: "#00e5ff", letterSpacing: 12, marginBottom: 4 }}>LEAP</div>
          <div style={{ fontSize: 10, color: "#334455", letterSpacing: 4, marginBottom: 32 }}>SAMPLER ENGINE</div>
          <button onClick={initAudio} style={{
            background: "linear-gradient(180deg, rgba(0,229,255,0.12), rgba(0,229,255,0.04))",
            border: "1px solid #00e5ff33", borderRadius: 6, padding: "14px 40px",
            color: "#00e5ff", fontSize: 12, fontFamily: "inherit", cursor: "pointer", letterSpacing: 2,
            boxShadow: "0 0 30px rgba(0,229,255,0.08)", transition: "all 0.2s"
          }} onMouseOver={e => e.target.style.boxShadow = "0 0 40px rgba(0,229,255,0.2)"}
             onMouseOut={e => e.target.style.boxShadow = "0 0 30px rgba(0,229,255,0.08)"}>
            INITIALIZE
          </button>
          <div style={{ marginTop: 24, display: "flex", gap: 12, justifyContent: "center" }}>
            <button onClick={() => fileInput.current?.click()} style={{
              background: "transparent", border: "1px solid #1a2535", borderRadius: 4,
              padding: "8px 20px", color: "#556677", fontSize: 10, fontFamily: "inherit",
              cursor: "pointer", letterSpacing: 1 }}>LOAD SAMPLE</button>
          </div>
          <input ref={fileInput} type="file" accept="audio/*" style={{ display: "none" }}
            onChange={e => e.target.files[0] && loadFile(e.target.files[0])} />
        </div>
      </div>
    );
  }

  return (
    <div style={sty.root}>
      {/* HEADER */}
      <div style={sty.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 9, color: "#556677" }}>Galaxy Fold Kit</span>
        </div>
        <div style={{ fontSize: 18, fontWeight: 200, color: "#00e5ff", letterSpacing: 6 }}>LEAP</div>
        <div style={sty.tabs}>
          {["play", "edit", "send fx", "perform fx"].map(t => (
            <button key={t} style={sty.tab(activeTab === t)} onClick={() => setActiveTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* SAMPLE NAME / INFO */}
      <div style={{ ...sty.section, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 16px" }}>
        <div>
          <div style={{ color: "#00e5ff", fontSize: 13, fontWeight: 500 }}>{sampleName}</div>
          <div style={{ fontSize: 9, color: "#445566" }}>{sampleInfo}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 9, color: "#445566" }}>Voices</span>
          <span style={{ color: "#00e5ff", fontSize: 14 }}>{voices}</span>
          <Toggle active={mono} onClick={() => setMono(!mono)}>Mono</Toggle>
          <button onClick={() => fileInput.current?.click()} style={{
            background: "rgba(0,229,255,0.08)", border: "1px solid #00e5ff22", borderRadius: 4,
            padding: "4px 10px", color: "#00e5ff", fontSize: 9, cursor: "pointer", fontFamily: "inherit"
          }}>Load</button>
          <input ref={fileInput} type="file" accept="audio/*" style={{ display: "none" }}
            onChange={e => e.target.files[0] && loadFile(e.target.files[0])} />
        </div>
      </div>

      {/* GRID CONTROLS */}
      <div style={{ ...sty.section, display: "flex", gap: 16, alignItems: "center", padding: "4px 16px" }}>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={sty.paramLabel}>GRID</span>
          {["Off", "Fix", "Auto"].map(g => (
            <Toggle key={g} active={gridOn && g === "Fix"} onClick={() => setGridOn(g !== "Off")}>{g}</Toggle>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={sty.paramLabel}>WIDTH</span>
          {["1/4", "1/8", "1/16", "1/32"].map(w => (
            <Toggle key={w} active={gridWidth === w} onClick={() => setGridWidth(w)}>{w}</Toggle>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={sty.paramLabel}>SNAP TO</span>
          {["Off", "Grid", "Zero-X"].map(s => (
            <Toggle key={s} active={snapMode === s} onClick={() => setSnapMode(s)}>{s}</Toggle>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Toggle active={showHitPoints} onClick={() => setShowHitPoints(!showHitPoints)}>Hit Points</Toggle>
          <button onClick={sliceToPads} style={{
            background: "rgba(255,200,0,0.08)", border: "1px solid rgba(255,200,0,0.2)", borderRadius: 4,
            padding: "4px 10px", color: "#ffc800", fontSize: 9, cursor: "pointer", fontFamily: "inherit"
          }}>Slice → Pads</button>
        </div>
      </div>

      {/* OVERVIEW WAVEFORM */}
      <div style={{ ...sty.section, padding: "4px 16px 2px" }}>
        <canvas ref={overviewCanvas} style={{ ...sty.canvas, height: 48 }}
          onMouseDown={e => handleCanvasMouseDown(e, true)}
          onMouseMove={handleCanvasMouseMove} onMouseUp={handleCanvasMouseUp} />
      </div>

      {/* DETAIL WAVEFORM */}
      <div style={{ ...sty.section, padding: "2px 16px 8px" }}>
        <canvas ref={detailCanvas} style={{ ...sty.canvas, height: 160 }}
          onMouseDown={e => handleCanvasMouseDown(e, false)}
          onMouseMove={handleCanvasMouseMove} onMouseUp={handleCanvasMouseUp} />
      </div>

      {/* HIT POINT SENSITIVITY */}
      {showHitPoints && (
        <div style={{ ...sty.section, padding: "4px 16px", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 9, color: "#ffc800", letterSpacing: 1 }}>SENSITIVITY</span>
          <input type="range" min={10} max={95} value={hitSensitivity}
            onChange={e => { setHitSensitivity(+e.target.value); detectHitPoints(buffer, +e.target.value); }}
            style={{ flex: 1, accentColor: "#ffc800", height: 3 }} />
          <span style={{ fontSize: 10, color: "#ffc800", fontFamily: "monospace" }}>{hitSensitivity}%</span>
          <span style={{ fontSize: 9, color: "#556677" }}>{hitPoints.length} pts</span>
        </div>
      )}

      {/* ENGINE / SOUND TABS */}
      <div style={{ ...sty.section, padding: "4px 16px" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: "#00e5ff", cursor: "pointer" }}>Engine</span>
          <span style={{ fontSize: 11, color: "#445566", cursor: "pointer" }}>Sound</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <span style={{ fontSize: 9, color: "#556677" }}>Perform FX</span>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#ff3366", marginTop: 2 }} />
            <span style={{ fontSize: 9, color: "#556677" }}>Macro FX</span>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#ff3366", marginTop: 2 }} />
          </div>
        </div>
      </div>

      {/* ENGINE PARAMETERS */}
      <div style={{ ...sty.section, padding: "8px 16px" }}>
        <div style={sty.paramRow}>
          {/* TYPE */}
          <div style={sty.paramGroup}>
            <span style={sty.paramLabel}>TYPE</span>
            <div style={{ display: "flex", gap: 4 }}>
              {["melody", "shift", "env order"].map(t => (
                <Toggle key={t} active={engine.type === t} onClick={() => setEngine(e => ({ ...e, type: t }))}>
                  {t === "melody" ? "♪" : t === "shift" ? "⇄" : "|||"}
                </Toggle>
              ))}
            </div>
            <span style={{ fontSize: 8, color: "#556677", textAlign: "center" }}>
              {engine.type.charAt(0).toUpperCase() + engine.type.slice(1)}
            </span>
          </div>

          {/* HQ / Formants / Reverse / Sync */}
          <div style={{ display: "flex", gap: 4, alignSelf: "center" }}>
            <Toggle active={engine.hq} onClick={() => setEngine(e => ({ ...e, hq: !e.hq }))}>HQ</Toggle>
            <Toggle active={engine.formants} onClick={() => setEngine(e => ({ ...e, formants: !e.formants }))}>Formants</Toggle>
            <Toggle active={engine.reverse} onClick={() => setEngine(e => ({ ...e, reverse: !e.reverse }))}>Reverse</Toggle>
            <Toggle active={engine.sync} onClick={() => setEngine(e => ({ ...e, sync: !e.sync }))} accent>Sync</Toggle>
          </div>

          {/* TEMPO */}
          <div style={sty.paramGroup}>
            <span style={sty.paramLabel}>TEMPO</span>
            <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
              <span style={{ ...sty.paramValue, fontSize: 20 }}>{engine.bpm.toFixed(2)}</span>
              <span style={{ fontSize: 10, color: "#556677" }}>x {engine.speed}</span>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <span style={{ fontSize: 8, color: "#556677" }}>BPM</span>
              <span style={{ fontSize: 8, color: "#556677", marginLeft: 16 }}>Speed</span>
            </div>
          </div>

          {/* TUNING */}
          <div style={sty.paramGroup}>
            <span style={sty.paramLabel}>TUNING</span>
            <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
              <span style={sty.paramValue}>{engine.tonality}</span>
              <span style={sty.paramValue}>{engine.tune.toFixed(2)}</span>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <span style={{ fontSize: 8, color: "#556677" }}>Tonality</span>
              <span style={{ fontSize: 8, color: "#556677", marginLeft: 12 }}>Tune</span>
            </div>
          </div>

          {/* Global */}
          <div style={sty.paramGroup}>
            <Toggle active={false}>Global</Toggle>
          </div>

          {/* PLAYBACK */}
          <div style={sty.paramGroup}>
            <span style={sty.paramLabel}>PLAYBACK</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div onClick={() => setEngine(e => ({ ...e, loop: !e.loop }))} style={{
                width: 28, height: 16, borderRadius: 8, cursor: "pointer",
                background: engine.loop ? "#00e5ff" : "#1a2535", transition: "all 0.15s", position: "relative"
              }}>
                <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#fff", position: "absolute",
                  top: 2, left: engine.loop ? 14 : 2, transition: "all 0.15s" }} />
              </div>
              <span style={{ fontSize: 8, color: "#556677" }}>Loop</span>
            </div>
          </div>

          {/* Trigger Style */}
          <div style={sty.paramGroup}>
            <div style={{ display: "flex", gap: 4 }}>
              {["Hold", "Latch"].map(t => (
                <Toggle key={t} active={engine.triggerStyle === t}
                  onClick={() => setEngine(e => ({ ...e, triggerStyle: t }))} accent={engine.triggerStyle === t}>
                  {t}
                </Toggle>
              ))}
            </div>
            <span style={{ fontSize: 8, color: "#556677", textAlign: "center" }}>Trigger Style</span>
          </div>

          {/* Choke */}
          <div style={sty.paramGroup}>
            <span style={{ ...sty.paramValue, color: engine.choke === "Off" ? "#ff3366" : "#00e5ff" }}>{engine.choke}</span>
            <span style={{ fontSize: 8, color: "#556677" }}>Choke</span>
          </div>

          {/* Legato */}
          <div style={sty.paramGroup}>
            <Toggle active={false}>Legato</Toggle>
          </div>
        </div>
      </div>

      {/* SIGNAL CHAIN — per-pad controls for selected pad */}
      <div style={{ ...sty.section, padding: "8px 16px" }}>
        {/* Pad label + Copy/Paste */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: "#00e5ff", fontWeight: 600, letterSpacing: 2 }}>
            PAD {selPad.id}
          </span>
          <button onClick={() => setPadClipboard(JSON.parse(JSON.stringify({
            adsr: selPad.adsr, filter: selPad.filter, drive: selPad.drive,
            delaySend: selPad.delaySend, reverbSend: selPad.reverbSend,
            volume: selPad.volume, pan: selPad.pan
          })))} style={{
            background: "rgba(0,229,255,0.08)", border: "1px solid #00e5ff22", borderRadius: 4,
            padding: "3px 10px", color: "#00e5ff", fontSize: 9, cursor: "pointer", fontFamily: "inherit", letterSpacing: 0.5
          }}>COPY</button>
          <button onClick={() => {
            if (!padClipboard) return;
            setPads(prev => prev.map((p, i) => i === selectedPad ? { ...p, ...JSON.parse(JSON.stringify(padClipboard)) } : p));
          }} style={{
            background: padClipboard ? "rgba(0,229,255,0.08)" : "rgba(255,255,255,0.02)",
            border: `1px solid ${padClipboard ? "#00e5ff22" : "#ffffff08"}`, borderRadius: 4,
            padding: "3px 10px", color: padClipboard ? "#00e5ff" : "#334455", fontSize: 9, cursor: "pointer", fontFamily: "inherit", letterSpacing: 0.5
          }}>PASTE</button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 8, color: "#334455" }}>
            {selPad.assigned ? `Slice ${(selPad.sliceStart * 100).toFixed(0)}%-${(selPad.sliceEnd * 100).toFixed(0)}%` : "Unassigned"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          {/* ADSR — per pad */}
          <div>
            <div style={sty.sectionTitle}>ENVELOPE</div>
            <div style={{ display: "flex", gap: 10 }}>
              <Knob value={selPad.adsr.attack} min={0} max={2} onChange={v => updateSelectedPadAdsr("attack", v)}
                label="ATK" displayValue={selPad.adsr.attack.toFixed(3)} />
              <Knob value={selPad.adsr.decay} min={0} max={2} onChange={v => updateSelectedPadAdsr("decay", v)}
                label="DEC" displayValue={selPad.adsr.decay.toFixed(2)} />
              <Knob value={selPad.adsr.sustain} min={0} max={1} onChange={v => updateSelectedPadAdsr("sustain", v)}
                label="SUS" displayValue={selPad.adsr.sustain.toFixed(2)} />
              <Knob value={selPad.adsr.release} min={0} max={5} onChange={v => updateSelectedPadAdsr("release", v)}
                label="REL" displayValue={selPad.adsr.release.toFixed(2)} />
            </div>
          </div>
          {/* Filter — per pad */}
          <div>
            <div style={sty.sectionTitle}>FILTER</div>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {["lowpass", "highpass", "bandpass", "notch"].map(ft => (
                  <Toggle key={ft} active={selPad.filter.type === ft} onClick={() => updateSelectedPadFilter("type", ft)}>
                    {ft.slice(0, 2).toUpperCase()}
                  </Toggle>
                ))}
              </div>
              <Knob value={selPad.filter.freq} min={20} max={20000} onChange={v => updateSelectedPadFilter("freq", v)}
                label="FREQ" displayValue={selPad.filter.freq < 1000 ? selPad.filter.freq.toFixed(0) + "Hz" : (selPad.filter.freq / 1000).toFixed(1) + "k"} />
              <Knob value={selPad.filter.q} min={0.1} max={20} onChange={v => updateSelectedPadFilter("q", v)}
                label="Q" displayValue={selPad.filter.q.toFixed(1)} />
            </div>
          </div>
          {/* Drive — per pad */}
          <div>
            <div style={sty.sectionTitle}>DRIVE</div>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <Knob value={selPad.drive.amount} min={0} max={1} onChange={v => updateSelectedPadDrive("amount", v)}
                label="AMT" displayValue={(selPad.drive.amount * 100).toFixed(0) + "%"} />
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {["soft", "hard", "clip"].map(c => (
                  <Toggle key={c} active={selPad.drive.curve === c} onClick={() => updateSelectedPadDrive("curve", c)}>
                    {c.toUpperCase()}
                  </Toggle>
                ))}
              </div>
            </div>
          </div>
          {/* Volume + Pan — per pad */}
          <div>
            <div style={sty.sectionTitle}>OUTPUT</div>
            <div style={{ display: "flex", gap: 10 }}>
              <Knob value={selPad.volume} min={0} max={2} onChange={v => updateSelectedPadField("volume", v)}
                label="VOL" displayValue={(selPad.volume * 100).toFixed(0) + "%"} />
              <Knob value={selPad.pan} min={-1} max={1} onChange={v => updateSelectedPadField("pan", v)}
                label="PAN" displayValue={selPad.pan === 0 ? "C" : (selPad.pan < 0 ? "L" + (-selPad.pan * 100).toFixed(0) : "R" + (selPad.pan * 100).toFixed(0))} />
            </div>
          </div>
          {/* Send levels — per pad */}
          <div>
            <div style={sty.sectionTitle}>SENDS</div>
            <div style={{ display: "flex", gap: 10 }}>
              <Knob value={selPad.delaySend} min={0} max={1} onChange={v => updateSelectedPadField("delaySend", v)}
                label="DLY" displayValue={(selPad.delaySend * 100).toFixed(0) + "%"} />
              <Knob value={selPad.reverbSend} min={0} max={1} onChange={v => updateSelectedPadField("reverbSend", v)}
                label="REV" displayValue={(selPad.reverbSend * 100).toFixed(0) + "%"} />
            </div>
          </div>
          {/* LFO (global) */}
          <div>
            <div style={sty.sectionTitle}>LFO 1</div>
            <div style={{ display: "flex", gap: 10 }}>
              <Knob value={lfo1.rate} min={0.1} max={20} onChange={v => setLfo1(l => ({ ...l, rate: v }))}
                label="RATE" displayValue={lfo1.rate.toFixed(1) + "Hz"} />
              <Knob value={lfo1.depth} min={0} max={1} onChange={v => setLfo1(l => ({ ...l, depth: v }))}
                label="DEPTH" displayValue={(lfo1.depth * 100).toFixed(0) + "%"} />
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {["sine", "tri", "saw", "sqr"].map(s => (
                  <Toggle key={s} active={lfo1.shape === s} onClick={() => setLfo1(l => ({ ...l, shape: s }))}>
                    {s.toUpperCase()}
                  </Toggle>
                ))}
              </div>
            </div>
          </div>
          {/* Delay Bus (shared) */}
          <div>
            <div style={sty.sectionTitle}>DELAY BUS</div>
            <div style={{ display: "flex", gap: 10 }}>
              <Knob value={delayBus.time} min={0} max={1} onChange={v => setDelayBus(d => ({ ...d, time: v }))}
                label="TIME" displayValue={(delayBus.time * 1000).toFixed(0) + "ms"} />
              <Knob value={delayBus.feedback} min={0} max={0.95} onChange={v => setDelayBus(d => ({ ...d, feedback: v }))}
                label="FB" displayValue={(delayBus.feedback * 100).toFixed(0) + "%"} />
            </div>
          </div>
          {/* Reverb Bus (shared) */}
          <div>
            <div style={sty.sectionTitle}>REVERB BUS</div>
            <div style={{ display: "flex", gap: 10 }}>
              <Knob value={reverbBus.size} min={0} max={1} onChange={v => setReverbBus(r => ({ ...r, size: v }))}
                label="SIZE" displayValue={(reverbBus.size * 100).toFixed(0) + "%"} />
              <Knob value={reverbBus.mix} min={0} max={1} onChange={v => setReverbBus(r => ({ ...r, mix: v }))}
                label="MIX" displayValue={(reverbBus.mix * 100).toFixed(0) + "%"} />
            </div>
          </div>
        </div>
      </div>

      {/* PAD SECTION */}
      <div style={{ ...sty.section, padding: "8px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <span style={{ fontSize: 11, color: padMode === "group" ? "#00e5ff" : "#445566", cursor: "pointer" }}
              onClick={() => setPadMode("group")}>Group</span>
            <span style={{ fontSize: 11, color: padMode === "single" ? "#00e5ff" : "#445566", cursor: "pointer" }}
              onClick={() => setPadMode("single")}>Single</span>
          </div>
          {/* Scroll/Navigate arrows */}
          <div style={{ display: "flex", gap: 4 }}>
            {["»", "«", "≡", "◆", "∿", "↑", "↓", "▎▎", "⟵", "▎▎▎"].map((sym, i) => (
              <div key={i} style={{ width: 24, height: 24, borderRadius: 4, background: "rgba(0,229,255,0.06)",
                border: "1px solid #1a2535", display: "flex", alignItems: "center", justifyContent: "center",
                color: "#00e5ff", fontSize: 10, cursor: "pointer" }}>{sym}</div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 9, color: "#556677" }}>Start Key</span>
            <span style={{ color: "#00e5ff", fontSize: 12 }}>{startKey}</span>
          </div>
        </div>

        {/* 16 PADS */}
        <div style={sty.padGrid}>
          {pads.map((pad, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={sty.pad(pad.active, pad.assigned, i === selectedPad)}
                onMouseDown={() => { setSelectedPad(i); triggerNote(60 + i, 0.8); }}
                onMouseUp={() => releaseNote(60 + i)}
                onMouseLeave={() => { if (pad.active) releaseNote(60 + i); }}>
                <svg width="20" height="12" viewBox="0 0 20 12" style={{ opacity: pad.assigned ? 0.6 : 0.15 }}>
                  <path d="M2 6 C2 2, 6 2, 10 6 C14 2, 18 2, 18 6 C18 10, 14 10, 10 6 C6 10, 2 10, 2 6Z"
                    fill="none" stroke={pad.active ? "#0d1117" : "#00e5ff"} strokeWidth="1.5" />
                </svg>
              </div>
              <span style={{ fontSize: 8, color: pad.active ? "#00e5ff" : "#334455" }}>{pad.id}</span>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div onClick={() => {}} style={{
              width: 24, height: 24, borderRadius: "50%", border: "2px solid #ff336644",
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#ff3366" }} />
            </div>
            <span style={{ fontSize: 9, color: "#ff3366" }}>Follow</span>
            <span style={{ fontSize: 12, color: "#ff3366", marginLeft: 8 }}>1/4</span>
            <span style={{ fontSize: 9, color: "#556677" }}>Quantize</span>
          </div>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span style={{ fontSize: 8, color: "#556677" }}>C3</span>
            <div style={{ width: 200, height: 1, background: "#1a2535" }} />
            <span style={{ fontSize: 8, color: "#556677" }}>C4</span>
            <div style={{ width: 200, height: 1, background: "#1a2535" }} />
            <span style={{ fontSize: 8, color: "#556677" }}>C5</span>
          </div>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span style={{ color: "#00e5ff", fontSize: 14, fontWeight: 500 }}>{tonalityLock.split(" ")[0]}</span>
            <span style={{ color: "#00e5ff", fontSize: 10 }}>{tonalityLock.split(" ")[1]}</span>
            <span style={{ fontSize: 8, color: "#556677" }}>Tonality</span>
          </div>
        </div>
      </div>

      {/* MIDI KEYBOARD */}
      <div style={{ ...sty.section, padding: "8px 16px", background: "linear-gradient(180deg, #0a0e14 0%, #060a0f 100%)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%",
              background: midiConnected ? "#00ff88" : "#ff3366",
              boxShadow: `0 0 6px ${midiConnected ? "#00ff8866" : "#ff336666"}`,
              animation: midiConnected ? "none" : "pulse 2s infinite" }} />
            <span style={{ fontSize: 9, color: midiConnected ? "#00ff88" : "#556677" }}>
              {midiConnected ? midiDeviceName || "MIDI Connected" : "No MIDI Device"}
            </span>
            <Toggle active={midiLearn} onClick={() => { setMidiLearn(!midiLearn); setMidiLog([]); }}>MIDI Learn</Toggle>
            {midiConnected && (
              <span style={{ fontSize: 8, color: "#334455" }}>
                Pads: 36-51 (ch10) • Keys: C3-D#4 • Knobs: CC21-28
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {/* Pitch Wheel — reactive */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <div style={{ width: 20, height: 50, borderRadius: 4, background: "#0d1520", border: "1px solid #1a2535",
                position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 2, right: 2, height: 4, borderRadius: 2,
                  background: pitchBend !== 0 ? "#00e5ff" : "#1a3040",
                  top: `${50 - pitchBend * 50}%`, transform: "translateY(-50%)",
                  boxShadow: pitchBend !== 0 ? "0 0 6px #00e5ff66" : "none", transition: "all 0.05s" }} />
                <div style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 1, background: "#1a3040" }} />
              </div>
              <span style={{ fontSize: 7, color: pitchBend !== 0 ? "#00e5ff" : "#445566" }}>PITCH</span>
            </div>
            {/* Mod Wheel — reactive */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <div style={{ width: 20, height: 50, borderRadius: 4, background: "#0d1520", border: "1px solid #1a2535",
                position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", bottom: 0, left: 0, right: 0,
                  height: `${modWheel * 100}%`,
                  background: "linear-gradient(0deg, #00e5ff, #00e5ff88)",
                  boxShadow: modWheel > 0 ? "0 0 8px #00e5ff44" : "none", transition: "height 0.05s" }} />
              </div>
              <span style={{ fontSize: 7, color: modWheel > 0 ? "#00e5ff" : "#445566" }}>MOD</span>
            </div>
          </div>
        </div>

        {/* MIDI Learn Log */}
        {midiLearn && midiLog.length > 0 && (
          <div style={{ marginBottom: 6, padding: "4px 8px", background: "rgba(0,229,255,0.04)",
            border: "1px solid #00e5ff22", borderRadius: 4, maxHeight: 60, overflow: "auto" }}>
            {midiLog.map((entry, i) => (
              <div key={i} style={{ fontSize: 8, fontFamily: "monospace", color: i === 0 ? "#00e5ff" : "#334455" }}>
                {entry}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "center", overflow: "hidden", paddingBottom: 4 }}>
          {pianoKeys.map(k => {
            const isInPadRange = k.note >= 60 && k.note < 76;
            const isInDrumPadRange = k.note >= 36 && k.note < 52;
            const isActive = activeKeys.has(k.note);
            return (
              <div key={k.note} style={{
                ...sty.key(k.isBlack, isActive),
                background: isActive ? "#00e5ff"
                  : isInPadRange ? (k.isBlack ? "linear-gradient(180deg, #0a3040, #061520)" : "linear-gradient(180deg, #1a3545, #0d2030)")
                  : isInDrumPadRange ? (k.isBlack ? "linear-gradient(180deg, #302a0a, #201500)" : "linear-gradient(180deg, #3a3520, #2a2510)")
                  : sty.key(k.isBlack, false).background,
                borderColor: isActive ? "#00e5ff"
                  : isInPadRange ? "#00e5ff33"
                  : isInDrumPadRange ? "#ffc80033"
                  : sty.key(k.isBlack, false).borderColor
              }}
                onMouseDown={() => triggerNote(k.note, 0.8)}
                onMouseUp={() => releaseNote(k.note)}
                onMouseLeave={() => { if (activeKeys.has(k.note)) releaseNote(k.note); }}>
                {!k.isBlack && k.name.startsWith("C") && (
                  <span style={{ position: "absolute", bottom: 3, fontSize: 7, color: isActive ? "#0d1117" : "#556677",
                    width: "100%", textAlign: "center" }}>{k.name}</span>
                )}
              </div>
            );
          })}
        </div>
        {/* Zone highlight bar — cyan=keys zone, amber=drum pad zone */}
        <div style={{ display: "flex", justifyContent: "center", marginTop: 4 }}>
          <div style={{ display: "flex", height: 4, borderRadius: 2, overflow: "hidden", width: "100%" }}>
            {pianoKeys.filter(k => !k.isBlack).map(k => (
              <div key={k.note} style={{
                flex: 1,
                background: (k.note >= 60 && k.note < 76) ? "#00e5ff44"
                  : (k.note >= 36 && k.note < 52) ? "#ffc80033"
                  : "transparent"
              }} />
            ))}
          </div>
        </div>
      </div>

      {/* FOOTER / STATUS */}
      <div style={{ padding: "6px 16px", display: "flex", justifyContent: "space-between",
        fontSize: 8, color: "#334455", borderTop: "1px solid #1a2030" }}>
        <span>LEAP Sampler Engine • Web Audio API</span>
        <span>Keys: Z-M / A-K • Launchkey Pads: 36-51 • Knobs: CC21-28 → Selected Pad</span>
        <span>{buffer ? `${buffer.duration.toFixed(2)}s • ${buffer.sampleRate}Hz` : "No buffer"}</span>
      </div>
    </div>
  );
}
