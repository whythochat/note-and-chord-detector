// Record mode: capture audio until the user stops, analyze it offline, and show
// an interactive timeline of chord/note segments with playback, scrubbing,
// audio download, MIDI export, and re-analysis. Shares the detection code and
// the `settings` object with the live mode.

const rec = {
  els: {
    tabLive: document.getElementById("tabLive"),
    tabRecord: document.getElementById("tabRecord"),
    livePanel: document.getElementById("livePanel"),
    recordPanel: document.getElementById("recordPanel"),
    recBtn: document.getElementById("recBtn"),
    recStatus: document.getElementById("recStatus"),
    player: document.getElementById("player"),
    playBtn: document.getElementById("playBtn"),
    timeline: document.getElementById("timeline"),
    track: document.getElementById("timelineTrack"),
    melodyLane: document.getElementById("melodyLane"),
    segmentsEl: document.getElementById("timelineSegments"),
    barsEl: document.getElementById("timelineBars"),
    grid: document.getElementById("timelineGrid"),
    cursor: document.getElementById("cursor"),
    laneLabels: document.getElementById("laneLabels"),
    nowMelody: document.getElementById("nowMelody"),
    nowChord: document.getElementById("nowChord"),
    timeLabel: document.getElementById("timeLabel"),
    reanalyzeBtn: document.getElementById("reanalyzeBtn"),
    downloadAudioBtn: document.getElementById("downloadAudioBtn"),
    downloadMidiBtn: document.getElementById("downloadMidiBtn"),
  },
  mediaRecorder: null,
  chunks: [],
  stream: null,
  recording: false,
  audioBlob: null,
  audioUrl: null,
  audio: null,      // HTMLAudioElement for playback
  audioBuffer: null, // decoded PCM for analysis
  segments: [],
  melody: [],
  duration: 0,
  offlineCtx: null,
  playRaf: 0,
  pxPerSec: 0,   // effective horizontal scale of the current render
  trackWidth: 0, // rendered track width in px
};

// Baseline timeline scale. The track is at least as wide as the viewport (so
// short takes fill the screen) and grows past it for longer recordings.
const PX_PER_SEC = 90; // REST_SVG is defined in music.js (shared with live mode)

/** mm:ss formatting for the transport label. */
function formatTime(sec) {
  if (!isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ":" + String(s).padStart(2, "0");
}

// ---------- tabs ----------

/**
 * Wire the Live/Record tab bar, releasing the live mic or pausing playback when
 * switching away from a mode.
 *
 * @returns {void}
 */
function setupTabs() {
  const show = (mode) => {
    const live = mode === "live";
    rec.els.livePanel.classList.toggle("hidden", !live);
    rec.els.recordPanel.classList.toggle("hidden", live);
    rec.els.tabLive.classList.toggle("active", live);
    rec.els.tabRecord.classList.toggle("active", !live);
    if (live) {
      pausePlayback();
    } else if (running) {
      stop(); // release the live microphone
    }
  };
  rec.els.tabLive.addEventListener("click", () => show("live"));
  rec.els.tabRecord.addEventListener("click", () => show("record"));
}

// ---------- recording ----------

/**
 * Toggle recording. On stop, the captured audio is decoded and analyzed.
 *
 * @returns {Promise<void>}
 */
async function toggleRecording() {
  if (rec.recording) {
    rec.mediaRecorder.stop();
    return;
  }
  try {
    rec.els.recStatus.textContent = "Requesting microphone…";
    rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    rec.chunks = [];
    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    rec.mediaRecorder = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
    rec.mediaRecorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
    rec.mediaRecorder.onstop = onRecordingStopped;
    rec.mediaRecorder.start();
    rec.recording = true;
    rec.els.recBtn.textContent = "■ Stop";
    rec.els.recBtn.classList.add("recording");
    rec.els.recStatus.textContent = "Recording… play something, then stop.";
  } catch (e) {
    rec.els.recStatus.textContent = "Error: " + e.message;
  }
}

/**
 * Handle the end of a recording: build the audio blob, decode it, analyze it,
 * and render the timeline. Also releases the microphone.
 *
 * @returns {Promise<void>}
 */
async function onRecordingStopped() {
  rec.recording = false;
  rec.els.recBtn.textContent = "● Record";
  rec.els.recBtn.classList.remove("recording");
  if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());

  rec.audioBlob = new Blob(rec.chunks, { type: rec.chunks[0]?.type || "audio/webm" });
  if (rec.audioUrl) URL.revokeObjectURL(rec.audioUrl);
  rec.audioUrl = URL.createObjectURL(rec.audioBlob);
  rec.audio = new Audio(rec.audioUrl);
  rec.audio.addEventListener("ended", () => { pausePlayback(); });

  rec.els.recStatus.textContent = "Analyzing…";
  try {
    rec.offlineCtx = rec.offlineCtx || new (window.AudioContext || window.webkitAudioContext)();
    const arr = await rec.audioBlob.arrayBuffer();
    rec.audioBuffer = await rec.offlineCtx.decodeAudioData(arr);
    runAnalysis();
    rec.els.player.classList.remove("hidden");
    rec.els.recStatus.textContent = "Done. Play or scrub the timeline.";
  } catch (e) {
    rec.els.recStatus.textContent = "Could not analyze recording: " + e.message;
  }
}

