/**
 * SamplerWorkletProcessor — AudioWorklet processor for LEAP Sampler
 *
 * Handles sample-accurate playback, ADSR envelope, and biquad filter
 * entirely on the audio thread. Receives buffer data and voice commands
 * via MessagePort.
 *
 * Signal chain (per sample): BufferRead → BiquadFilter → ADSR Envelope → Output
 */

// ─── Biquad filter coefficients (Direct Form II Transposed) ───
function computeBiquadCoeffs(type, freq, Q, sampleRate) {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const sinW0 = Math.sin(w0);
  const cosW0 = Math.cos(w0);
  const alpha = sinW0 / (2 * Q);

  let b0, b1, b2, a0, a1, a2;

  switch (type) {
    case "highpass":
      b0 = (1 + cosW0) / 2;
      b1 = -(1 + cosW0);
      b2 = (1 + cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    case "bandpass":
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    case "notch":
      b0 = 1;
      b1 = -2 * cosW0;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    case "lowpass":
    default:
      b0 = (1 - cosW0) / 2;
      b1 = 1 - cosW0;
      b2 = (1 - cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

// ─── ADSR envelope states ───
const ENV_IDLE = 0;
const ENV_ATTACK = 1;
const ENV_DECAY = 2;
const ENV_SUSTAIN = 3;
const ENV_RELEASE = 4;

class SamplerWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // Buffer storage (set via message)
    this._bufferData = null; // Float32Array[] per channel
    this._bufferChannels = 0;
    this._bufferLength = 0;

    // Playback state
    this._playbackPos = 0; // Current position in samples (float for fractional speed)
    this._startSample = 0; // Slice start in samples
    this._endSample = 0; // Slice end in samples
    this._speed = 1;
    this._reverse = false;
    this._loop = false;
    this._playing = false;
    this._finished = false;
    this._velocity = 1;

    // ADSR state
    this._envState = ENV_IDLE;
    this._envLevel = 0;
    this._attack = 0.005; // seconds
    this._decay = 0.1;
    this._sustain = 0.7;
    this._release = 0.2;
    this._attackRate = 0; // per-sample increment (computed on play)
    this._decayRate = 0;
    this._releaseRate = 0;

    // Biquad filter state (Direct Form II Transposed)
    this._filterType = "lowpass";
    this._filterFreq = 8000;
    this._filterQ = 1;
    this._filterCoeffs = null;
    // Per-channel filter memory (z-1, z-2)
    this._filterZ1 = [];
    this._filterZ2 = [];

    // Drive/saturation
    this._driveAmount = 0; // 0 = clean, 1 = full saturation
    this._driveCurve = "soft"; // "soft", "hard", "clip"

    // Parse processor options if provided
    if (options && options.processorOptions) {
      this._applyOptions(options.processorOptions);
    }

    this.port.onmessage = (e) => this._handleMessage(e.data);
  }

  _applyOptions(opts) {
    if (opts.speed !== undefined) this._speed = opts.speed;
    if (opts.reverse !== undefined) this._reverse = opts.reverse;
    if (opts.loop !== undefined) this._loop = opts.loop;
    if (opts.velocity !== undefined) this._velocity = opts.velocity;
    if (opts.attack !== undefined) this._attack = opts.attack;
    if (opts.decay !== undefined) this._decay = opts.decay;
    if (opts.sustain !== undefined) this._sustain = opts.sustain;
    if (opts.release !== undefined) this._release = opts.release;
    if (opts.filterType !== undefined) this._filterType = opts.filterType;
    if (opts.filterFreq !== undefined) this._filterFreq = opts.filterFreq;
    if (opts.filterQ !== undefined) this._filterQ = opts.filterQ;
    if (opts.driveAmount !== undefined) this._driveAmount = opts.driveAmount;
    if (opts.driveCurve !== undefined) this._driveCurve = opts.driveCurve;
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case "loadBuffer": {
        // Receive buffer channel data as Float32Arrays
        this._bufferData = msg.channelData; // Array of Float32Array
        this._bufferChannels = msg.channelData.length;
        this._bufferLength = msg.channelData[0].length;
        // Initialize per-channel filter memory
        this._filterZ1 = new Array(this._bufferChannels).fill(0);
        this._filterZ2 = new Array(this._bufferChannels).fill(0);
        break;
      }
      case "play": {
        this._startSample = msg.startSample || 0;
        this._endSample = msg.endSample || this._bufferLength;
        if (msg.params) this._applyOptions(msg.params);

        // Compute ADSR rates
        const sr = sampleRate;
        const attackSamples = Math.max(1, this._attack * sr);
        const decaySamples = Math.max(1, this._decay * sr);
        const releaseSamples = Math.max(1, this._release * sr);
        this._attackRate = this._velocity / attackSamples;
        this._decayRate =
          ((this._velocity - this._sustain * this._velocity) / decaySamples);
        this._releaseRate = 0; // Computed at release time from current level

        // Compute filter coefficients
        this._filterCoeffs = computeBiquadCoeffs(
          this._filterType,
          Math.min(this._filterFreq, sr / 2 - 1),
          Math.max(0.001, this._filterQ),
          sr
        );

        // Reset filter memory
        for (let ch = 0; ch < this._bufferChannels; ch++) {
          this._filterZ1[ch] = 0;
          this._filterZ2[ch] = 0;
        }

        // Set playback position
        if (this._reverse) {
          this._playbackPos = this._endSample - 1;
        } else {
          this._playbackPos = this._startSample;
        }

        this._envState = ENV_ATTACK;
        this._envLevel = 0;
        this._playing = true;
        this._finished = false;
        break;
      }
      case "release": {
        if (this._envState !== ENV_IDLE && this._envState !== ENV_RELEASE) {
          this._envState = ENV_RELEASE;
          const releaseSamples = Math.max(1, this._release * sampleRate);
          this._releaseRate = this._envLevel / releaseSamples;
        }
        break;
      }
      case "stop": {
        this._playing = false;
        this._envState = ENV_IDLE;
        this._envLevel = 0;
        this._finished = true;
        break;
      }
      case "updateParams": {
        if (msg.params) {
          const prev = {
            filterType: this._filterType,
            filterFreq: this._filterFreq,
            filterQ: this._filterQ,
          };
          this._applyOptions(msg.params);
          // Recompute filter if changed
          if (
            this._filterType !== prev.filterType ||
            this._filterFreq !== prev.filterFreq ||
            this._filterQ !== prev.filterQ
          ) {
            this._filterCoeffs = computeBiquadCoeffs(
              this._filterType,
              Math.min(this._filterFreq, sampleRate / 2 - 1),
              Math.max(0.001, this._filterQ),
              sampleRate
            );
          }
        }
        break;
      }
    }
  }

  // Read a sample from the buffer with linear interpolation
  _readSample(ch, pos) {
    if (!this._bufferData || ch >= this._bufferChannels) return 0;
    const data = this._bufferData[ch];
    const idx = Math.floor(pos);
    const frac = pos - idx;
    if (idx < 0 || idx >= this._bufferLength) return 0;
    const s0 = data[idx];
    const s1 = idx + 1 < this._bufferLength ? data[idx + 1] : s0;
    return s0 + (s1 - s0) * frac;
  }

  // Apply biquad filter (Direct Form II Transposed) to one sample
  _applyFilter(sample, ch) {
    const c = this._filterCoeffs;
    if (!c) return sample;
    const z1 = this._filterZ1[ch];
    const z2 = this._filterZ2[ch];
    const out = c.b0 * sample + z1;
    this._filterZ1[ch] = c.b1 * sample - c.a1 * out + z2;
    this._filterZ2[ch] = c.b2 * sample - c.a2 * out;
    return out;
  }

  // Apply drive/saturation to a sample
  _applyDrive(sample) {
    if (this._driveAmount <= 0) return sample;
    const gain = 1 + this._driveAmount * 10; // Up to 11x input gain
    const driven = sample * gain;
    switch (this._driveCurve) {
      case "hard":
        return Math.max(-1, Math.min(1, driven)) * (1 / gain + (1 - 1 / gain));
      case "clip":
        return Math.max(-1, Math.min(1, driven));
      case "soft":
      default: {
        // tanh soft clipping
        const out = Math.tanh(driven);
        // Compensate output level
        return out * (1 / Math.tanh(gain));
      }
    }
  }

  // Advance ADSR envelope by one sample, returns envelope level
  _advanceEnvelope() {
    switch (this._envState) {
      case ENV_ATTACK:
        this._envLevel += this._attackRate;
        if (this._envLevel >= this._velocity) {
          this._envLevel = this._velocity;
          this._envState = ENV_DECAY;
        }
        break;
      case ENV_DECAY: {
        this._envLevel -= this._decayRate;
        const sustainLevel = this._sustain * this._velocity;
        if (this._envLevel <= sustainLevel) {
          this._envLevel = sustainLevel;
          this._envState = ENV_SUSTAIN;
        }
        break;
      }
      case ENV_SUSTAIN:
        // Hold at sustain level until release
        break;
      case ENV_RELEASE:
        this._envLevel -= this._releaseRate;
        if (this._envLevel <= 0) {
          this._envLevel = 0;
          this._envState = ENV_IDLE;
          this._playing = false;
          this._finished = true;
        }
        break;
      case ENV_IDLE:
      default:
        this._envLevel = 0;
        break;
    }
    return this._envLevel;
  }

  // Advance playback position, handle loop/end
  _advancePosition() {
    if (this._reverse) {
      this._playbackPos -= this._speed;
      if (this._playbackPos < this._startSample) {
        if (this._loop) {
          this._playbackPos =
            this._endSample -
            1 -
            (this._startSample - this._playbackPos);
          if (this._playbackPos < this._startSample) {
            this._playbackPos = this._endSample - 1;
          }
        } else {
          this._playing = false;
          this._finished = true;
        }
      }
    } else {
      this._playbackPos += this._speed;
      if (this._playbackPos >= this._endSample) {
        if (this._loop) {
          this._playbackPos =
            this._startSample +
            (this._playbackPos - this._endSample);
          if (this._playbackPos >= this._endSample) {
            this._playbackPos = this._startSample;
          }
        } else {
          this._playing = false;
          this._finished = true;
        }
      }
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output.length) return !this._finished;

    const numChannels = output.length;
    const blockSize = output[0].length;

    if (!this._playing || !this._bufferData) {
      // Output silence
      for (let ch = 0; ch < numChannels; ch++) {
        output[ch].fill(0);
      }
      // If finished after release, signal the main thread and stop processing
      if (this._finished) {
        this.port.postMessage({ type: "ended" });
        return false;
      }
      return true;
    }

    for (let i = 0; i < blockSize; i++) {
      // Check if still playing
      if (!this._playing) {
        // Fill remaining with silence
        for (let ch = 0; ch < numChannels; ch++) {
          output[ch][i] = 0;
        }
        continue;
      }

      // Advance envelope
      const envLevel = this._advanceEnvelope();

      // If envelope finished, stop
      if (this._envState === ENV_IDLE && this._finished) {
        for (let ch = 0; ch < numChannels; ch++) {
          output[ch][i] = 0;
        }
        continue;
      }

      // Read and process each channel
      for (let ch = 0; ch < numChannels; ch++) {
        // Read from buffer (map output channels to available buffer channels)
        const bufCh = ch < this._bufferChannels ? ch : 0;
        let sample = this._readSample(bufCh, this._playbackPos);

        // Apply biquad filter
        sample = this._applyFilter(sample, bufCh);

        // Apply drive/saturation
        sample = this._applyDrive(sample);

        // Apply envelope
        sample *= envLevel;

        output[ch][i] = sample;
      }

      // Advance playback position
      this._advancePosition();
    }

    if (this._finished) {
      this.port.postMessage({ type: "ended" });
      return false;
    }

    return true;
  }
}

registerProcessor("sampler-worklet-processor", SamplerWorkletProcessor);
