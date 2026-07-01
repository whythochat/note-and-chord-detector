// Minimal Standard MIDI File (format 0) writer. Turns analyzed segments into a
// single-track MIDI file: each note/chord segment becomes note-on/note-off
// events spanning its time range.

const MIDI_DIVISION = 480;            // ticks per quarter note
const MIDI_TEMPO_US = 500000;         // 120 BPM (microseconds per quarter)
const MIDI_TICKS_PER_SEC = MIDI_DIVISION * (1e6 / MIDI_TEMPO_US); // 960

/** Encode a number as a MIDI variable-length quantity. */
function vlq(value) {
  const bytes = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}

/**
 * Build a MIDI file from analyzed segments.
 *
 * @param {Array<{start:number, end:number, type:string, midi:number[]}>} segments
 * @returns {Blob} An `audio/midi` blob ready for download.
 */
function segmentsToMidi(segments) {
  // Collect note events with absolute ticks.
  const events = [];
  for (const seg of segments) {
    if (seg.type === "none" || !seg.midi || seg.midi.length === 0) continue;
    const onTick = Math.round(seg.start * MIDI_TICKS_PER_SEC);
    const offTick = Math.max(onTick + 1, Math.round(seg.end * MIDI_TICKS_PER_SEC));
    for (const note of seg.midi) {
      events.push({ tick: onTick, on: true, note });
      events.push({ tick: offTick, on: false, note });
    }
  }
  // Sort by tick; note-offs before note-ons at the same tick.
  events.sort((a, b) => a.tick - b.tick || (a.on === b.on ? 0 : a.on ? 1 : -1));

  const track = [];
  // Tempo meta event: FF 51 03 tttttt
  track.push(0x00, 0xff, 0x51, 0x03,
    (MIDI_TEMPO_US >> 16) & 0xff, (MIDI_TEMPO_US >> 8) & 0xff, MIDI_TEMPO_US & 0xff);

  let prevTick = 0;
  for (const ev of events) {
    const delta = ev.tick - prevTick;
    prevTick = ev.tick;
    track.push(...vlq(delta));
    track.push(ev.on ? 0x90 : 0x80, ev.note & 0x7f, ev.on ? 80 : 0);
  }
  // End of track: FF 2F 00
  track.push(0x00, 0xff, 0x2f, 0x00);

  const header = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, // "MThd", length 6
    0x00, 0x00,                                     // format 0
    0x00, 0x01,                                     // one track
    (MIDI_DIVISION >> 8) & 0xff, MIDI_DIVISION & 0xff,
  ];
  const len = track.length;
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b,      // "MTrk"
    (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff];

  return new Blob([new Uint8Array(header), new Uint8Array(trackHeader), new Uint8Array(track)],
    { type: "audio/midi" });
}
