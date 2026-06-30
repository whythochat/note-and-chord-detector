// App wiring: microphone capture, the per-frame analysis pass that decides
// between single-note and chord, DOM rendering, and start/stop lifecycle.

const els = {
  display: document.getElementById("display"),
  kindLabel: document.getElementById("kindLabel"),
  tuner: document.getElementById("tuner"),
  notes: document.getElementById("notes"),
  freq: document.getElementById("freq"),
  cents: document.getElementById("cents"),
  needle: document.getElementById("needle"),
  status: document.getElementById("status"),
  toggle: document.getElementById("toggle"),
};

let audioCtx, analyser, source, stream, rafId;
let running = false;
let timeBuf, freqBuf;

// Live-adjustable tuning knobs (wired to the Settings sliders).
const settings = {
  confidence: 0.6,        // min cosine similarity to accept a frame
  history: 6,             // frames of majority-vote smoothing
  harmonicDecay: 0.6,     // overtone weight baked into templates
  spectrumSmoothing: 0.8, // AnalyserNode smoothingTimeConstant
  chordSet: "sevenths",   // which chord tiers can be detected
  inversions: true,       // detect bass note / slash chords
};

// ---------- main analysis pass ----------

/**
 * @typedef {Object} Detection
 * @property {"silent"|"note"|"chord"} kind - What was detected this frame.
 * @property {string} [name] - Note name (when kind === "note"), e.g. "C#".
 * @property {number|string} [octave] - Note octave (when kind === "note");
 *   empty string when the octave is unknown.
 * @property {number} [freq] - Detected frequency in Hz (kind === "note");
 *   0 when unknown.
 * @property {number} [cents] - Cents offset from perfect pitch (kind === "note").
 * @property {number} [root] - Chord root pitch class 0..11 (kind === "chord").
 * @property {object} [quality] - Chord quality from QUALITIES (kind === "chord").
 * @property {string[]} [notes] - Chord-tone names (kind === "chord").
 * @property {number} [bass] - Bass pitch class when inverted (kind === "chord").
 * @property {number} [inversion] - Inversion index 1..3 when inverted.
 */

/**
 * Run one analysis frame: read the latest audio, decide whether it's a single
 * note or a chord, and package the result for rendering. Reads the module-level
 * `analyser`/`audioCtx` and the live `settings`.
 *
 * @returns {Detection} The detection for this frame (`{ kind: "silent" }` when
 *   too quiet or below the confidence threshold).
 */
function analyze() {
  analyser.getFloatTimeDomainData(timeBuf);
  const slice = timeBuf.subarray(timeBuf.length - 2048); // smaller window for MPM
  const [mpmFreq, clarity] = detectPitch(slice, audioCtx.sampleRate);

  analyser.getFloatFrequencyData(freqBuf);
  const spectrum = computeChroma(freqBuf, audioCtx.sampleRate, analyser.fftSize);
  if (!spectrum) return { kind: "silent" };

  const { best, sim } = classifyChroma(spectrum.chroma);
  if (sim < settings.confidence) return { kind: "silent" };

  if (best.type === "note") {
    // MPM gives an accurate octave; fall back to the loudest spectral bin.
    const freq = (clarity > 0.8 && mpmFreq > 0) ? mpmFreq : spectrum.dominantFreq;
    if (freq > 0) return { kind: "note", freq, ...freqToNote(freq) };
    return { kind: "note", freq: 0, name: NOTE_NAMES[best.root], octave: "", cents: 0 };
  }

  const result = {
    kind: "chord",
    root: best.root,
    quality: best.quality,
    notes: chordToneNames(best.root, best.quality),
  };

  // Bass note / inversion: a chord tone other than the root in the bass.
  if (settings.inversions) {
    const bass = detectBass(freqBuf, audioCtx.sampleRate, analyser.fftSize);
    if (bass && bass.pitchClass !== best.root) {
      const idx = best.quality.intervals.findIndex(
        (iv) => (best.root + iv) % 12 === bass.pitchClass
      );
      if (idx > 0) {
        result.bass = bass.pitchClass;
        result.inversion = idx;
      }
    }
  }
  return result;
}

// ---------- temporal smoothing ----------
// Majority vote over the last few frames to stop the readout from flickering
// between near-relatives (e.g. C major vs A minor share two notes).
const history = [];

