// Offline (non-realtime) analysis. Decodes a recorded buffer, slices it into
// overlapping frames with large FFT windows, finds onsets via spectral flux,
// aggregates each segment's chroma with a median (rejecting transients), and
// classifies each segment with the shared template matcher. Returns labeled
// time segments for the timeline and MIDI export.

// Live-adjustable knobs for offline (record-mode) analysis. Wired to the
// "Recording analysis" settings and re-applied on every re-analyze.
const recSettings = {
  fftSize: 8192,          // analysis window (power of two): 4096 | 8192 | 16384
  overlap: 0.75,          // frame overlap; hop = fftSize * (1 - overlap)
  onsetSensitivity: 0.12, // spectral-flux threshold above the local mean
  minSegment: 0.14,       // shortest chord segment (s) before it's absorbed
  detectMelody: true,     // extract a top-voice melody lane
  melodyMinLevel: 0.12,   // min peak strength (vs. loudest bin) for a melody note
  melodySmooth: 2,        // median-filter half-window (frames) for the melody
  melodyMinSeg: 0.09,     // shortest melody note (s) before it's absorbed
};

const MELODY_MIN_HZ = 160;  // ~E3
const MELODY_MAX_HZ = 1300; // ~E6

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
  const knee = 350; // de-emphasize high frequencies so the harmony (which sits
  for (let i = start; i <= end; i++) {   // lower) outweighs a loud melody note
    if (mag[i] < floor) continue;
    const f = i * binHz;
    const w = f <= knee ? 1 : (knee / f) * (knee / f);
    chroma[freqToPitchClass(f)] += mag[i] * w;
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
 * Estimate the melody note as the "top voice": the highest fundamental peak in
 * the melody register. Peaks are found, then harmonics of lower peaks are
 * suppressed so the surviving highest peak is a real fundamental, not an
 * overtone of the harmony below it.
 *
 * @param {Float32Array} mag - Linear magnitude spectrum.
 * @param {number} sampleRate - Sample rate in Hz.
 * @param {number} fftSize - FFT window size.
 * @returns {number} MIDI note number of the melody, or -1 if none is confident.
 */
function melodyPitch(mag, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  let maxMag = 0;
  for (let i = 1; i < mag.length; i++) if (mag[i] > maxMag) maxMag = mag[i];
  if (maxMag <= 0) return -1;

  const thresh = maxMag * recSettings.melodyMinLevel;
  const start = Math.max(2, Math.floor(MELODY_MIN_HZ / binHz));
  const end = Math.min(mag.length - 2, Math.ceil(MELODY_MAX_HZ / binHz));

  // Predominant-F0: the loudest peak in the melody register. A note that
  // coincides with a chord harmonic can't be told apart from a single mic
  // channel, so we take the most salient upper voice rather than the highest.
  let bestFreq = -1, bestMag = thresh;
  for (let i = start; i <= end; i++) {
    if (mag[i] >= bestMag && mag[i] >= mag[i - 1] && mag[i] >= mag[i + 1]) {
      const a = mag[i - 1], b = mag[i], c = mag[i + 1];
      const denom = a - 2 * b + c;
      const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
      bestMag = mag[i];
      bestFreq = (i + shift) * binHz;
    }
  }
  return bestFreq > 0 ? Math.round(freqToMidi(bestFreq)) : -1;
}

/**
 * Compute per-frame features across the whole signal.
 *
 * @param {Float32Array} data - Mono PCM samples.
 * @param {number} sampleRate - Sample rate in Hz.
 * @returns {Array<object>} Per-frame features (time, chroma, bass, melody, flux…).
 */
function computeFrames(data, sampleRate) {
  const N = recSettings.fftSize;
  const hop = Math.max(256, Math.round(N * (1 - recSettings.overlap)));
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
      melodyMidi: recSettings.detectMelody ? melodyPitch(mag, sampleRate, N) : -1,
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
  const W = 8, delta = recSettings.onsetSensitivity, minGap = 4;
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
 * Median-filter an integer sequence (values may include -1 for "none"),
 * smoothing away single-frame melody jumps and octave slips.
 *
 * @param {number[]} arr - The sequence.
 * @param {number} half - Half-window size in samples.
 * @returns {number[]} The filtered sequence.
 */
function medianFilterInt(arr, half) {
  if (half <= 0) return arr.slice();
  const out = new Array(arr.length);
  const win = [];
  for (let i = 0; i < arr.length; i++) {
    win.length = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) win.push(arr[j]);
    win.sort((a, b) => a - b);
    out[i] = win[win.length >> 1];
  }
  return out;
}

/**
 * Build melody note segments from per-frame top-voice pitches: median-smooth,
 * run-length encode into notes (with -1 as rests), then absorb tiny segments.
 *
 * @param {Array<{time:number, melodyMidi:number}>} frames
 * @param {number} duration - Recording length in seconds.
 * @returns {Array<object>} Melody segments with start/end and note display/MIDI.
 */
function segmentMelody(frames, duration) {
  const smooth = medianFilterInt(frames.map((f) => f.melodyMidi), recSettings.melodySmooth);

  let runs = [];
  let startIdx = 0;
  for (let i = 1; i <= smooth.length; i++) {
    if (i === smooth.length || smooth[i] !== smooth[startIdx]) {
      const midi = smooth[startIdx];
      const start = frames[startIdx].time;
      const end = i < frames.length ? frames[i].time : duration;
      if (midi < 0) {
        runs.push({ start, end, type: "none", midi: [], key: "none" });
      } else {
        const pc = ((midi % 12) + 12) % 12;
        const name = NOTE_NAMES[pc] + (Math.floor(midi / 12) - 1);
        runs.push({ start, end, type: "note", display: name, sub: "melody " + name, midi: [midi], key: "m:" + midi });
      }
      startIdx = i;
    }
  }

  runs = mergeAdjacent(runs);
  runs = absorbShort(runs, recSettings.melodyMinSeg);
  return mergeAdjacent(runs);
}

/**
 * Full offline analysis of a decoded recording.
 *
 * @param {AudioBuffer} audioBuffer - The decoded recording.
 * @returns {{duration:number, segments:Array<object>, melody:Array<object>}}
 *   The chord/note `segments` and (if enabled) the top-voice `melody` segments.
 */
function analyzeRecording(audioBuffer) {
  const sr = audioBuffer.sampleRate;
  const data = audioBuffer.getChannelData(0);
  const duration = audioBuffer.duration;

  const frames = computeFrames(data, sr);
  if (frames.length === 0) return { duration, segments: [], melody: [] };

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

  const melody = recSettings.detectMelody ? segmentMelody(frames, duration) : [];
  return { duration, segments, melody };
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
function absorbShort(segments, min = recSettings.minSegment) {
  if (segments.length <= 1) return segments;
  const out = segments.map((s) => ({ ...s }));
  for (let i = 0; i < out.length; i++) {
    if (out[i].end - out[i].start >= min) continue;
    const prev = out[i - 1], next = out[i + 1];
    if (prev) prev.end = out[i].end;
    else if (next) next.start = out[i].start;
    out.splice(i, 1);
    i--;
  }
  return out;
}
