// A small radix-2 FFT for offline analysis. The realtime path uses the Web
// Audio AnalyserNode, but offline we process a decoded buffer frame by frame,
// which needs our own transform.

/**
 * In-place iterative radix-2 Cooley–Tukey FFT.
 *
 * @param {Float32Array} re - Real parts; length must be a power of two.
 * @param {Float32Array} im - Imaginary parts, same length (zeros for real input).
 * @returns {void} Transforms `re`/`im` in place.
 */
function fftTransform(re, im) {
  const n = re.length;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  // Butterfly stages.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang), wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1, wIm = 0;
      for (let k = 0; k < len >> 1; k++) {
        const a = i + k, b = i + k + (len >> 1);
        const vRe = re[b] * wRe - im[b] * wIm;
        const vIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - vRe; im[b] = im[a] - vIm;
        re[a] += vRe; im[a] += vIm;
        const nwRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nwRe;
      }
    }
  }
}

/**
 * Build a Hann window of a given length (reduces spectral leakage).
 *
 * @param {number} n - Window length.
 * @returns {Float32Array} The window coefficients.
 */
function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

/**
 * Magnitude spectrum of a real, already-windowed frame.
 *
 * @param {Float32Array} frame - Time-domain samples; length a power of two.
 * @returns {Float32Array} Linear magnitudes for bins 0..N/2-1.
 */
function magnitudeSpectrum(frame) {
  const n = frame.length;
  const re = Float32Array.from(frame);
  const im = new Float32Array(n);
  fftTransform(re, im);
  const half = n >> 1;
  const mag = new Float32Array(half);
  for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}
