/**
 * The connection to an AHM unit: one TCP socket, a state cache, and the
 * translation between UI intents and protocol bytes.
 *
 * Reconnects with backoff, because an install processor outlives any control
 * app that talks to it and a dropped link must heal without a restart.
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
  getLevel,
  getMute,
  recallPreset,
  selectSource,
  PORT_PLAIN,
  type Incoming,
} from '../protocol/messages.ts';
import type { StripRef } from '../protocol/addressing.ts';
import {
  createSystemState,
  crosspointKey,
  stripsFor,
  type SystemState,
} from '../protocol/state.ts';

export interface DeviceOptions {
  host: string;
  port?: number;
  model?: 16 | 32 | 64;
  /** Poll the unit for level/mute on connect, to seed the cache. */
  syncOnConnect?: boolean;
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** Quiet period after a write before reading the value back to confirm it. */
const CONFIRM_DELAY_MS = 120;

export class AhmDevice extends EventEmitter {
  readonly state: SystemState;

  #socket: net.Socket | null = null;
  #decoder = createDecoderState();
  #pending = new Uint8Array(0);
  #reconnectDelay = RECONNECT_MIN_MS;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #confirmTimers = new Map<string, NodeJS.Timeout>();
  #closed = false;
  #options: Required<Omit<DeviceOptions, 'model'>> & { model: 16 | 32 | 64 };

