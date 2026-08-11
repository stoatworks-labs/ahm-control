/**
 * Every byte sequence asserted here is taken from Allen & Heath's published
 * "AHM TCP/IP Protocol V1.0" document, not from observing a unit. No AHM
 * hardware has ever been connected to this code -- see AGENTS.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dbToLevel,
  levelToDb,
  formatLevel,
  MIN_DB,
  MAX_DB,
} from '../src/protocol/levels.ts';
import { toWire, fromWire, parseStripId, stripId } from '../src/protocol/addressing.ts';
import {
  setMute,
  getMute,
  setLevel,
  getLevel,
  nudgeLevel,
  setSendLevel,
  getSendLevel,
  setSendMute,
  getSendMute,
  recallPreset,
  presetToBankProgram,
  selectSource,
  playAudioTrack,
  decode,
  createDecoderState,
  SYSEX_HEADER,
  PRESET_COUNT,
} from '../src/protocol/messages.ts';

const hdr = [...SYSEX_HEADER];

test('sysex header is the documented A&H/AHM header', () => {
  assert.deepEqual(hdr, [0xf0, 0x00, 0x00, 0x1a, 0x50, 0x12, 0x01, 0x00]);
});

test('strip classes map to the documented MIDI channels', () => {
  assert.deepEqual(toWire({ kind: 'input', index: 1 }), { n: 0, ch: 0x00 });
  assert.deepEqual(toWire({ kind: 'input', index: 64 }), { n: 0, ch: 0x3f });
  assert.deepEqual(toWire({ kind: 'zone', index: 1 }), { n: 1, ch: 0x00 });
  assert.deepEqual(toWire({ kind: 'zone', index: 64 }), { n: 1, ch: 0x3f });
  assert.deepEqual(toWire({ kind: 'controlGroup', index: 1 }), { n: 2, ch: 0x00 });
  assert.deepEqual(toWire({ kind: 'controlGroup', index: 32 }), { n: 2, ch: 0x1f });
});

test('strip indices outside the documented range are rejected', () => {
  assert.throws(() => toWire({ kind: 'input', index: 0 }), RangeError);
  assert.throws(() => toWire({ kind: 'input', index: 65 }), RangeError);
  // Control groups stop at 32 even though inputs and zones go to 64.
  assert.throws(() => toWire({ kind: 'controlGroup', index: 33 }), RangeError);
});

test('strip ids round-trip', () => {
  const ref = { kind: 'zone', index: 12 } as const;
  assert.deepEqual(parseStripId(stripId(ref)), ref);
  assert.deepEqual(fromWire(1, 11), ref);
});

test('mute is a state message followed by a velocity-0 message', () => {
  assert.deepEqual(setMute({ kind: 'input', index: 1 }, true), [0x90, 0x00, 0x7f, 0x90, 0x00, 0x00]);
  assert.deepEqual(setMute({ kind: 'input', index: 1 }, false), [0x90, 0x00, 0x3f, 0x90, 0x00, 0x00]);
  // Zones sit on MIDI channel 1, so the status byte is 0x91.
  assert.deepEqual(setMute({ kind: 'zone', index: 64 }, true), [0x91, 0x3f, 0x7f, 0x91, 0x3f, 0x00]);
});

test('level is an NRPN on parameter 0x17', () => {
  assert.deepEqual(setLevel({ kind: 'zone', index: 1 }, 0x69), [
    0xb1, 0x63, 0x00,
    0xb1, 0x62, 0x17,
    0xb1, 0x06, 0x69,
  ]);
});

test('level nudge uses parameter 0x20 with 0x7f up and 0x3f down', () => {
  assert.deepEqual(nudgeLevel({ kind: 'input', index: 3 }, 'up'), [
    0xb0, 0x63, 0x02, 0xb0, 0x62, 0x20, 0xb0, 0x06, 0x7f,
  ]);
  assert.deepEqual(nudgeLevel({ kind: 'input', index: 3 }, 'down'), [
    0xb0, 0x63, 0x02, 0xb0, 0x62, 0x20, 0xb0, 0x06, 0x3f,
  ]);
});

test('get requests are sysex with the documented opcodes', () => {
  assert.deepEqual(getMute({ kind: 'input', index: 1 }), [...hdr, 0x00, 0x01, 0x09, 0x00, 0xf7]);
  assert.deepEqual(getLevel({ kind: 'input', index: 1 }), [...hdr, 0x00, 0x01, 0x0b, 0x00, 0xf7]);
});

test('send level and mute carry both endpoints', () => {
  const input5 = { kind: 'input', index: 5 } as const;
  const zone3 = { kind: 'zone', index: 3 } as const;

  assert.deepEqual(setSendLevel(input5, zone3, 0x69), [
    ...hdr, 0x00, 0x02, 0x04, 0x01, 0x02, 0x69, 0xf7,
  ]);
  assert.deepEqual(setSendMute(input5, zone3, true), [
    ...hdr, 0x00, 0x03, 0x04, 0x01, 0x02, 0x7f, 0xf7,
  ]);
  assert.deepEqual(getSendLevel(input5, zone3), [
    ...hdr, 0x00, 0x01, 0x0f, 0x02, 0x04, 0x01, 0x02, 0xf7,
  ]);
  assert.deepEqual(getSendMute(input5, zone3), [
    ...hdr, 0x00, 0x01, 0x0f, 0x03, 0x04, 0x01, 0x02, 0xf7,
  ]);
});

test('zone-to-zone sends address the source on the zone MIDI channel', () => {
  assert.deepEqual(setSendLevel({ kind: 'zone', index: 1 }, { kind: 'zone', index: 2 }, 0x7f), [
    ...hdr, 0x01, 0x02, 0x00, 0x01, 0x01, 0x7f, 0xf7,
  ]);
});

test('preset banking matches the documented four banks', () => {
  assert.deepEqual(presetToBankProgram(1), { bank: 0, program: 0x00 });
  assert.deepEqual(presetToBankProgram(128), { bank: 0, program: 0x7f });
  assert.deepEqual(presetToBankProgram(129), { bank: 1, program: 0x00 });
  assert.deepEqual(presetToBankProgram(256), { bank: 1, program: 0x7f });
  assert.deepEqual(presetToBankProgram(257), { bank: 2, program: 0x00 });
  assert.deepEqual(presetToBankProgram(385), { bank: 3, program: 0x00 });
  // The last bank is short: 500 is the top preset and lands on 0x73.
  assert.deepEqual(presetToBankProgram(500), { bank: 3, program: 0x73 });
  assert.throws(() => presetToBankProgram(PRESET_COUNT + 1), RangeError);
  assert.throws(() => presetToBankProgram(0), RangeError);
});

test('preset recall is bank select then program change on channel 0', () => {
  assert.deepEqual(recallPreset(1), [0xb0, 0x00, 0x00, 0xc0, 0x00]);
  assert.deepEqual(recallPreset(500), [0xb0, 0x00, 0x03, 0xc0, 0x73]);
});

test('source select and audio playback are zero-based on the wire', () => {
  assert.deepEqual(selectSource(1, 1), [...hdr, 0x00, 0x08, 0x00, 0x00, 0xf7]);
  assert.deepEqual(selectSource(64, 20), [...hdr, 0x00, 0x08, 0x3f, 0x13, 0xf7]);
  assert.throws(() => selectSource(1, 21), RangeError);
  assert.deepEqual(playAudioTrack(2, 0x05), [...hdr, 0x00, 0x06, 0x01, 0x05, 0xf7]);
});

// ---------------------------------------------------------------------------
// Level curve
// ---------------------------------------------------------------------------

test('level curve is exact at unity and at the rails', () => {
  assert.equal(dbToLevel(0), 0x69); // 105 -- the documented unity value
  assert.equal(dbToLevel(MAX_DB), 0x7f);
  assert.equal(dbToLevel(MIN_DB), 0x00);
  assert.equal(dbToLevel(-Infinity), 0x00);
});

test('level curve matches the published reference table', () => {
  // Two rows of the published table are omitted here because the table and the
  // formula printed in the same document disagree; see docs/protocol.md.
  const table: Array<[number, number]> = [
    [0, 105], [-5, 94], [-10, 83], [-15, 72], [-20, 61],
    [-25, 50], [-30, 39], [-35, 28], [-40, 17], [-45, 6],
  ];
  for (const [db, expected] of table) {
    assert.equal(dbToLevel(db), expected, `${db} dB should encode to ${expected}`);
  }
});

test('levels clamp rather than wrap outside the range', () => {
  assert.equal(dbToLevel(999), 0x7f);
  assert.equal(dbToLevel(-999), 0x00);
});

test('level bytes round-trip back to dB within half a step', () => {
  for (let byte = 0; byte <= 127; byte++) {
    assert.equal(dbToLevel(levelToDb(byte)), byte);
  }
});

test('formatLevel reports the bottom of the range as -inf', () => {
  assert.equal(formatLevel(0), '-inf');
  assert.equal(formatLevel(0x69), '0.0 dB'); // unity
  assert.equal(formatLevel(0x7f), '+10.0 dB');
});

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function decodeAll(bytes: number[]) {
  return decode(Uint8Array.from(bytes), createDecoderState());
}

test('decodes a mute and ignores the velocity-0 tail', () => {
  const { messages } = decodeAll(setMute({ kind: 'zone', index: 2 }, true));
  assert.deepEqual(messages, [{ type: 'mute', ref: { kind: 'zone', index: 2 }, muted: true }]);
});

test('decodes a level NRPN only once the value byte arrives', () => {
  const { messages } = decodeAll(setLevel({ kind: 'input', index: 7 }, 0x40));
  assert.deepEqual(messages, [{ type: 'level', ref: { kind: 'input', index: 7 }, level: 0x40 }]);
});

test('decodes a preset recall echoed by the unit', () => {
  const { messages } = decodeAll(recallPreset(300));
  assert.deepEqual(messages, [{ type: 'preset', preset: 300 }]);
});

test('decodes a send level', () => {
  const { messages } = decodeAll(
    setSendLevel({ kind: 'input', index: 5 }, { kind: 'zone', index: 3 }, 0x69),
  );
  assert.deepEqual(messages, [
    {
      type: 'sendLevel',
      from: { kind: 'input', index: 5 },
      to: { kind: 'zone', index: 3 },
      level: 0x69,
    },
  ]);
});

test('decodes the source-select reply with colour and name', () => {
  const name = [...'Stage'].map((c) => c.charCodeAt(0));
  const { messages } = decodeAll([...hdr, 0x00, 0x08, 0x02, 0x04, 0x02, ...name, 0xf7]);
  assert.deepEqual(messages, [
    { type: 'source', zone: 3, source: 5, colour: 'green', name: 'Stage' },
  ]);
});

test('holds back a sysex frame split across two reads', () => {
  const full = getSendLevel({ kind: 'input', index: 1 }, { kind: 'zone', index: 1 });
  const state = createDecoderState();

  const first = decode(Uint8Array.from(full.slice(0, 5)), state);
  assert.deepEqual(first.messages, []);
  assert.equal(first.consumed, 0, 'a partial frame must not be consumed');

  // The caller retains the unconsumed bytes and prepends them to the next read.
  const second = decode(Uint8Array.from(full), state);
  assert.equal(second.consumed, full.length);
});

test('an NRPN split across reads still resolves via decoder state', () => {
  const state = createDecoderState();
  const bytes = setLevel({ kind: 'zone', index: 4 }, 0x50);

  const first = decode(Uint8Array.from(bytes.slice(0, 6)), state);
  assert.deepEqual(first.messages, []);

  const second = decode(Uint8Array.from(bytes.slice(6)), state);
  assert.deepEqual(second.messages, [
    { type: 'level', ref: { kind: 'zone', index: 4 }, level: 0x50 },
  ]);
});
