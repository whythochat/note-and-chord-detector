/**
 * Estimate the fundamental frequency of a (monophonic) audio buffer using the
 * McLeod Pitch Method (MPM).
 *
 * MPM builds a Normalized Square Difference Function and picks the first peak
 * that clears 90% of the strongest one. Choosing the *first* strong peak rather
 * than the tallest makes it robust against the octave errors plain
 * autocorrelation produces on low notes, where the fundamental can be weaker
 * than its harmonics.
 *
 * @param {Float32Array} buf - Time-domain samples in roughly [-1, 1]. Cost is
 *   O(N^2) in the buffer length, so keep it small (~2048).
 * @param {number} sampleRate - Sample rate of `buf` in Hz (e.g. 44100).
 * @returns {[number, number]} A `[frequency, clarity]` pair: frequency in Hz and
 *   clarity (peak NSDF value, ~0..1, higher = more confident). Returns
 *   `[-1, 0]` when the input is too quiet or no pitch is found.
 */
function detectPitch(buf, sampleRate) {
  const N = buf.length;
  let rms = 0;
  for (let i = 0; i < N; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / N);
  if (rms < 0.01) return [-1, 0];

  // Normalized Square Difference Function (range -1..1).
  const nsdf = new Float32Array(N);
  for (let tau = 0; tau < N; tau++) {
    let acf = 0, div = 0;
    for (let i = 0; i < N - tau; i++) {
      acf += buf[i] * buf[i + tau];
      div += buf[i] * buf[i] + buf[i + tau] * buf[i + tau];
    }
    nsdf[tau] = div > 0 ? (2 * acf) / div : 0;
  }

  // Collect key maxima in the positive regions of the NSDF.
  const maxima = [];
  let tau = 1;
  while (tau < N - 1 && nsdf[tau] > 0) tau++; // descend past the tau=0 peak
  while (tau < N - 1) {
    if (nsdf[tau] > 0 && nsdf[tau] >= nsdf[tau - 1] && nsdf[tau] > nsdf[tau + 1]) {
      const a = nsdf[tau - 1], b = nsdf[tau], cc = nsdf[tau + 1];
      const denom = a - 2 * b + cc;
      const shift = denom !== 0 ? (0.5 * (a - cc)) / denom : 0;
      maxima.push([tau + shift, b - 0.25 * (a - cc) * shift]);
    }
    tau++;
  }
  if (maxima.length === 0) return [-1, 0];

  // Pick the first maximum that clears 90% of the strongest one.
  let highest = 0;
  for (const m of maxima) if (m[1] > highest) highest = m[1];
  const threshold = 0.9 * highest;
  let chosen = maxima[0];
  for (const m of maxima) if (m[1] >= threshold) { chosen = m; break; }

  const period = chosen[0];
  if (period <= 0) return [-1, 0];
  return [sampleRate / period, chosen[1]];
}
