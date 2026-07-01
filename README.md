# Note & Chord Detector

A browser-based audio detector that listens to your device's microphone and reports what it hears: a **single note** (with frequency, octave, and cents offset) or a **chord** (with its root and quality). It has two modes:

- **Live** — real-time detection that switches between note and chord automatically.
- **Record** — capture audio, analyze it offline for higher accuracy, and scrub an interactive timeline of the detected chords/notes.

No installation, no build step, no dependencies — just static HTML, CSS, and JavaScript using the Web Audio API.

## Live demo

**▶ [whythochat.github.io/note-and-chord-detector](https://whythochat.github.io/note-and-chord-detector/)**

Open it on a phone or computer, click **Start listening**, allow microphone access, and play a note or a chord on any instrument.

## Running locally

You can also open `index.html` in a modern browser (Chrome, Edge, Firefox, or Safari).

Most browsers require a **secure context** for microphone access. Opening the file directly (`file://`) works in many desktop browsers; if yours blocks it, serve the folder locally:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## How it works

1. **Capture** — `getUserMedia` opens the mic and feeds an `AnalyserNode`, which exposes both the raw waveform and its FFT spectrum.
2. **Single-note pitch** — the waveform is run through the **McLeod Pitch Method (MPM)**, which selects the first strong periodicity peak of a Normalized Square Difference Function. This makes it robust against the octave errors that plain autocorrelation produces on low notes, where the fundamental can be weaker than its harmonics.
3. **Chord analysis** — the FFT spectrum is folded into a 12-bin **chroma vector** (energy summed per pitch class). This is compared by **cosine similarity** against a fixed bank of templates: one per single note and one per triad (major, minor, diminished, augmented) across all twelve roots. Each template models the note's **harmonic series** (octave, fifth, major third…) at decaying weights, so a lone note and a full triad produce distinguishable chroma shapes — the best-matching template wins.
4. **Auto mode** — the winning template is either a single note (reported with an accurate octave from MPM) or a chord, so the display switches automatically with no manual toggle.
5. **Readout** — note name, octave, frequency, cents, a tuner needle, and the chord's notes update live. A confidence threshold gates out silence and noise, and a short majority-vote smoother steadies the readout against frame-to-frame flicker.

## Settings

A collapsible **Settings** panel exposes the detector's tuning knobs live, so you can adapt it to your instrument and room:

- **Chord set** — limit detection to triads only, triads + 7ths, or all chords (including sus), to cut false matches when you only play simpler chords.
- **Detect inversions** — toggle bass-note detection and slash-chord naming on or off.
- **Confidence** — minimum match similarity required before a result is shown.
- **Smoothing** — how many frames the majority-vote stabilizer averages over (steadier vs. more responsive).
- **Harmonic influence** — how much overtone energy the templates assume, which shifts the balance between calling something a single note vs. a chord.
- **Spectrum smoothing** — averaging applied to the FFT between frames.

A **dark / light theme toggle** (top-right) remembers your choice and defaults to your system preference.

## Record mode

The **Record** tab captures audio until you stop, then analyzes the whole recording offline — which allows more accuracy than the realtime path:

- **Larger FFT windows** for finer frequency resolution than realtime frames allow.
- **Onset detection** via spectral flux to place chord/note boundaries.
- **Median aggregation** of each segment's chroma, rejecting transients, before classifying the segment as a whole.

It shows **two lanes on one timeline**:

- **Chords** — the harmony, low-frequency-weighted so a loud melody note doesn't skew the chord.
- **Melody** — the top voice, estimated per frame as the predominant (loudest) pitch in the melody register, then smoothed into notes. This is a heuristic sketch, not full polyphonic transcription: it shines when there's a clear lead over accompaniment and struggles in dense textures or when the melody sits below the harmony.

The timeline uses a fixed time scale: it fills the screen for short takes and **scrolls horizontally** for longer ones. Chord blocks show the name with tones beneath (narrow blocks rotate their label and reveal detail on hover); silent stretches render as a **musical rest** with **barlines** marking each break. Press play (or click/scrub the track) and a cursor follows both lanes, highlighting the current chord and melody note. From there you can:

- **Play / scrub** the recording.
- **Download audio** of the take.
- **Export MIDI** — a two-track (melody + chords) standard `.mid` file.
- **Re-analyze** the same recording after changing detection settings.

A separate **Recording analysis** panel adds granular offline controls: analysis window size, frame overlap, onset sensitivity, minimum chord/melody lengths, and melody detection on/off with its own sensitivity.

## Current scope

A proof of concept that detects **single notes** and a range of chords:

- **Triads** — major, minor, diminished, augmented
- **7th chords** — major 7th, dominant 7th, minor 7th, diminished 7th, half-diminished (m7♭5)
- **Suspended** — sus2, sus4

It also detects **inversions**: when the lowest note is a chord tone other than the root, the chord is named in slash form (e.g. `C/E`) with the inversion labeled. When the evidence for an extension is weak, the detector prefers the simpler chord (e.g. a plain triad over a tentative 7th). Note spelling uses sharps. It is intentionally dependency-free so the core signal-processing logic stays easy to read and iterate on.

## How chords are detected

In addition to the chroma matching above, the bass note is found separately as the lowest prominent spectral peak. Only its pitch class is used, which keeps it robust to octave errors. If that pitch class is a chord tone other than the root, the chord is reported as an inversion.

## Roadmap

- **Beat/onset refinement** — snap boundaries to detected onsets even more tightly, and tempo/beat tracking.
- **Reference & range tuning** — adjustable reference pitch (e.g. 432 Hz) and instrument-specific frequency ranges.
- **Ninth/eleventh/thirteenth chords** and richer voicing labels.
- **Polish** — selectable input device, and a session history of detected notes and chords.

## Project layout

- `index.html` — markup
- `styles.css` — styling
- `js/theme.js` — dark/light theme handling (applied before paint)
- `js/music.js` — note/pitch-class helpers and chord definitions
- `js/pitch.js` — single-note detection (McLeod Pitch Method)
- `js/chord.js` — chroma + harmonic-template chord/note classification
- `js/app.js` — live mode: microphone capture, per-frame analysis, and rendering
- `js/fft.js` — radix-2 FFT for offline analysis
- `js/analysis.js` — offline pipeline: framing, onsets, segmentation, classification
- `js/midi.js` — MIDI file export
- `js/record.js` — record mode: recording, timeline, playback, downloads

## Tech

- Web Audio API (`getUserMedia`, `AnalyserNode`, `decodeAudioData`), `MediaRecorder`
- McLeod Pitch Method for fundamental-frequency estimation
- Chroma + harmonic-template matching for chords; spectral-flux onset detection offline
- Standard MIDI File export
- Vanilla JavaScript, HTML, and CSS — no build tooling

## License

MIT