/** Run (or re-run) offline analysis on the decoded buffer and render it. */
function runAnalysis() {
  if (!rec.audioBuffer) return;
  const { duration, segments, melody } = analyzeRecording(rec.audioBuffer);
  rec.duration = duration;
  rec.segments = segments;
  rec.melody = melody || [];
  renderTimeline();
  updatePlayhead(rec.audio ? rec.audio.currentTime : 0);
}

// ---------- timeline ----------

/** Escape a string for safe use in an HTML attribute. */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Draw the segment blocks at a fixed pixels-per-second scale. The track fills
 * the viewport for short recordings and overflows (scrolls) for longer ones.
 * Rest blocks get a musical rest glyph, and barlines mark sound/silence breaks.
 *
 * @returns {void}
 */
function renderTimeline() {
  const total = rec.duration || 1;
  const viewport = rec.els.timeline.clientWidth || 320;
  // Fill the viewport at minimum; use PX_PER_SEC when that's wider.
  rec.pxPerSec = Math.max(PX_PER_SEC, viewport / total);
  rec.trackWidth = total * rec.pxPerSec;
  rec.els.track.style.width = rec.trackWidth + "px";

  // Show/hide the melody lane depending on whether any melody was found.
  const hasMelody = rec.melody.some((m) => m.type === "note");
  rec.els.timeline.classList.toggle("no-melody", !hasMelody);
  if (rec.els.laneLabels) rec.els.laneLabels.classList.toggle("no-melody", !hasMelody);
  renderGrid();
  renderMelody();

  rec.els.segmentsEl.innerHTML = rec.segments.map((seg, i) => {
    const left = seg.start * rec.pxPerSec;
    const width = Math.max(1, (seg.end - seg.start) * rec.pxPerSec);
    const isRest = seg.type === "none";
    // Legibility: rotate the label when narrow, hide it when tiny (tooltip only).
    let sizeCls = "";
    if (!isRest) sizeCls = width < 26 ? " tiny" : width < 62 ? " narrow" : "";
    const tones = !isRest && seg.notes ? seg.notes.join(" ") : "";
    const tip = isRest ? "rest (pause)" : esc(seg.sub || seg.display);
    const inner = isRest
      ? REST_SVG
      : `<span class="seg-name">${esc(seg.display)}</span>` +
        (tones ? `<span class="seg-tones">${esc(tones)}</span>` : "");
    return `<div class="seg seg-${seg.type}${sizeCls}" data-i="${i}" ` +
      `style="left:${left}px;width:${width}px" title="${tip}">${inner}</div>`;
  }).join("");

  renderBarlines();
}

/** Draw a barline at every transition between sound and silence. */
function renderBarlines() {
  const bars = [];
  const segs = rec.segments;
  for (let i = 0; i < segs.length - 1; i++) {
    const aRest = segs[i].type === "none";
    const bRest = segs[i + 1].type === "none";
    if (aRest !== bRest) {
      const x = segs[i].end * rec.pxPerSec;
      bars.push(`<div class="barline" style="left:${x}px" title="break"></div>`);
    }
  }
  rec.els.barsEl.innerHTML = bars.join("");
}

/** Draw the beat/bar grid when snapping to a tempo is enabled. */
function renderGrid() {
  if (!rec.els.grid) return;
  if (!recSettings.snapToBeats || recSettings.bpm <= 0) { rec.els.grid.innerHTML = ""; return; }
  const beat = 60 / recSettings.bpm;
  const bpb = recSettings.beatsPerBar || 4;
  const nBeats = Math.floor(rec.duration / beat);
  const lines = [];
  for (let b = 0; b <= nBeats; b++) {
    const x = b * beat * rec.pxPerSec;
    lines.push(`<div class="grid-line${b % bpb === 0 ? " bar" : ""}" style="left:${x}px"></div>`);
  }
  rec.els.grid.innerHTML = lines.join("");
}

