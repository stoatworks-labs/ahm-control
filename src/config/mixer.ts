/**
 * Parser for `archive/Mixer.cfg`, the plain-text channel geometry block.
 *
 * Format, CRLF terminated:
 *
 *   L1  MixerConfigV2         magic
 *   L2  m/S map, N/2 chars    pairing map A
 *   L3  m/S map, N/2 chars    pairing map B
 *   L4  decimal count         see below
 *   L5  '0' x N               per-channel field, all zero in every factory file
 *   L6  'N' x N/2             per-pair field, all 'N' in every factory file
 *
 * N is the model size (16/32/64), confirmed across all six factory configs that
 * ship with System Manager 1.61: every line length scales with N exactly.
 *
 * 'm' is mono and 'S' is stereo -- each map character covers a PAIR of channels,
 * which is why the maps are N/2 long.
 *
 * L4 is deliberately NOT derived from the maps. On the "Empty" configs it equals
 * N, which looks like "2 per map slot", but no per-slot weighting reproduces the
 * "Default" configs (AHM-16 6m+2S -> 12, AHM-32 14m+2S -> 24, AHM-64 28m+4S ->
 * 52). It is read as an independent field and its exact meaning is unconfirmed.
 */

export type Pairing = 'mono' | 'stereo';

export interface MixerConfig {
  magic: string;
  /** Pairing map A, one entry per channel pair. */
  mapA: Pairing[];
  /** Pairing map B, one entry per channel pair. */
  mapB: Pairing[];
  /**
   * The L4 count. Meaning unconfirmed -- see the note above. Exposed verbatim
   * rather than reinterpreted, so nothing downstream depends on a guess.
   */
  declaredCount: number;
  /** Model size implied by the line lengths (mapA.length * 2). */
  channelCount: number;
  line5: string;
  line6: string;
}

export const MIXER_MAGIC = 'MixerConfigV2';

function parseMap(line: string, label: string): Pairing[] {
  const out: Pairing[] = [];
  for (const ch of line) {
    if (ch === 'm') out.push('mono');
    else if (ch === 'S') out.push('stereo');
    else throw new Error(`unexpected '${ch}' in Mixer.cfg ${label}`);
  }
  return out;
}

export function parseMixerConfig(text: string): MixerConfig {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
  if (lines[0] !== MIXER_MAGIC) {
    throw new Error(`unexpected Mixer.cfg magic ${JSON.stringify(lines[0])}`);
  }

  const mapA = parseMap(lines[1] ?? '', 'line 2');
  const mapB = parseMap(lines[2] ?? '', 'line 3');
  const declaredCount = Number((lines[3] ?? '').trim());

  if (mapA.length !== mapB.length) {
    throw new Error(`Mixer.cfg pairing maps differ in length (${mapA.length} vs ${mapB.length})`);
  }
  if (!Number.isFinite(declaredCount)) {
    throw new Error(`Mixer.cfg line 4 is not a number: ${JSON.stringify(lines[3])}`);
  }

  return {
    magic: lines[0],
    mapA,
    mapB,
    declaredCount,
    channelCount: mapA.length * 2,
    line5: lines[4] ?? '',
    line6: lines[5] ?? '',
  };
}

/**
 * Expand a pairing map into per-channel entries, so a topology view can lay out
 * strips without repeating the pair arithmetic.
 */
export function expandPairs(map: Pairing[]): Array<{ channel: number; pairing: Pairing; isRight: boolean }> {
  const out: Array<{ channel: number; pairing: Pairing; isRight: boolean }> = [];
  map.forEach((pairing, i) => {
    out.push({ channel: i * 2 + 1, pairing, isRight: false });
    out.push({ channel: i * 2 + 2, pairing, isRight: true });
  });
  return out;
}
