/**
 * Encoder/decoder for the documented AHM TCP/IP protocol (spec V1.0).
 *
 * Everything in this file is derived from Allen & Heath's published
 * "AHM TCP/IP Protocol" document. Nothing here is reverse-engineered, and
 * nothing here can write PEQ, delay or dynamics -- the public protocol simply
 * does not carry those. See docs/protocol.md for the coverage boundary.
 */

import { dbToLevel } from './levels.ts';
import { MAX_COUNT, toWire, fromWire, type StripKind, type StripRef } from './addressing.ts';

/** F0 00 00 1A 50 12 <major> <minor>. 00 00 1A is the A&H manufacturer ID. */
export const SYSEX_HEADER = [0xf0, 0x00, 0x00, 0x1a, 0x50, 0x12, 0x01, 0x00] as const;
export const SYSEX_END = 0xf7;

/** NRPN parameter IDs. */
export const PARAM_LEVEL = 0x17;
export const PARAM_LEVEL_DELTA = 0x20;

/** Velocity thresholds. The unit reads >= 0x40 as muted. */
export const MUTE_ON = 0x7f;
export const MUTE_OFF = 0x3f;

/** Default ports. 51325 is plaintext; 51327 expects the TLS auth handshake. */
export const PORT_PLAIN = 51325;
export const PORT_TLS = 51327;

/** Total presets and the bank size they are addressed in. */
export const PRESET_COUNT = 500;
export const PRESET_BANK_SIZE = 128;

export type Bytes = number[];

function sysex(...body: number[]): Bytes {
  return [...SYSEX_HEADER, ...body, SYSEX_END];
}