/** Draw the melody note cells in the top lane (rests left blank). */
function renderMelody() {
  rec.els.melodyLane.innerHTML = rec.melody.map((seg, i) => {
    if (seg.type !== "note") return "";
    const left = seg.start * rec.pxPerSec;
    const width = Math.max(1, (seg.end - seg.start) * rec.pxPerSec);
    const sizeCls = width < 18 ? " tiny" : width < 40 ? " narrow" : "";
    return `<div class="mcell${sizeCls}" data-i="${i}" ` +
      `style="left:${left}px;width:${width}px" title="${esc(seg.display)}">` +
      `<span>${esc(seg.display)}</span></div>`;
  }).join("");
}

/**
 * Move the cursor and update the "now playing" label for a given time.
 *
 * @param {number} t - Playback time in seconds.
 * @param {boolean} [autoScroll] - Keep the cursor within the scroll viewport.
 * @returns {void}
 */
function updatePlayhead(t, autoScroll) {
  const total = rec.duration || 1;
  const x = (t / total) * rec.trackWidth;
  rec.els.cursor.style.left = Math.max(0, Math.min(rec.trackWidth, x)) + "px";
  rec.els.timeLabel.textContent = formatTime(t) + " / " + formatTime(rec.duration);

  let current = null;
  const blocks = rec.els.segmentsEl.children;
  for (let i = 0; i < rec.segments.length; i++) {
    const seg = rec.segments[i];
    const active = t >= seg.start && t < seg.end;
    if (blocks[i]) blocks[i].classList.toggle("active", active);
    if (active) current = seg;
  }
  if (current && current.type === "none") rec.els.nowChord.innerHTML = REST_SVG;
  else rec.els.nowChord.textContent = current ? current.display : "—";

  // Melody lane: highlight the active note cell (cells map to melody indices).
  let melNow = null;
  const mcells = rec.els.melodyLane.children;
  let ci = 0;
  for (let i = 0; i < rec.melody.length; i++) {
    const seg = rec.melody[i];
    if (seg.type !== "note") continue;
    const active = t >= seg.start && t < seg.end;
    if (mcells[ci]) mcells[ci].classList.toggle("active", active);
    if (active) melNow = seg;
    ci++;
  }
  if (rec.els.nowMelody) rec.els.nowMelody.textContent = melNow ? melNow.display : "";

  if (autoScroll) {
    const cont = rec.els.timeline;
    const margin = 60;
    if (x < cont.scrollLeft + margin || x > cont.scrollLeft + cont.clientWidth - margin) {
      cont.scrollLeft = x - cont.clientWidth / 2;
    }
  }
}

// ---------- playback ----------

/** Start the playback cursor animation loop. */
function playbackLoop() {
  if (!rec.audio) return;
  updatePlayhead(rec.audio.currentTime, true);
  if (!rec.audio.paused) rec.playRaf = requestAnimationFrame(playbackLoop);
}

function playPlayback() {
  if (!rec.audio) return;
  rec.audio.play();
  rec.els.playBtn.textContent = "⏸ Pause";
  playbackLoop();
}

function pausePlayback() {
  if (!rec.audio) return;
  rec.audio.pause();
  rec.els.playBtn.textContent = "▶ Play";
  cancelAnimationFrame(rec.playRaf);
}

function togglePlayback() {
  if (!rec.audio) return;
  if (rec.audio.paused) playPlayback();
  else pausePlayback();
}

// ---------- seeking / scrubbing ----------

/** Convert a pointer event on the track to a time and seek there. */
function seekToEvent(e) {
  if (!rec.audio || !rec.trackWidth) return;
  const r = rec.els.track.getBoundingClientRect();
  const x = Math.max(0, Math.min(rec.trackWidth, e.clientX - r.left));
  const t = (x / rec.trackWidth) * rec.duration;
  rec.audio.currentTime = t;
  updatePlayhead(t);
}

function setupScrubbing() {
  let dragging = false;
  rec.els.track.addEventListener("pointerdown", (e) => {
    dragging = true;
    rec.els.track.setPointerCapture(e.pointerId);
    seekToEvent(e);
  });
  rec.els.track.addEventListener("pointermove", (e) => { if (dragging) seekToEvent(e); });
  rec.els.track.addEventListener("pointerup", (e) => {
    dragging = false;
    rec.els.track.releasePointerCapture(e.pointerId);
  });

  // Re-fit the scale when the viewport width changes.
  window.addEventListener("resize", () => {
    if (rec.segments.length) {
      const t = rec.audio ? rec.audio.currentTime : 0;
      renderTimeline();
      updatePlayhead(t);
    }
  });
}

// ---------- downloads ----------

