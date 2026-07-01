// Offline (non-realtime) analysis. Decodes a recorded buffer, slices it into
// overlapping frames with large FFT windows, finds onsets via spectral flux,
// aggregates each segment's chroma with a median (rejecting transients), and
// classifies each segment with the shared template matcher. Returns labeled
// time segments for the timeline and MIDI export.

const ANALYSIS_FFT = 8192;   // large window -> fine frequency resolution
const ANALYSIS_HOP = 2048;   // 75% overlap
const MIN_SEGMENT_SEC = 0.14; // merge anything shorter into a neighbor

/**
 * Fold a linear magnitude spectrum into a 12-bin chroma vector.
 *
 * @param {Float32Array} mag - Linear magnitudes (bins 0..N/2-1).
 * @param {number} sampleRate - Sample rate in Hz.
 * @param {number} fftSize - FFT window size.
 * @returns {Float32Array} A 12-bin chroma vector.
 */
function chromaFromMagnitude(mag, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const start = Math.max(1, Math.floor(65 / binHz));
  const end = Math.min(mag.length - 1, Math.ceil(2000 / binHz));
  let maxMag = 0;
  for (let i = start; i <= end; i++) if (mag[i] > maxMag) maxMag = mag[i];
  const chroma = new Float32Array(12);
  if (maxMag <= 0) return chroma;
  const floor = maxMag * 0.02;
  for (let i = start; i <= end; i++) {
    if (mag[i] < floor) continue;
    chroma[freqToPitchClass(i * binHz)] += mag[i];
  }
  return chroma;
}

/**
 * Lowest prominent peak of a magnitude spectrum, for the bass note.
 *
 * @param {Float32Array} mag - Linear magnitudes.
 * @param {number} sampleRate - Sample rate in Hz.
 * @param {number} fftSize - FFT window size.
 * @returns {{pitchClass: number, freq: number} | null} Bass pitch class + freq, or null.
 */
function bassFromMagnitude(mag, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  let maxMag = 0;
  for (let i = 1; i < mag.length; i++) if (mag[i] > maxMag) maxMag = mag[i];
  if (maxMag <= 0) return null;
  const thresh = maxMag * 0.15;
  const start = Math.max(2, Math.floor(55 / binHz));
  const end = Math.min(mag.length - 2, Math.ceil(600 / binHz));
  for (let i = start; i <= end; i++) {
    if (mag[i] >= thresh && mag[i] >= mag[i - 1] && mag[i] >= mag[i + 1]) {
      return { pitchClass: freqToPitchClass(i * binHz), freq: i * binHz };
    }
  }
  return null;
}

/** Frequency of the loudest bin in the musical range (for octave estimates). */
function dominantFreq(mag, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const start = Math.max(1, Math.floor(65 / binHz));
  const end = Math.min(mag.length - 1, Math.ceil(2000 / binHz));
  let maxMag = 0, freq = 0;
  for (let i = start; i <= end; i++) {
    if (mag[i] > maxMag) { maxMag = mag[i]; freq = i * binHz; }
  }
  return freq;
}

/**
 * Compute per-frame features across the whole signal.
 *
 * @param {Float32Array} data - Mono PCM samples.
 * @param {number} sampleRate - Sample rate in Hz.
 * @returns {Array<{time:number, chroma:Float32Array, bassPc:number, domFreq:number, flux:number, energy:number}>}
 */
function computeFrames(data, sampleRate) {
  const N = ANALYSIS_FFT;
  const hop = ANALYSIS_HOP;
  const win = hannWindow(N);
  const frames = [];
  const buf = new Float32Array(N);
  let prevMag = null;

  for (let start = 0; start + N <= data.length; start += hop) {
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const s = data[start + i] * win[i];
      buf[i] = s;
      energy += s * s;
    }
    const mag = magnitudeSpectrum(buf);

    let flux = 0;
    if (prevMag) {
      for (let k = 0; k < mag.length; k++) {
        const d = mag[k] - prevMag[k];
        if (d > 0) flux += d;
      }
    }
    prevMag = mag;

    const bass = bassFromMagnitude(mag, sampleRate, N);
    frames.push({
      time: start / sampleRate,
      chroma: chromaFromMagnitude(mag, sampleRate, N),
      bassPc: bass ? bass.pitchClass : -1,
      domFreq: dominantFreq(mag, sampleRate, N),
      flux,
      energy: Math.sqrt(energy / N),
    });
  }
  return frames;
}

/**
 * Onset frame indices from spectral flux, via adaptive peak-picking.
 *
 * @param {Array<{flux:number}>} frames
 * @returns {number[]} Sorted frame indices where a new segment likely begins.
 */
function detectOnsets(frames) {
  const n = frames.length;
  if (n === 0) return [];
  let mx = 0;
  for (const f of frames) if (f.flux > mx) mx = f.flux;
  if (mx <= 0) return [];

  const norm = frames.map((f) => f.flux / mx);
  const onsets = [];
  const W = 8, delta = 0.12, minGap = 4;
  let last = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) { sum += norm[j]; count++; }
    const mean = sum / count;
    if (norm[i] > mean + delta && norm[i] >= norm[i - 1] && norm[i] >= norm[i + 1] && i - last >= minGap) {
      onsets.push(i);
      last = i;
    }
  }
  return onsets;
}