/**
 * Build a stable identity string for a detection, used to group equal results
 * across frames. Ignores volatile fields (cents, frequency) so the same note or
 * chord maps to one key regardless of small tuning fluctuations.
 *
 * @param {Detection} r - A detection from {@link analyze}.
 * @returns {string} The grouping key, e.g. "silent", "note:C#", "chord:0:major".
 */
function resultKey(r) {
  if (!r || r.kind === "silent") return "silent";
  if (r.kind === "note") return "note:" + r.name;
  return "chord:" + r.root + ":" + r.quality.name + ":" + (r.bass ?? "");
}

/**
 * Smooth detections over time by majority vote across the last `settings.history`
 * frames, suppressing flicker between near-relatives (e.g. C major vs A minor,
 * which share two notes). Mutates the module-level `history` buffer.
 *
 * @param {Detection} r - The current frame's detection.
 * @returns {Detection} The most recent detection whose key wins the vote (so
 *   live fields like cents/frequency stay fresh).
 */
function stabilize(r) {
  history.push({ key: resultKey(r), result: r });
  while (history.length > settings.history) history.shift();

  const counts = {};
  for (const h of history) counts[h.key] = (counts[h.key] || 0) + 1;
  let winner = history[history.length - 1].key, top = 0;
  for (const k in counts) if (counts[k] > top) { top = counts[k]; winner = k; }

  // Show the freshest frame matching the winning key (keeps cents/freq live).
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].key === winner) return history[i].result;
  }
  return r;
}

// ---------- rendering ----------

/**
 * Toggle between the single-note tuner view and the chord note-list view.
 *
 * @param {boolean} show - `true` to show the tuner (note mode), `false` to show
 *   the chord chips (chord mode).
 * @returns {void}
 */
function showTuner(show) {
  els.tuner.classList.toggle("hidden", !show);
  els.notes.classList.toggle("hidden", show);
}

/**
 * Render a detection into the DOM: the big readout, the kind label, and either
 * the tuner (note) or the note chips (chord). Clears everything for silence.
 *
 * @param {Detection|null} r - The detection to display; `null`/silent resets the UI.
 * @returns {void}
 */
function render(r) {
  if (!r || r.kind === "silent") {
    els.display.textContent = "—";
    els.display.classList.remove("chord");
    els.kindLabel.textContent = "";
    els.freq.textContent = "—";
    els.cents.textContent = "—";
    els.notes.innerHTML = "";
    return;
  }

  if (r.kind === "note") {
    showTuner(true);
    els.display.classList.remove("chord");
    els.display.innerHTML = `${r.name}<small>${r.octave}</small>`;
    els.kindLabel.textContent = "single note";
    if (r.freq > 0) {
      els.freq.textContent = r.freq.toFixed(1);
      els.cents.textContent = (r.cents >= 0 ? "+" : "") + r.cents;
      const pct = Math.max(0, Math.min(100, r.cents + 50));
      els.needle.style.left = pct + "%";
      els.needle.style.background = Math.abs(r.cents) < 8 ? "var(--accent)" : "var(--warn)";
    } else {
      els.freq.textContent = "—";
      els.cents.textContent = "—";
    }
    return;
  }

  // chord
  showTuner(false);
  els.display.classList.add("chord");
  const rootName = NOTE_NAMES[r.root];
  const slash = r.bass != null ? `/${NOTE_NAMES[r.bass]}` : "";
  els.display.innerHTML = `${rootName}<small>${r.quality.symbol}</small>${slash}`;
  els.kindLabel.textContent = `${rootName} ${r.quality.name}` +
    (r.inversion ? ` · ${inversionName(r.inversion)}` : "");
  els.notes.innerHTML = r.notes.map((n) => `<span class="chip">${n}</span>`).join("");
}

// ---------- loop / lifecycle ----------

/**
 * The per-frame pipeline: analyze → smooth → render, rescheduled via
 * `requestAnimationFrame` until {@link stop} cancels it.
 *
 * @returns {void}
 */
function loop() {
  render(stabilize(analyze()));
  rafId = requestAnimationFrame(loop);
}

/**
 * Request microphone access, set up the audio graph (AnalyserNode), and start
 * the analysis loop. Updates the toggle button and status text. On failure
 * (e.g. permission denied) the error is shown in the status line.
 *
 * @returns {Promise<void>} Resolves once the loop has started (or failed gracefully).
 */
