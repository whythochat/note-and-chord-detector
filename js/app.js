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
};

// ---------- main analysis pass ----------
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

  return {
    kind: "chord",
    root: best.root,
    quality: best.quality,
    notes: chordToneNames(best.root, best.quality),
  };
}

// ---------- temporal smoothing ----------
// Majority vote over the last few frames to stop the readout from flickering
// between near-relatives (e.g. C major vs A minor share two notes).
const history = [];

function resultKey(r) {
  if (!r || r.kind === "silent") return "silent";
  if (r.kind === "note") return "note:" + r.name;
  return "chord:" + r.root + ":" + r.quality.name;
}

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
function showTuner(show) {
  els.tuner.classList.toggle("hidden", !show);
  els.notes.classList.toggle("hidden", show);
}

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
  els.display.innerHTML = `${rootName}<small>${r.quality.symbol}</small>`;
  els.kindLabel.textContent = `${rootName} ${r.quality.name}`;
  els.notes.innerHTML = r.notes.map((n) => `<span class="chip">${n}</span>`).join("");
}

// ---------- loop / lifecycle ----------
function loop() {
  render(stabilize(analyze()));
  rafId = requestAnimationFrame(loop);
}

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
function setupControls() {
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
}

setupControls();
