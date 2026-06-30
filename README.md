# Note & Chord Detector

A browser-based pitch detector that listens to your device's microphone and reports, in real time, which musical note is being played — along with its frequency, octave, and how many cents sharp or flat it is.

No installation, no build step, no dependencies: it's a single HTML file using the Web Audio API.

## Demo

Open `index.html` in a modern browser (Chrome, Edge, Firefox, or Safari), click **Start listening**, allow microphone access, and play a single note on any instrument.

Most browsers require a **secure context** for microphone access. Opening the file directly (`file://`) works in many desktop browsers; if yours blocks it, serve the folder locally:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## How it works

1. **Capture** — `getUserMedia` opens the mic and feeds an `AnalyserNode`, which exposes the raw audio waveform.
2. **Pitch detection** — each animation frame, the waveform is run through the **McLeod Pitch Method (MPM)**. MPM computes a Normalized Square Difference Function and selects the first strong periodicity peak, which makes it robust against the octave errors that plain autocorrelation produces on low notes (where the fundamental can be weaker than its harmonics).
3. **Note mapping** — the detected frequency is converted to a MIDI note number (A4 = 440 Hz), then to a note name, octave, and a cents offset from perfect pitch.
4. **Readout** — the note, frequency, cents, and a tuner-style needle update live. A clarity threshold gates out silence and noise so only confident pitches are shown.

## Current scope

This is an early proof of concept focused on **monophonic** (single-note) detection. It is intentionally minimal — one file, no framework — to keep the core signal-processing logic easy to read and iterate on.

## Roadmap

- **Chord detection** — move to a frequency-domain approach (FFT spectrum) to identify multiple simultaneous fundamentals, then match the detected pitch classes against chord templates (major, minor, diminished, augmented, common 7ths) to name the chord and its quality.
- **Inversion & voicing awareness** — distinguish a C major triad from its inversions and report the bass note.
- **Confidence & stability** — temporal smoothing across frames to steady the readout and suppress transient flicker on note attacks.
- **Visualization** — add a live frequency spectrum / spectrogram view.
- **Reference & range tuning** — adjustable reference pitch (e.g. 432 Hz) and instrument-specific frequency ranges.
- **Polish** — mobile-friendly layout, selectable input device, and a session history of detected notes.

## Tech

- Web Audio API (`getUserMedia`, `AnalyserNode`)
- McLeod Pitch Method for fundamental-frequency estimation
- Vanilla JavaScript, HTML, and CSS — no build tooling

## License

MIT
