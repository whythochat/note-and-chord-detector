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

/** ASCII bytes of a string (for track-name meta events). */
function ascii(s) {
  return [...s].map((c) => c.charCodeAt(0) & 0x7f);
}

/**
 * Encode one MTrk chunk from analyzed segments.
 *
 * @param {Array<{start:number, end:number, type:string, midi:number[]}>} segments
 * @param {string} name - Track name (meta event).
 * @param {boolean} withTempo - Emit the tempo meta at the start (first track only).
 * @returns {number[]} The full MTrk chunk bytes (header + body).
 */
function encodeTrack(segments, name, withTempo) {
  const events = [];
  for (const seg of segments || []) {
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

  const body = [];
  if (withTempo) {
    body.push(0x00, 0xff, 0x51, 0x03,
      (MIDI_TEMPO_US >> 16) & 0xff, (MIDI_TEMPO_US >> 8) & 0xff, MIDI_TEMPO_US & 0xff);
  }
  if (name) {
    const nm = ascii(name);
    body.push(0x00, 0xff, 0x03, ...vlq(nm.length), ...nm);
  }
  let prevTick = 0;
  for (const ev of events) {
    body.push(...vlq(ev.tick - prevTick));
    prevTick = ev.tick;
    body.push(ev.on ? 0x90 : 0x80, ev.note & 0x7f, ev.on ? 80 : 0);
  }
  body.push(0x00, 0xff, 0x2f, 0x00); // end of track

  const len = body.length;
  return [0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...body];
}

/**
 * Build a multi-track MIDI file (format 1) from named segment tracks. Tracks
 * with no notes are skipped.
 *
 * @param {Array<{name:string, segments:Array<object>}>} tracks
 * @returns {Blob} An `audio/midi` blob ready for download.
 */
function tracksToMidi(tracks) {
  const used = tracks.filter((t) => (t.segments || []).some((s) => s.type !== "none" && s.midi && s.midi.length));
  const list = used.length ? used : [{ name: "Track", segments: [] }];
  const chunks = list.map((t, i) => encodeTrack(t.segments, t.name, i === 0));

  const header = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, // "MThd", length 6
    0x00, 0x01,                                     // format 1
    (list.length >> 8) & 0xff, list.length & 0xff,  // track count
    (MIDI_DIVISION >> 8) & 0xff, MIDI_DIVISION & 0xff,
  ];
  const bytes = [...header];
  for (const c of chunks) bytes.push(...c);
  return new Blob([new Uint8Array(bytes)], { type: "audio/midi" });
}
