/**
 * A fake AHM that speaks the published TCP/IP protocol.
 *
 * This exists because no AHM hardware is available to this project. It is built
 * from the same spec the client is built from, so it proves the client is
 * SELF-CONSISTENT -- it cannot prove the client is correct against a real unit.
 * Any claim of hardware compatibility must come from a real AHM, not from here.
 *
 * Deliberately models the awkward parts of the spec rather than an idealised
 * version of it, since those are what a client gets wrong:
 *   - mute replies are the two-message Note On pair, velocity 0 included
 *   - level replies are a full three-message NRPN sequence
 *   - a preset recall is echoed back to every client
 *   - unsolicited updates go to other clients, not the originator
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';

import {
  decode,
  createDecoderState,
  setLevel,
  setMute,
  setSendLevel,
  setSendMute,
  recallPreset,
  SYSEX_HEADER,
  SYSEX_END,
  PORT_PLAIN,
} from '../protocol/messages.ts';
import { fromWire, type StripKind, type StripRef } from '../protocol/addressing.ts';
import { crosspointKey } from '../protocol/state.ts';

export interface SimulatorOptions {
  model?: 16 | 32 | 64;
  port?: number;
  host?: string;
}

interface StripState {
  level: number;
  muted: boolean;
}

export class AhmSimulator extends EventEmitter {
  readonly model: 16 | 32 | 64;
  readonly port: number;
  readonly host: string;

  #server: net.Server | null = null;
  #clients = new Set<net.Socket>();
  #strips = new Map<string, StripState>();
  #sends = new Map<string, { level: number; muted: boolean }>();
  #sources = new Map<number, number>();
  #preset = 1;

  constructor(options: SimulatorOptions = {}) {
    super();
    this.model = options.model ?? 64;
    this.port = options.port ?? PORT_PLAIN;
    this.host = options.host ?? '0.0.0.0';
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  get currentPreset(): number {
    return this.#preset;
  }

  #key(ref: StripRef): string {
    return `${ref.kind}:${ref.index}`;
  }

  #strip(ref: StripRef): StripState {
    const key = this.#key(ref);
    let strip = this.#strips.get(key);
    if (!strip) {
      strip = { level: 105, muted: false }; // unity, unmuted
      this.#strips.set(key, strip);
    }
    return strip;
  }

  /** Read simulator state, for assertions in tests. */
  peek(ref: StripRef): StripState {
    return { ...this.#strip(ref) };
  }

  peekSend(from: StripRef, to: StripRef): { level: number; muted: boolean } | null {
    return this.#sends.get(crosspointKey(from, to)) ?? null;
  }

  peekSource(zone: number): number | undefined {
    return this.#sources.get(zone);
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.#onClient(socket));
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : this.port;
        this.emit('listening', port);
        resolve(port);
      });
      this.#server = server;
    });
  }

  async close(): Promise<void> {
    for (const socket of this.#clients) socket.destroy();
    this.#clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
    });
    this.#server = null;
  }

  #onClient(socket: net.Socket): void {
    this.#clients.add(socket);
    this.emit('connection', this.#clients.size);

    const decoderState = createDecoderState();
    let pending = new Uint8Array(0);

    socket.on('data', (chunk) => {
      const buf = new Uint8Array(pending.length + chunk.length);
      buf.set(pending, 0);
      buf.set(chunk, pending.length);

      // Get-requests are sysex frames the shared decoder reports as 'unknown',
      // because they are client->unit only. Handle those before decoding.
      this.#handleQueries(buf, socket);

      const { messages, consumed } = decode(buf, decoderState);
      pending = buf.subarray(consumed);

      for (const message of messages) {
        switch (message.type) {
          case 'level': {
            this.#strip(message.ref).level = message.level;
            this.#broadcast(setLevel(message.ref, message.level), socket);
            this.emit('change', { type: 'level', ref: message.ref, level: message.level });
            break;
          }
          case 'mute': {
            this.#strip(message.ref).muted = message.muted;
            this.#broadcast(setMute(message.ref, message.muted), socket);
            this.emit('change', { type: 'mute', ref: message.ref, muted: message.muted });
            break;
          }
          case 'sendLevel': {
            const key = crosspointKey(message.from, message.to);
            const existing = this.#sends.get(key);
            this.#sends.set(key, { level: message.level, muted: existing?.muted ?? false });
            this.#broadcast(setSendLevel(message.from, message.to, message.level), socket);
            this.emit('change', message);
            break;
          }
          case 'sendMute': {
            const key = crosspointKey(message.from, message.to);
            const existing = this.#sends.get(key);
            this.#sends.set(key, { level: existing?.level ?? 0, muted: message.muted });
            this.#broadcast(setSendMute(message.from, message.to, message.muted), socket);
            this.emit('change', message);
            break;
          }
          case 'preset': {
            this.#preset = message.preset;
            // A real unit transmits the recall to everyone, including whoever
            // asked for it -- that is how a wall plate and an app stay in step.
            this.#broadcast(recallPreset(message.preset), null);
            this.emit('change', message);
            break;
          }
          case 'source': {
            this.#sources.set(message.zone, message.source);
            this.#sendSourceReply(message.zone, message.source);
            this.emit('change', message);
            break;
          }
          default:
            break;
        }
      }
    });

    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.#clients.delete(socket);
      this.emit('connection', this.#clients.size);
    });
  }

  /**
   * Answer the sysex get-requests. Scans for complete frames and replies to the
   * ones whose opcode is a query; everything else is left for the decoder.
   */
  #handleQueries(buf: Uint8Array, socket: net.Socket): void {
    let i = 0;
    while (i < buf.length) {
      const start = buf.indexOf(0xf0, i);
      if (start === -1) return;
      const end = buf.indexOf(SYSEX_END, start);
      if (end === -1) return;

      const body = buf.subarray(start + SYSEX_HEADER.length, end);
      if (body.length >= 3 && body[1] === 0x01) {
        const n = body[0] & 0x0f;
        const opcode = body[2];

        if (opcode === 0x09 && body.length >= 4) {
          const ref = fromWire(n, body[3]);
          socket.write(Buffer.from(setMute(ref, this.#strip(ref).muted)));
        } else if (opcode === 0x0b && body.length >= 4) {
          const ref = fromWire(n, body[3]);
          socket.write(Buffer.from(setLevel(ref, this.#strip(ref).level)));
        } else if (opcode === 0x0f && body.length >= 7) {
          const kind = body[3]; // 0x02 level, 0x03 mute
          const from = fromWire(n, body[4]);
          const to = fromWire(body[5], body[6]);
          const send = this.#sends.get(crosspointKey(from, to)) ?? { level: 0, muted: false };
          socket.write(
            Buffer.from(
              kind === 0x03
                ? setSendMute(from, to, send.muted)
                : setSendLevel(from, to, send.level),
            ),
          );
        }
      }
      i = end + 1;
    }
  }

  #sendSourceReply(zone: number, source: number): void {
    const name = `Source ${source}`;
    const colour = (source % 7) + 1;
    const frame = [
      ...SYSEX_HEADER,
      0x00,
      0x08,
      zone - 1,
      source - 1,
      colour,
      ...[...name].map((c) => c.charCodeAt(0)),
      SYSEX_END,
    ];
    this.#broadcast(frame, null);
  }

  #broadcast(bytes: number[], except: net.Socket | null): void {
    const payload = Buffer.from(bytes);
    for (const client of this.#clients) {
      if (client !== except) client.write(payload);
    }
  }

  /** Drive a change from the "front panel", to exercise unsolicited updates. */
  simulateLocalChange(kind: StripKind, index: number, level: number): void {
    const ref: StripRef = { kind, index };
    this.#strip(ref).level = level;
    this.#broadcast(setLevel(ref, level), null);
  }
}