function assertByte(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0x7f) {
    throw new RangeError(`${what} must be a 7-bit value, got ${value}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Mute
// ---------------------------------------------------------------------------

/**
 * Mute on/off. The spec sends a Note On carrying the state followed by a
 * Note On with velocity 0 -- the trailing message is required, and the unit
 * ignores velocity 0 on its own.
 */
export function setMute(ref: StripRef, muted: boolean): Bytes {
  const { n, ch } = toWire(ref);
  return [0x90 | n, ch, muted ? MUTE_ON : MUTE_OFF, 0x90 | n, ch, 0x00];
}

export function getMute(ref: StripRef): Bytes {
  const { n, ch } = toWire(ref);
  return sysex(0x00 | n, 0x01, 0x09, ch);
}

// ---------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------

export function setLevel(ref: StripRef, level: number): Bytes {
  const { n, ch } = toWire(ref);
  assertByte(level, 'level');
  return [0xb0 | n, 0x63, ch, 0xb0 | n, 0x62, PARAM_LEVEL, 0xb0 | n, 0x06, level];
}

export function setLevelDb(ref: StripRef, db: number): Bytes {
  return setLevel(ref, dbToLevel(db));
}

export function getLevel(ref: StripRef): Bytes {
  const { n, ch } = toWire(ref);
  return sysex(0x00 | n, 0x01, 0x0b, ch);
}

/** Nudge a level by one step. The unit owns the step size. */
export function nudgeLevel(ref: StripRef, direction: 'up' | 'down'): Bytes {
  const { n, ch } = toWire(ref);
  return [
    0xb0 | n, 0x63, ch,
    0xb0 | n, 0x62, PARAM_LEVEL_DELTA,
    0xb0 | n, 0x06, direction === 'up' ? 0x7f : 0x3f,
  ];
}

// ---------------------------------------------------------------------------
// Sends -- the routing matrix
// ---------------------------------------------------------------------------

/**
 * Send level from a source strip to a destination strip. This is the crosspoint
 * of the routing matrix: input -> zone and zone -> zone are both expressed here.
 */
export function setSendLevel(from: StripRef, to: StripRef, level: number): Bytes {
  const src = toWire(from);
  const dst = toWire(to);
  assertByte(level, 'send level');
  return sysex(0x00 | src.n, 0x02, src.ch, dst.n, dst.ch, level);
}

export function setSendLevelDb(from: StripRef, to: StripRef, db: number): Bytes {
  return setSendLevel(from, to, dbToLevel(db));
}

export function getSendLevel(from: StripRef, to: StripRef): Bytes {
  const src = toWire(from);
  const dst = toWire(to);
  return sysex(0x00 | src.n, 0x01, 0x0f, 0x02, src.ch, dst.n, dst.ch);
}

export function setSendMute(from: StripRef, to: StripRef, muted: boolean): Bytes {
  const src = toWire(from);
  const dst = toWire(to);
  return sysex(0x00 | src.n, 0x03, src.ch, dst.n, dst.ch, muted ? MUTE_ON : MUTE_OFF);
}

export function getSendMute(from: StripRef, to: StripRef): Bytes {
  const src = toWire(from);
  const dst = toWire(to);
  return sysex(0x00 | src.n, 0x01, 0x0f, 0x03, src.ch, dst.n, dst.ch);
}

export function nudgeSendLevel(from: StripRef, to: StripRef, direction: 'up' | 'down'): Bytes {
  const src = toWire(from);
  const dst = toWire(to);
  return sysex(0x00 | src.n, 0x04, src.ch, dst.n, dst.ch, direction === 'up' ? 0x7f : 0x3f);
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** Split a 1-based preset number into its bank and program change value. */
export function presetToBankProgram(preset: number): { bank: number; program: number } {
  if (!Number.isInteger(preset) || preset < 1 || preset > PRESET_COUNT) {
    throw new RangeError(`preset ${preset} outside 1..${PRESET_COUNT}`);
  }
  const zero = preset - 1;
  return { bank: Math.floor(zero / PRESET_BANK_SIZE), program: zero % PRESET_BANK_SIZE };
}

export function bankProgramToPreset(bank: number, program: number): number {
  return bank * PRESET_BANK_SIZE + program + 1;
}

/**
 * Recall a preset. Bank select then program change, both on MIDI channel 0 --
 * preset recall is not addressed per strip class, so the N nibble is fixed.
 */
export function recallPreset(preset: number): Bytes {
  const { bank, program } = presetToBankProgram(preset);
  return [0xb0, 0x00, bank, 0xc0, program];
}

// ---------------------------------------------------------------------------
// Source selector and audio playback
// ---------------------------------------------------------------------------

export const SOURCE_COLOURS = [
  'off', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
] as const;
export type SourceColour = (typeof SOURCE_COLOURS)[number];

export const MAX_SOURCE_NUMBER = 20;

/** Select a source on a zone's source selector. Source numbers are 1-based. */
export function selectSource(zoneIndex: number, sourceNumber: number): Bytes {
  const { ch } = toWire({ kind: 'zone', index: zoneIndex });
  if (!Number.isInteger(sourceNumber) || sourceNumber < 1 || sourceNumber > MAX_SOURCE_NUMBER) {
    throw new RangeError(`source ${sourceNumber} outside 1..${MAX_SOURCE_NUMBER}`);
  }
  return sysex(0x00, 0x08, ch, sourceNumber - 1);
}

/** Start an audio playback track. Channel 1 and 2 are the mono players. */
export function playAudioTrack(playbackChannel: 1 | 2, trackId: number): Bytes {
  assertByte(trackId, 'track id');
  return sysex(0x00, 0x06, playbackChannel - 1, trackId);
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export type Incoming =
  | { type: 'mute'; ref: StripRef; muted: boolean }
  | { type: 'level'; ref: StripRef; level: number }
  | { type: 'preset'; preset: number }
  | { type: 'sendLevel'; from: StripRef; to: StripRef; level: number }
  | { type: 'sendMute'; from: StripRef; to: StripRef; muted: boolean }
  | { type: 'source'; zone: number; source: number; colour: SourceColour; name: string }
  | { type: 'unknown'; bytes: Bytes };

interface DecoderState {
  /** Last NRPN parameter selected, per MIDI channel. */
  nrpn: Map<number, { ch: number; param: number }>;
  /** Last bank select value, for pairing with a later program change. */
  bank: number;
}

export function createDecoderState(): DecoderState {
  return { nrpn: new Map(), bank: 0 };
}

function headerMatches(buf: Bytes | Uint8Array, at: number): boolean {
  // The version bytes are deliberately not compared: a unit on a newer minor
  // version still speaks this message set, and rejecting it would be wrong.
  for (let i = 0; i < 6; i++) {
    if (buf[at + i] !== SYSEX_HEADER[i]) return false;
  }
  return true;
}

/**
 * Pull every complete message out of a buffer.
 *
 * Returns the decoded messages plus the number of bytes consumed, so the caller
 * can retain a partial trailing message. TCP gives no message framing, and a
 * SysEx reply carrying a source name can straddle two reads.
 */
export function decode(
  buf: Uint8Array,
  state: DecoderState,
): { messages: Incoming[]; consumed: number } {
  const messages: Incoming[] = [];
  let i = 0;

  while (i < buf.length) {
    const status = buf[i];

    if (status === 0xf0) {
      const end = buf.indexOf(SYSEX_END, i);
      if (end === -1) break; // incomplete -- wait for more bytes
      const msg = decodeSysex(buf.subarray(i, end + 1));
      if (msg) messages.push(msg);
      i = end + 1;
      continue;
    }

    const type = status & 0xf0;
    const n = status & 0x0f;

    if (type === 0x90) {
      if (i + 2 >= buf.length) break;
      const [, ch, velocity] = [status, buf[i + 1], buf[i + 2]];
      // Velocity 0 is the trailing half of the spec's two-message mute and
      // carries no state of its own.
      if (velocity !== 0) {
        messages.push({ type: 'mute', ref: fromWire(n, ch), muted: velocity >= 0x40 });
      }
      i += 3;
      continue;
    }

    if (type === 0xb0) {
      if (i + 2 >= buf.length) break;
      const controller = buf[i + 1];
      const value = buf[i + 2];
      if (controller === 0x63) {
        state.nrpn.set(n, { ch: value, param: -1 });
      } else if (controller === 0x62) {
        const pending = state.nrpn.get(n);
        if (pending) pending.param = value;
      } else if (controller === 0x06) {
        const pending = state.nrpn.get(n);
        if (pending && pending.param === PARAM_LEVEL) {
          messages.push({ type: 'level', ref: fromWire(n, pending.ch), level: value });
        }
      } else if (controller === 0x00) {
        state.bank = value;
      }
      i += 3;
      continue;
    }

    if (type === 0xc0) {
      if (i + 1 >= buf.length) break;
      messages.push({ type: 'preset', preset: bankProgramToPreset(state.bank, buf[i + 1]) });
      i += 2;
      continue;
    }

    // Unrecognised status byte -- skip it rather than stalling the stream.
    messages.push({ type: 'unknown', bytes: [status] });
    i += 1;
  }

  return { messages, consumed: i };
}

function decodeSysex(frame: Uint8Array): Incoming | null {
  if (frame.length < SYSEX_HEADER.length + 2 || !headerMatches(frame, 0)) return null;
  const body = frame.subarray(SYSEX_HEADER.length, frame.length - 1);
  if (body.length < 2) return null;

  const n = body[0] & 0x0f;
  const opcode = body[1];

  switch (opcode) {
    case 0x02:
      if (body.length < 6) return null;
      return {
        type: 'sendLevel',
        from: fromWire(n, body[2]),
        to: fromWire(body[3], body[4]),
        level: body[5],
      };
    case 0x03:
      if (body.length < 6) return null;
      return {
        type: 'sendMute',
        from: fromWire(n, body[2]),
        to: fromWire(body[3], body[4]),
        muted: body[5] >= 0x40,
      };
    case 0x08: {
      // Reply form carries colour and name; the bare set form does not.
      if (body.length < 4) return null;
      const zone = body[2] + 1;
      const source = body[3] + 1;
      const colour = SOURCE_COLOURS[body[4]] ?? 'off';
      const name = String.fromCharCode(...body.subarray(5)).replace(/\0+$/, '').trim();
      return { type: 'source', zone, source, colour, name };
    }
    default:
      return { type: 'unknown', bytes: Array.from(frame) };
  }
}

/** Strip counts for a given unit model. */
export function countsForModel(model: 16 | 32 | 64): Record<StripKind, number> {
  return { input: model, zone: model, controlGroup: MAX_COUNT.controlGroup };
}
