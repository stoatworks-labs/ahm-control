/**
 * Reader for the AHM System Manager ".cfg" system file.
 *
 * The container is a gzip'd POSIX tar holding an `archive/` directory:
 *
 *   archive/Mixer.cfg                 - channel geometry, plain text
 *   archive/Version.txt               - firmware/format version, plain text
 *   archive/UnitType_AHM-64-Unit.txt  - zero bytes; the MODEL IS THE FILENAME
 *   archive/CurrentSettings.dat       - live parameter blob
 *   archive/Scene1.dat                - scene parameter blob
 *   archive/Devices/                  - per-device data, empty in factory files
 *
 * Only the plain-text members are decoded here. The two .dat blobs are a fixed
 * layout struct dump whose field map is not published and not yet reversed;
 * they are handed back as raw bytes rather than guessed at.
 */

import { gunzipSync } from 'node:zlib';
import { parseMixerConfig, type MixerConfig } from './mixer.ts';

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

const TAR_BLOCK = 512;

/**
 * Minimal POSIX tar reader. Only what this container uses: regular files and
 * directories, no long-name extensions, no sparse files.
 */
export function untar(buf: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  const decoder = new TextDecoder();
  let offset = 0;

  while (offset + TAR_BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + TAR_BLOCK);

    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) break;

    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, '');
    const sizeField = decoder.decode(header.subarray(124, 136)).replace(/[\0 ]/g, '');
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    const typeFlag = String.fromCharCode(header[156]);

    offset += TAR_BLOCK;

    if (typeFlag === '0' || typeFlag === '\0') {
      entries.push({ name, data: buf.subarray(offset, offset + size) });
    }

    // Payloads are padded up to the next block boundary.
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }

  return entries;
}

export type AhmModel = 16 | 32 | 64;

export interface AhmSystemConfig {
  model: AhmModel;
  /** Raw contents of Version.txt, e.g. "V1.6X - Rev. 92182 - Build. 30". */
  version: string;
  mixer: MixerConfig;
  /** Undecoded members, kept so the RE track has something to work against. */
  raw: Map<string, Uint8Array>;
}

const UNIT_TYPE_PATTERN = /UnitType_AHM-(16|32|64)-Unit\.txt$/;

/** Parse a .cfg file that has already been read into memory. */
export function readSystemConfig(cfgBytes: Uint8Array): AhmSystemConfig {
  const tar = untar(gunzipSync(cfgBytes));
  const raw = new Map<string, Uint8Array>();
  for (const entry of tar) raw.set(entry.name, entry.data);

  const decoder = new TextDecoder();

  // The unit type marker file is empty -- its NAME is the payload. Reading its
  // contents gets you nothing, which is an easy hour to lose.
  let model: AhmModel | null = null;
  for (const name of raw.keys()) {
    const match = UNIT_TYPE_PATTERN.exec(name);
    if (match) {
      model = Number(match[1]) as AhmModel;
      break;
    }
  }
  if (model === null) {
    throw new Error('no UnitType_AHM-<model>-Unit.txt member; not an AHM system file');
  }

  const mixerBytes = raw.get('archive/Mixer.cfg');
  if (!mixerBytes) throw new Error('missing archive/Mixer.cfg');

  const versionBytes = raw.get('archive/Version.txt');

  return {
    model,
    version: versionBytes ? decoder.decode(versionBytes).trim() : '',
    mixer: parseMixerConfig(decoder.decode(mixerBytes)),
    raw,
  };
}
