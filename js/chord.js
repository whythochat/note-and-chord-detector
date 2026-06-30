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
 * The full candidate bank, rebuilt by {@link buildTemplates}. Each entry is a
 * normalized 12-d chroma template:
 *   - `{ type: "note",  root, vec, complexity }` for each of the 12 single notes
 *   - `{ type: "chord", root, quality, vec, complexity }` for each root x quality
 * @type {Array<{type: string, root: number, quality?: object, vec: Float32Array, complexity: number}>}
 */
let CANDIDATES = [];

/**
 * The subset of {@link CANDIDATES} currently eligible for matching, after the
 * chord-set selector is applied by {@link setChordSet}.
 * @type {Array<object>}
 */
let ACTIVE_CANDIDATES = [];

let activeChordSet = "sevenths";

/** Which quality groups each chord-set option allows (notes are always on). */
const CHORD_SET_GROUPS = {
  triads: ["triad"],
  sevenths: ["triad", "seventh"],
  all: ["triad", "seventh", "sus"],
};

/**
 * Restrict matching to a chord-set tier by filtering {@link CANDIDATES} into
 * {@link ACTIVE_CANDIDATES}. Single notes are always kept.
 *
 * @param {"triads"|"sevenths"|"all"} set - The tier to activate.
 * @returns {void}
 */
function setChordSet(set) {
  if (!CHORD_SET_GROUPS[set]) set = "all";
  activeChordSet = set;
  const allowed = new Set(CHORD_SET_GROUPS[set]);
  ACTIVE_CANDIDATES = CANDIDATES.filter(
    (c) => c.type === "note" || allowed.has(c.quality.group)
  );
}

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
    list.push({ type: "note", root: p, vec: l2normalize(notes[p]), complexity: 0 });
  }
  for (let root = 0; root < 12; root++) {
    for (const q of QUALITIES) {
      const v = new Float32Array(12);
      for (const iv of q.intervals) {
        const nt = notes[(root + iv) % 12];
        for (let i = 0; i < 12; i++) v[i] += nt[i];
      }
      list.push({ type: "chord", root, quality: q, vec: l2normalize(v), complexity: q.complexity });
    }
  }
  CANDIDATES = list;
  setChordSet(activeChordSet); // refresh the active subset for the new templates
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

// How much extra cosine similarity a more complex chord must show, per unit of
// `complexity`, before it's preferred over a simpler match. Realizes "prefer
// the simpler chord on weak evidence" — a 7th must clearly out-match its triad.
const COMPLEXITY_MARGIN = 0.03;

/**
 * Find the bass note — the lowest prominent peak in the spectrum — and return
 * its pitch class. Only the pitch class is reported, which makes this robust to
 * octave errors: if the true bass fundamental is rolled off and its octave
 * harmonic is the lowest strong peak, the pitch class is still correct.
 *
 * @param {Float32Array} freqDb - dB magnitudes from `getFloatFrequencyData`.
 * @param {number} sampleRate - Sample rate in Hz.
 * @param {number} fftSize - The analyser's FFT size.
 * @returns {{pitchClass: number, freq: number} | null} The bass pitch class
 *   (0..11) and the frequency of the detected peak, or `null` if none is found.
 */
function detectBass(freqDb, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const nBins = freqDb.length;

  // Reference loudness across the full musical range, for the peak threshold.
  let maxMag = 0;
  const refStart = Math.max(1, Math.floor(65 / binHz));
  const refEnd = Math.min(nBins - 1, Math.ceil(2000 / binHz));
  for (let i = refStart; i <= refEnd; i++) {
    const m = Math.pow(10, freqDb[i] / 20);
    if (m > maxMag) maxMag = m;
  }
  if (maxMag < 1e-4) return null;

  const thresh = maxMag * 0.15;
  const start = Math.max(2, Math.floor(55 / binHz));
  const end = Math.min(nBins - 2, Math.ceil(600 / binHz));
  for (let i = start; i <= end; i++) {
    const m = Math.pow(10, freqDb[i] / 20);
    if (m < thresh) continue;
    const lo = Math.pow(10, freqDb[i - 1] / 20);
    const hi = Math.pow(10, freqDb[i + 1] / 20);
    if (m >= lo && m >= hi) {
      return { pitchClass: freqToPitchClass(i * binHz), freq: i * binHz };
    }
  }
  return null;
}

/**
 * Find the {@link ACTIVE_CANDIDATES} template that best matches a chroma vector.
 * Selection is by cosine similarity minus a complexity penalty, so simpler
 * chords win unless a fancier one fits clearly better.
 *
 * @param {Float32Array} chroma - A 12-bin chroma vector (need not be normalized).
 * @returns {{best: object, sim: number}} The winning candidate (a single note or
 *   a chord) and its raw cosine similarity `sim` (~0..1, used for confidence
 *   gating — the penalty affects selection only, not this reported value).
 */
function classifyChroma(chroma) {
  const c = l2normalize(chroma);
  let best = null, bestScore = -Infinity, bestSim = -1;
  for (const cand of ACTIVE_CANDIDATES) {
    let dot = 0;
    for (let i = 0; i < 12; i++) dot += c[i] * cand.vec[i];
    const score = dot - COMPLEXITY_MARGIN * cand.complexity;
    if (score > bestScore) { bestScore = score; bestSim = dot; best = cand; }
  }
  return { best, sim: bestSim };
}