/** Trigger a browser download of a blob. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- init ----------

/**
 * Wire all record-mode controls. Safe to call once at startup.
 *
 * @returns {void}
 */
function setupRecordMode() {
  if (!rec.els.recBtn) return;
  setupTabs();
  setupScrubbing();

  rec.els.recBtn.addEventListener("click", toggleRecording);
  rec.els.playBtn.addEventListener("click", togglePlayback);
  rec.els.reanalyzeBtn.addEventListener("click", () => {
    rec.els.recStatus.textContent = "Re-analyzing…";
    runAnalysis();
    rec.els.recStatus.textContent = "Re-analyzed with current settings.";
  });
  rec.els.downloadAudioBtn.addEventListener("click", () => {
    if (rec.audioBlob) downloadBlob(rec.audioBlob, "recording.webm");
  });
  rec.els.downloadMidiBtn.addEventListener("click", () => {
    if (!rec.segments.length && !rec.melody.length) return;
    const midi = tracksToMidi([
      { name: "Melody", segments: rec.melody },
      { name: "Chords", segments: rec.segments },
    ]);
    downloadBlob(midi, "transcription.mid");
  });

  setupRecordSettings();
}

/** Re-run offline analysis if a recording is loaded (after a setting changes). */
function reanalyzeIfReady() {
  if (!rec.audioBuffer) return;
  rec.els.recStatus.textContent = "Re-analyzing…";
  runAnalysis();
  rec.els.recStatus.textContent = "Re-analyzed with current settings.";
}

/**
 * Wire the granular "Recording analysis" controls to `recSettings`. Value labels
 * update live while dragging; the (heavier) re-analysis runs on release/change.
 *
 * @returns {void}
 */
function setupRecordSettings() {
  const slider = (id, key, fmt) => {
    const input = document.getElementById(id);
    if (!input) return;
    const out = document.getElementById(id + "Val");
    input.value = recSettings[key];
    if (out) out.textContent = fmt(recSettings[key]);
    input.addEventListener("input", () => {
      recSettings[key] = parseFloat(input.value);
      if (out) out.textContent = fmt(recSettings[key]);
    });
    input.addEventListener("change", reanalyzeIfReady);
  };
  slider("recOverlap", "overlap", (v) => Math.round(v * 100) + "%");
  slider("recOnset", "onsetSensitivity", (v) => v.toFixed(2));
  slider("recMinSeg", "minSegment", (v) => v.toFixed(2) + "s");
  slider("recMelodyLevel", "melodyMinLevel", (v) => v.toFixed(2));
  slider("recMelodySmooth", "melodySmoothMs", (v) => Math.round(v) + " ms");
  slider("recMelodyMinSeg", "melodyMinSeg", (v) => v.toFixed(2) + "s");

  const fftEl = document.getElementById("recFft");
  if (fftEl) {
    fftEl.value = String(recSettings.fftSize);
    fftEl.addEventListener("change", () => {
      recSettings.fftSize = parseInt(fftEl.value, 10);
      reanalyzeIfReady();
    });
  }

  const melEl = document.getElementById("recMelody");
  if (melEl) {
    melEl.checked = recSettings.detectMelody;
    melEl.addEventListener("change", () => {
      recSettings.detectMelody = melEl.checked;
      reanalyzeIfReady();
    });
  }

  // Tempo controls: BPM, snap-to-beats, and beats per bar (grid).
  const bpmEl = document.getElementById("recBpm");
  if (bpmEl) {
    bpmEl.value = recSettings.bpm;
    bpmEl.addEventListener("change", () => {
      recSettings.bpm = Math.max(20, Math.min(300, parseInt(bpmEl.value, 10) || 120));
      bpmEl.value = recSettings.bpm;
      if (recSettings.snapToBeats) reanalyzeIfReady();
      else if (rec.audioBuffer) renderTimeline();
    });
  }

  const snapEl = document.getElementById("recSnap");
  if (snapEl) {
    snapEl.checked = recSettings.snapToBeats;
    snapEl.addEventListener("change", () => {
      recSettings.snapToBeats = snapEl.checked;
      reanalyzeIfReady();
    });
  }

  const bpbEl = document.getElementById("recBeatsPerBar");
  if (bpbEl) {
    bpbEl.value = recSettings.beatsPerBar;
    bpbEl.addEventListener("change", () => {
      recSettings.beatsPerBar = Math.max(1, Math.min(12, parseInt(bpbEl.value, 10) || 4));
      bpbEl.value = recSettings.beatsPerBar;
      if (rec.audioBuffer) renderTimeline();
    });
  }
}

setupRecordMode();
