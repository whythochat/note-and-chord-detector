// Musical constants and frequency <-> note helpers.

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Chord qualities, each defined by semitone offsets from the root.
//   symbol     - compact label for the display (e.g. "m7")
//   intervals  - chord tones as semitones above the root
//   group      - "triad" | "seventh" | "sus", used by the chord-set selector
//   complexity - bias against fancier chords; a higher value must beat a
//                simpler match by a larger margin to be chosen
const QUALITIES = [
  { name: "major",      symbol: "",    intervals: [0, 4, 7], group: "triad", complexity: 0 },
  { name: "minor",      symbol: "m",   intervals: [0, 3, 7], group: "triad", complexity: 0 },
  { name: "diminished", symbol: "dim", intervals: [0, 3, 6], group: "triad", complexity: 0 },
  { name: "augmented",  symbol: "aug", intervals: [0, 4, 8], group: "triad", complexity: 0 },

  { name: "major 7th",          symbol: "maj7", intervals: [0, 4, 7, 11], group: "seventh", complexity: 1 },
  { name: "dominant 7th",       symbol: "7",    intervals: [0, 4, 7, 10], group: "seventh", complexity: 1 },
  { name: "minor 7th",          symbol: "m7",   intervals: [0, 3, 7, 10], group: "seventh", complexity: 1 },
  { name: "diminished 7th",     symbol: "dim7", intervals: [0, 3, 6, 9],  group: "seventh", complexity: 1 },
  { name: "half-diminished 7th", symbol: "m7♭5", intervals: [0, 3, 6, 10], group: "seventh", complexity: 1 },

  { name: "suspended 2nd", symbol: "sus2", intervals: [0, 2, 7], group: "sus", complexity: 1 },
  { name: "suspended 4th", symbol: "sus4", intervals: [0, 5, 7], group: "sus", complexity: 1 },
];

/**
 * Convert a frequency to a (possibly fractional) MIDI note number, using the
 * standard tuning where A4 = 440 Hz = MIDI 69.
 *
 * @param {number} freq - Frequency in Hz (must be > 0).
 * @returns {number} The MIDI note number; fractional part indicates detuning.
 */
function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

/**
 * Convert a frequency to its nearest note, with how far it is from being in tune.
 *
 * @param {number} freq - Frequency in Hz (must be > 0).
 * @returns {{name: string, octave: number, cents: number}} The note name
 *   (e.g. "C#"), its octave number (scientific pitch notation, A4 in octave 4),
 *   and the signed offset from perfect pitch in cents (-50..+50).
 */
function freqToNote(freq) {
  const midi = freqToMidi(freq);
  const rounded = Math.round(midi);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  const cents = Math.round((midi - rounded) * 100);
  return { name, octave, cents };
}

/**
 * Reduce a frequency to its pitch class, discarding octave information.
 *
 * @param {number} freq - Frequency in Hz (must be > 0).
 * @returns {number} The pitch class as an integer 0..11, where 0 = C, 1 = C#, …
 */
function freqToPitchClass(freq) {
  const rounded = Math.round(freqToMidi(freq));
  return ((rounded % 12) + 12) % 12;
}

/**
 * Human-readable name for an inversion index.
 *
 * @param {number} n - Position of the bass within the chord's intervals:
 *   0 = root, 1 = third, 2 = fifth, 3 = seventh.
 * @returns {string} e.g. "root position", "1st inversion", … ("" if unknown).
 */
function inversionName(n) {
  return ["root position", "1st inversion", "2nd inversion", "3rd inversion"][n] || "";
}

/**
 * List the note names that make up a chord, e.g. C major -> ["C", "E", "G"].
 *
 * @param {number} root - Root pitch class, 0..11 (0 = C).
 * @param {{intervals: number[]}} quality - A quality from {@link QUALITIES};
 *   its `intervals` are semitone offsets from the root.
 * @returns {string[]} The chord-tone names, in template order.
 */
function chordToneNames(root, quality) {
  return quality.intervals.map((iv) => NOTE_NAMES[(root + iv) % 12]);
}
