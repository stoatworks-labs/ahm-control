/**
 * Channel addressing for the AHM TCP/IP protocol.
 *
 * Every addressable strip is a (MIDI channel, note number) pair. The MIDI
 * channel selects the class of strip, the note number selects the index within
 * it. All indices on the wire are 0-based; everything user-facing is 1-based.
 */

/**
 * Strip classes, and the MIDI channel nibble (N) that selects each one.
 *
 * A plain object rather than an enum: Node runs this file by stripping types,
 * and an enum is not erasable syntax.
 */
export const StripClass = {
  Input: 0,
  Zone: 1,
  ControlGroup: 2,
} as const;

export type StripKind = 'input' | 'zone' | 'controlGroup';

export const STRIP_MIDI_CHANNEL: Record<StripKind, number> = {
  input: StripClass.Input,
  zone: StripClass.Zone,
  controlGroup: StripClass.ControlGroup,
};

/** Maximum count per class on the largest unit (AHM-64). */
export const MAX_COUNT: Record<StripKind, number> = {
  input: 64,
  zone: 64,
  controlGroup: 32,
};

export interface StripRef {
  kind: StripKind;
  /** 1-based, as printed on the unit and shown in System Manager. */
  index: number;
}

export function stripKindFromMidiChannel(n: number): StripKind {
  switch (n & 0x0f) {
    case StripClass.Input:
      return 'input';
    case StripClass.Zone:
      return 'zone';
    case StripClass.ControlGroup:
      return 'controlGroup';
    default:
      throw new RangeError(`no strip class for MIDI channel ${n}`);
  }
}

/** Wire form: { n, ch } with ch 0-based. Throws if the index is out of range. */
export function toWire(ref: StripRef): { n: number; ch: number } {
  const max = MAX_COUNT[ref.kind];
  if (!Number.isInteger(ref.index) || ref.index < 1 || ref.index > max) {
    throw new RangeError(`${ref.kind} index ${ref.index} outside 1..${max}`);
  }
  return { n: STRIP_MIDI_CHANNEL[ref.kind], ch: ref.index - 1 };
}

export function fromWire(n: number, ch: number): StripRef {
  return { kind: stripKindFromMidiChannel(n), index: ch + 1 };
}

export function stripId(ref: StripRef): string {
  return `${ref.kind}:${ref.index}`;
}

export function parseStripId(id: string): StripRef {
  const [kind, raw] = id.split(':');
  if (kind !== 'input' && kind !== 'zone' && kind !== 'controlGroup') {
    throw new RangeError(`bad strip id ${id}`);
  }
  return { kind, index: Number(raw) };
}