async function start() {
  try {
    els.status.textContent = "Requesting microphone…";
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 16384;
    analyser.smoothingTimeConstant = settings.spectrumSmoothing;
    timeBuf = new Float32Array(analyser.fftSize);
    freqBuf = new Float32Array(analyser.frequencyBinCount);
    source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    history.length = 0;
    running = true;
    els.toggle.textContent = "Stop";
    els.toggle.classList.add("stop");
    els.status.textContent = "Listening… play a note or a chord.";
    loop();
  } catch (e) {
    els.status.textContent = "Error: " + e.message;
  }
}

/**
 * Stop the analysis loop, release the microphone, and tear down the audio
 * context. Resets the UI to its idle state.
 *
 * @returns {void}
 */
function stop() {
  running = false;
  cancelAnimationFrame(rafId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  els.toggle.textContent = "Start listening";
  els.toggle.classList.remove("stop");
  els.status.textContent = "Stopped.";
  render(null);
}

els.toggle.addEventListener("click", () => (running ? stop() : start()));

// ---------- settings sliders ----------

/**
 * Wire each Settings range input to its key in `settings`: set the slider's
 * initial value, keep the value label in sync, and update `settings` (plus any
 * side effect) whenever the user drags it.
 *
 * @returns {void}
 */
function setupControls() {
  /**
   * Bind one slider to a settings key.
   * @param {string} id - Element id of the `<input type="range">`; its value
   *   label is expected at `id + "Val"`.
   * @param {string} key - Property of `settings` this slider controls.
   * @param {(value: number) => string} fmt - Formats the value for the label.
   * @param {(value: number) => void} [onChange] - Optional side effect to run on change.
   */
  const bind = (id, key, fmt, onChange) => {
    const input = document.getElementById(id);
    const out = document.getElementById(id + "Val");
    input.value = settings[key];
    out.textContent = fmt(settings[key]);
    input.addEventListener("input", () => {
      settings[key] = parseFloat(input.value);
      out.textContent = fmt(settings[key]);
      if (onChange) onChange(settings[key]);
    });
  };

  bind("confidence", "confidence", (v) => v.toFixed(2));
  bind("history", "history", (v) => v + (v === 1 ? " frame" : " frames"));
  bind("harmonicDecay", "harmonicDecay", (v) => v.toFixed(2), (v) => buildTemplates(v));
  bind("spectrumSmoothing", "spectrumSmoothing", (v) => v.toFixed(2), (v) => {
    if (analyser) analyser.smoothingTimeConstant = v;
  });

  // Chord-set selector (a <select>, so it's wired separately from the sliders).
  const chordSetEl = document.getElementById("chordSet");
  chordSetEl.value = settings.chordSet;
  setChordSet(settings.chordSet);
  chordSetEl.addEventListener("change", () => {
    settings.chordSet = chordSetEl.value;
    setChordSet(settings.chordSet);
  });

  // Inversion detection toggle (a checkbox).
  const inversionsEl = document.getElementById("inversions");
  inversionsEl.checked = settings.inversions;
  inversionsEl.addEventListener("change", () => {
    settings.inversions = inversionsEl.checked;
  });
}

setupControls();

// ---------- theme toggle ----------

/**
 * Wire the theme toggle button: label it with the theme it will switch to, and
 * flip between light and dark on click. Theme reads/writes live in theme.js.
 *
 * @returns {void}
 */
function setupTheme() {
  const btn = document.getElementById("themeToggle");
  const sync = () => {
    btn.textContent = currentTheme() === "light" ? "🌙 Dark" : "☀️ Light";
  };
  sync();
  btn.addEventListener("click", () => {
    setTheme(currentTheme() === "light" ? "dark" : "light");
    sync();
  });
}

setupTheme();

// ---------- credit heart ----------

/**
 * Make the credit heart beat on click or tap (hover is handled in CSS). The
 * `.beating` class runs a finite animation and is cleared when it ends so it
 * can be retriggered.
 *
 * @returns {void}
 */
function setupHeart() {
  const heart = document.getElementById("heart");
  if (!heart) return;
  const beat = () => {
    heart.classList.remove("beating");
    void heart.offsetWidth; // force reflow so the animation restarts every time
    heart.classList.add("beating");
  };
  heart.addEventListener("click", beat);
  heart.addEventListener("touchstart", beat, { passive: true });
  heart.addEventListener("animationend", () => heart.classList.remove("beating"));
}

setupHeart();