/** Per-bin median chroma across a set of frames. */
function medianChroma(frames) {
  const out = new Float32Array(12);
  const tmp = [];
  for (let b = 0; b < 12; b++) {
    tmp.length = 0;
    for (const f of frames) tmp.push(f.chroma[b]);
    tmp.sort((a, b2) => a - b2);
    out[b] = tmp.length ? tmp[tmp.length >> 1] : 0;
  }
  return out;
}

/** Most common bass pitch class across frames (ignoring "none"). */
function majorityBass(frames) {
  const counts = {};
  for (const f of frames) if (f.bassPc >= 0) counts[f.bassPc] = (counts[f.bassPc] || 0) + 1;
  let best = -1, bc = 0;
  for (const k in counts) if (counts[k] > bc) { bc = counts[k]; best = +k; }
  return best;
}

/** Octave number of pitch class `pc` nearest a reference frequency. */
function octaveForPitchClass(pc, refFreq) {
  const refMidi = refFreq > 0 ? freqToMidi(refFreq) : 60;
  let bestMidi = 60, bestDiff = Infinity;
  for (let m = 12; m <= 108; m++) {
    if (((m % 12) + 12) % 12 !== pc) continue;
    const d = Math.abs(m - refMidi);
    if (d < bestDiff) { bestDiff = d; bestMidi = m; }
  }
  return { octave: Math.floor(bestMidi / 12) - 1, midi: bestMidi };
}

/**
 * Classify one segment (aggregated frames) into a labeled result with the data
 * needed for display and MIDI. Uses the live classifier + current settings.
 *
 * @param {Array} segFrames - Frames belonging to the segment.
 * @returns {object} A segment result: { type, display, sub, midi, root?, ... }.
 */
function classifySegment(segFrames) {
  const chroma = medianChroma(segFrames);
  const { best, sim } = classifyChroma(chroma);
  const refFreq = segFrames[Math.floor(segFrames.length / 2)].domFreq;

  if (!best || sim < settings.confidence) {
    return { type: "none", display: "—", sub: "", midi: [] };
  }

  if (best.type === "note") {
    const { octave, midi } = octaveForPitchClass(best.root, refFreq);
    return {
      type: "note",
      display: NOTE_NAMES[best.root] + octave,
      sub: "single note",
      midi: [midi],
    };
  }

  // chord
  const root = best.root, quality = best.quality;
  let bass = null, inversion = 0;
  if (settings.inversions) {
    const bassPc = majorityBass(segFrames);
    if (bassPc >= 0 && bassPc !== root) {
      const idx = quality.intervals.findIndex((iv) => (root + iv) % 12 === bassPc);
      if (idx > 0) { bass = bassPc; inversion = idx; }
    }
  }
  const rootName = NOTE_NAMES[root];
  const slash = bass != null ? "/" + NOTE_NAMES[bass] : "";
  const midi = quality.intervals.map((iv) => 48 + root + iv); // voiced around C3
  return {
    type: "chord",
    display: rootName + quality.symbol + slash,
    sub: rootName + " " + quality.name + (inversion ? " · " + inversionName(inversion) : ""),
    root, quality, bass, inversion,
    notes: chordToneNames(root, quality),
    midi,
  };
}

/** A stable label key so adjacent identical segments can be merged. */
function segmentKey(seg) {
  if (seg.type === "none") return "none";
  if (seg.type === "note") return "note:" + seg.display;
  return "chord:" + seg.root + ":" + seg.quality.name + ":" + (seg.bass ?? "");
}

/**
 * Full offline analysis of a decoded recording.
 *
 * @param {AudioBuffer} audioBuffer - The decoded recording.
 * @returns {{duration:number, segments:Array<object>}} Labeled segments with
 *   `start`/`end` times (seconds) plus display/MIDI data.
 */
function analyzeRecording(audioBuffer) {
  const sr = audioBuffer.sampleRate;
  const data = audioBuffer.getChannelData(0);
  const duration = audioBuffer.duration;

  const frames = computeFrames(data, sr);
  if (frames.length === 0) return { duration, segments: [] };

  const bounds = [0, ...detectOnsets(frames), frames.length];
  const uniq = [...new Set(bounds)].sort((a, b) => a - b);

  // Classify each inter-onset span.
  let segments = [];
  for (let s = 0; s < uniq.length - 1; s++) {
    const a = uniq[s], b = uniq[s + 1];
    if (b <= a) continue;
    const segFrames = frames.slice(a, b);
    const start = frames[a].time;
    const end = b < frames.length ? frames[b].time : duration;
    const result = classifySegment(segFrames);
    segments.push({ start, end, ...result, key: undefined });
  }
  for (const seg of segments) seg.key = segmentKey(seg);

  // Merge adjacent segments with the same label.
  segments = mergeAdjacent(segments);
  // Absorb too-short segments into a neighbor, then merge again.
  segments = absorbShort(segments);
  segments = mergeAdjacent(segments);

  return { duration, segments };
}

/** Merge consecutive segments that share a label key. */
function mergeAdjacent(segments) {
  const out = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.key === seg.key) prev.end = seg.end;
    else out.push({ ...seg });
  }
  return out;
}

/** Merge any sub-threshold segment into the neighbor it best belongs to. */
function absorbShort(segments) {
  if (segments.length <= 1) return segments;
  const out = segments.map((s) => ({ ...s }));
  for (let i = 0; i < out.length; i++) {
    if (out[i].end - out[i].start >= MIN_SEGMENT_SEC) continue;
    const prev = out[i - 1], next = out[i + 1];
    if (prev) prev.end = out[i].end;
    else if (next) next.start = out[i].start;
    out.splice(i, 1);
    i--;
  }
  return out;
}