  constructor(options: DeviceOptions) {
    super();
    const model = options.model ?? 64;
    this.#options = {
      host: options.host,
      port: options.port ?? PORT_PLAIN,
      syncOnConnect: options.syncOnConnect ?? true,
      model,
    };
    this.state = createSystemState(model);
    this.state.host = this.#options.host;
    this.state.port = this.#options.port;
  }

  connect(): void {
    this.#closed = false;
    this.#openSocket();
  }

  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    // Pending read-backs would otherwise keep the event loop alive after close.
    for (const timer of this.#confirmTimers.values()) clearTimeout(timer);
    this.#confirmTimers.clear();
    this.#socket?.destroy();
    this.#socket = null;
    this.#setStatus('disconnected');
  }

  #openSocket(): void {
    this.#setStatus('connecting');
    const socket = net.createConnection(
      { host: this.#options.host, port: this.#options.port },
      () => {
        this.#reconnectDelay = RECONNECT_MIN_MS;
        this.state.error = null;
        this.#setStatus('connected');
        if (this.#options.syncOnConnect) this.#requestSync();
      },
    );

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (err) => {
      this.state.error = err.message;
      this.#setStatus('error');
    });
    socket.on('close', () => {
      this.#socket = null;
      // The decoder holds half-parsed NRPN state; a new link must start clean.
      this.#decoder = createDecoderState();
      this.#pending = new Uint8Array(0);
      if (!this.#closed) this.#scheduleReconnect();
    });

    this.#socket = socket;
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer) return;
    this.#setStatus('disconnected');
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#closed) this.#openSocket();
    }, this.#reconnectDelay);
    this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  #setStatus(status: SystemState['status']): void {
    if (this.state.status === status) return;
    this.state.status = status;
    this.emit('status', status);
    this.emit('state', this.state);
  }

  #onData(chunk: Buffer): void {
    // Prepend whatever the last read could not complete. TCP does not preserve
    // message boundaries, and a source-name reply is long enough to straddle.
    const buf = new Uint8Array(this.#pending.length + chunk.length);
    buf.set(this.#pending, 0);
    buf.set(chunk, this.#pending.length);

    const { messages, consumed } = decode(buf, this.#decoder);
    this.#pending = buf.subarray(consumed);

    for (const message of messages) this.#apply(message);
    if (messages.length) this.emit('state', this.state);
  }

  #apply(message: Incoming): void {
    switch (message.type) {
      case 'level': {
        const strip = this.#strip(message.ref);
        if (strip) {
          strip.level = message.level;
          strip.origin = 'device';
        }
        break;
      }
      case 'mute': {
        const strip = this.#strip(message.ref);
        if (strip) {
          strip.muted = message.muted;
          strip.origin = 'device';
        }
        break;
      }
      case 'sendLevel': {
        const key = crosspointKey(message.from, message.to);
        const existing = this.state.sends[key];
        this.state.sends[key] = {
          level: message.level,
          muted: existing?.muted ?? false,
          origin: 'device',
        };
        break;
      }
      case 'sendMute': {
        const key = crosspointKey(message.from, message.to);
        const existing = this.state.sends[key];
        this.state.sends[key] = {
          level: existing?.level ?? 0,
          muted: message.muted,
          origin: 'device',
        };
        break;
      }
      case 'preset':
        this.state.currentPreset = message.preset;
        break;
      case 'source':
        this.state.sources[message.zone] = message.source;
        if (message.name) {
          const zone = this.state.zones[message.zone - 1];
          // The unit only names the SOURCE here, never the zone -- do not let
          // this overwrite a zone name.
          if (zone) this.emit('sourceName', { zone: message.zone, name: message.name });
        }
        break;
      case 'unknown':
        this.emit('unknown', message.bytes);
        break;
    }
    this.emit('message', message);
  }

  #strip(ref: StripRef) {
    return stripsFor(this.state, ref.kind)[ref.index - 1] ?? null;
  }

  #send(bytes: number[]): boolean {
    if (!this.#socket || this.state.status !== 'connected') return false;
    this.#socket.write(Buffer.from(bytes));
    return true;
  }

  /**
   * Read a value back after writing it, to turn 'pending' into 'device'.
   *
   * The spec documents that the unit echoes a PRESET RECALL, but says nothing
   * about whether it echoes a level or mute back to the client that sent it.
   * Rather than assume either way, confirm by asking. Debounced per strip so a
   * fader drag produces one read-back at the end instead of one per pixel.
   */
  #confirm(ref: StripRef): void {
    const key = `${ref.kind}:${ref.index}`;
    clearTimeout(this.#confirmTimers.get(key));
    this.#confirmTimers.set(
      key,
      setTimeout(() => {
        this.#confirmTimers.delete(key);
        this.#send(getLevel(ref));
        this.#send(getMute(ref));
      }, CONFIRM_DELAY_MS),
    );
  }

  /** Seed the cache. Only levels and mutes are queryable per strip. */
  #requestSync(): void {
    const kinds = [
      { kind: 'input' as const, count: this.state.inputs.length },
      { kind: 'zone' as const, count: this.state.zones.length },
      { kind: 'controlGroup' as const, count: this.state.controlGroups.length },
    ];
    for (const { kind, count } of kinds) {
      for (let index = 1; index <= count; index++) {
        this.#send(getLevel({ kind, index }));
        this.#send(getMute({ kind, index }));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Intents
  // -------------------------------------------------------------------------

  setLevel(ref: StripRef, level: number): boolean {
    const strip = this.#strip(ref);
    if (strip) {
      strip.level = level;
      // 'pending' until the unit echoes it back. The UI shows the difference.
      strip.origin = 'pending';
      this.emit('state', this.state);
    }
    const sent = this.#send(setLevel(ref, level));
    if (sent) this.#confirm(ref);
    return sent;
  }

  setMute(ref: StripRef, muted: boolean): boolean {
    const strip = this.#strip(ref);
    if (strip) {
      strip.muted = muted;
      strip.origin = 'pending';
      this.emit('state', this.state);
    }
    const sent = this.#send(setMute(ref, muted));
    if (sent) this.#confirm(ref);
    return sent;
  }

  setSendLevel(from: StripRef, to: StripRef, level: number): boolean {
    const key = crosspointKey(from, to);
    this.state.sends[key] = {
      level,
      muted: this.state.sends[key]?.muted ?? false,
      origin: 'pending',
    };
    this.emit('state', this.state);
    return this.#send(setSendLevel(from, to, level));
  }

  setSendMute(from: StripRef, to: StripRef, muted: boolean): boolean {
    const key = crosspointKey(from, to);
    this.state.sends[key] = {
      level: this.state.sends[key]?.level ?? 0,
      muted,
      origin: 'pending',
    };
    this.emit('state', this.state);
    return this.#send(setSendMute(from, to, muted));
  }

  recallPreset(preset: number): boolean {
    return this.#send(recallPreset(preset));
  }

  selectSource(zoneIndex: number, sourceNumber: number): boolean {
    this.state.sources[zoneIndex] = sourceNumber;
    this.emit('state', this.state);
    return this.#send(selectSource(zoneIndex, sourceNumber));
  }
}
