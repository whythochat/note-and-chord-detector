// Chord/note classification by chroma + harmonic-template matching.
//
// Instead of trying to peak-pick each individual note out of the spectrum
// (fragile: quiet chord tones get lost), we fold the whole spectrum into a
// 12-bin chroma vector and compare it, by cosine similarity, against a fixed
// bank of templates. Each candidate (every single note and every triad) has a
// template that models the harmonic series of its notes, so a lone note and a
// full triad produce distinguishable chroma shapes.

/**
 * Return an L2-normalized copy of a 12-element vector (so cosine similarity is
 * just a dot product). A zero vector is left unchanged.
 *
 * @param {ArrayLike<number>} v - A 12-element vector.
 * @returns {Float32Array} A new unit-length vector (length 12).
 */
function l2normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(12);
  for (let i = 0; i < 12; i++) out[i] = v[i] / s;
  return out;
}

const HARMONIC_COUNT = 6;

/**
 * The candidate bank, rebuilt by {@link buildTemplates}. Each entry is a
 * normalized 12-d chroma template:
 *   - `{ type: "note",  root, vec }` for each of the 12 single notes
 *   - `{ type: "chord", root, quality, vec }` for each root x triad quality
 * @type {Array<{type: string, root: number, quality?: object, vec: Float32Array}>}
 */
let CANDIDATES = [];

/**
 * (Re)build the template bank — 12 single notes plus 12 roots x 4 triad
 * qualities — and store it in {@link CANDIDATES}.
 *
 * Each note contributes its harmonic series, folded onto pitch classes, so a
 * lone note and a full triad yield distinguishable chroma shapes.
 *
 * @param {number} decay - Harmonic falloff. The amplitude of harmonic n is
 *   `decay^(n-1)`, so a higher value bakes more overtone energy (octaves,
 *   fifths, thirds) into the templates. Typically ~0.3..0.85.
 * @returns {void}
 */
function buildTemplates(decay) {
  const noteTemplate = (pc) => {
    const v = new Float32Array(12);
    for (let n = 1; n <= HARMONIC_COUNT; n++) {
      const semis = Math.round(12 * Math.log2(n));
      v[(pc + semis) % 12] += Math.pow(decay, n - 1);
    }
    return v;
  };

  const notes = [];
  for (let p = 0; p < 12; p++) notes.push(noteTemplate(p));

  const list = [];
  for (let p = 0; p < 12; p++) {
    list.push({ type: "note", root: p, vec: l2normalize(notes[p]) });
  }
  for (let root = 0; root < 12; root++) {
    for (const q of QUALITIES) {
      const v = new Float32Array(12);
      for (const iv of q.intervals) {
        const nt = notes[(root + iv) % 12];
        for (let i = 0; i < 12; i++) v[i] += nt[i];
      }
      list.push({ type: "chord", root, quality: q, vec: l2normalize(v) });
    }
  }
  CANDIDATES = list;
}

buildTemplates(0.6); // default harmonic influence

/**
 * Fold an FFT magnitude spectrum into a 12-bin chroma vector by summing the
 * linear magnitude of every bin (between ~65 Hz and ~2000 Hz, above the noise
 * floor) into its pitch class.
 *
 * @param {Float32Array} freqDb - Frequency-domain magnitudes in dB, as returned
 *   by `AnalyserNode.getFloatFrequencyData` (length = fftSize / 2).
 * @param {number} sampleRate - Sample rate in Hz (e.g. 44100).
 * @param {number} fftSize - The analyser's FFT size (e.g. 16384).
 * @returns {{chroma: Float32Array, dominantFreq: number} | null} The 12-bin
 *   chroma vector and the frequency (Hz) of the loudest bin, or `null` when the
 *   signal is too quiet to analyze.
 */
function computeChroma(freqDb, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const nBins = freqDb.length;
  const minHz = 65, maxHz = 2000;
  const start = Math.max(1, Math.floor(minHz / binHz));
  const end = Math.min(nBins - 1, Math.ceil(maxHz / binHz));

  let maxMag = 0, dominantFreq = 0;
  for (let i = start; i <= end; i++) {
    const m = Math.pow(10, freqDb[i] / 20);
    if (m > maxMag) { maxMag = m; dominantFreq = i * binHz; }
  }
  if (maxMag < 1e-4) return null;

  const floor = maxMag * 0.02; // ignore noise-floor bins
  const chroma = new Float32Array(12);
  for (let i = start; i <= end; i++) {
    const m = Math.pow(10, freqDb[i] / 20);
    if (m < floor) continue;
    chroma[freqToPitchClass(i * binHz)] += m;
  }
  return { chroma, dominantFreq };
}

/**
 * Find the template in {@link CANDIDATES} that best matches a chroma vector,
 * scored by cosine similarity.
 *
 * @param {Float32Array} chroma - A 12-bin chroma vector (need not be normalized).
 * @returns {{best: object, sim: number}} The winning candidate (a `CANDIDATES`
 *   entry — a single note or a chord) and its cosine similarity `sim` in
 *   roughly 0..1, where higher means a stronger match.
 */
function classifyChroma(chroma) {
  const c = l2normalize(chroma);
  let best = null, bestSim = -1;
  for (const cand of CANDIDATES) {
    let dot = 0;
    for (let i = 0; i < 12; i++) dot += c[i] * cand.vec[i];
    if (dot > bestSim) { bestSim = dot; best = cand; }
  }
  return { best, sim: bestSim };
}
