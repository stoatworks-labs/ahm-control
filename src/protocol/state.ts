/**
 * The shared system model. Imported by both the server and the browser UI, so
 * there is exactly one definition of what a strip or a crosspoint is.
 *
 * IMPORTANT -- the writable boundary.
 *
 * Levels, mutes, sends, preset recall and source selection are carried by the
 * published protocol and are genuinely pushed to the unit. Processing (PEQ,
 * delay, dynamics) is NOT in the published protocol. Those fields exist here so
 * the UI can display and design them, and every one of them is marked
 * `origin: 'local'` until a transport can actually write it. Nothing in this
 * codebase may present a local processing value as the unit's own state.
 */

import type { StripKind } from './addressing.ts';
import type { OutputTopology } from '../system/topology.ts';
import { topologyFromPreset } from '../system/topology.ts';
import type { DeskSystem } from '../system/desks.ts';
import { allocateDeskInputs, createDeskSystem, deskForTopology } from '../system/desks.ts';

/** Where a value came from, so the UI can never imply a false round trip. */
export type ValueOrigin =
  /** Confirmed by the unit, either as a reply or an unsolicited update. */
  | 'device'
  /** Sent to the unit, not yet confirmed. */
  | 'pending'
  /** Held only by this app -- the protocol cannot write it. */
  | 'local';

export interface Strip {
  kind: StripKind;
  index: number;
  name: string;
  /** 7-bit level byte, the protocol's own unit. */
  level: number;
  muted: boolean;
  origin: ValueOrigin;
}

export interface Crosspoint {
  level: number;
  muted: boolean;
  origin: ValueOrigin;
}

// ---------------------------------------------------------------------------
// Processing -- local-only until the RE track lands a transport
// ---------------------------------------------------------------------------

export type FilterType = 'bell' | 'lowShelf' | 'highShelf' | 'highPass' | 'lowPass';

export interface PeqBand {
  enabled: boolean;
  type: FilterType;
  /** Hz */
  frequency: number;
  /** dB */
  gain: number;
  q: number;
}

export interface Delay {
  enabled: boolean;
  /** Milliseconds. The UI also offers distance, derived from speed of sound. */
  milliseconds: number;
}

export interface Dynamics {
  enabled: boolean;
  /** dB */
  threshold: number;
  ratio: number;
  /** ms */
  attack: number;
  /** ms */
  release: number;
}

export interface ZoneProcessing {
  peq: PeqBand[];
  delay: Delay;
  compressor: Dynamics;
  limiter: Dynamics;
  origin: ValueOrigin;
}

export const PEQ_BAND_COUNT = 8;

export function defaultProcessing(): ZoneProcessing {
  // Bands spread across the audio band so a fresh zone opens on a readable
  // curve rather than eight coincident points at 1 kHz.
  const frequencies = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
  return {
    peq: frequencies.map((frequency) => ({
      enabled: false,
      type: 'bell' as FilterType,
      frequency,
      gain: 0,
      q: 1.4,
    })),
    delay: { enabled: false, milliseconds: 0 },
    compressor: { enabled: false, threshold: -10, ratio: 4, attack: 10, release: 100 },
    limiter: { enabled: false, threshold: 0, ratio: 20, attack: 1, release: 50 },
    origin: 'local',
  };
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SystemState {
  model: 16 | 32 | 64;
  status: ConnectionStatus;
  /** Host the server is pointed at, for display. */
  host: string;
  port: number;
  /** Last error text, cleared on a successful connect. */
  error: string | null;
  /** True when the state came from the built-in simulator, not a real unit. */
  simulated: boolean;
  inputs: Strip[];
  zones: Strip[];
  controlGroups: Strip[];
  /** Crosspoints keyed "input:3->zone:1". Absent means never touched. */
  sends: Record<string, Crosspoint>;
  /** Per-zone processing, keyed by zone index. */
  processing: Record<number, ZoneProcessing>;
  /** Per-zone selected source number, 1-based, or 0 for none. */
  sources: Record<number, number>;
  currentPreset: number | null;
  presetNames: Record<number, string>;
  /** Set when a system .cfg has been imported. */
  configVersion: string | null;

  /** What the PA is: the output groups the system is built around. */
  topology: OutputTopology;
  /** The consoles feeding it, and which are live. */
  desks: DeskSystem;
  /** Anything the resolver could not route, for display. */
  routingWarnings: string[];
}

export function crosspointKey(
  from: { kind: StripKind; index: number },
  to: { kind: StripKind; index: number },
): string {
  return `${from.kind}:${from.index}->${to.kind}:${to.index}`;
}

function makeStrips(kind: StripKind, count: number, label: string): Strip[] {
  return Array.from({ length: count }, (_, i) => ({
    kind,
    index: i + 1,
    name: `${label} ${i + 1}`,
    // Unity, matching the protocol's documented 0 dB point.
    level: 105,
    muted: false,
    origin: 'local' as ValueOrigin,
  }));
}

export function createSystemState(model: 16 | 32 | 64): SystemState {
  // Open on the simplest system that is still a system: a stereo pair fed by
  // one production console. Everything else is a preset click away.
  const topology = topologyFromPreset('lr', model);
  const desks = {
    ...createDeskSystem(),
    desks: allocateDeskInputs([deskForTopology('production', 'Production', 'production', topology)], model),
  };

  return {
    topology,
    desks,
    routingWarnings: [],
    model,
    status: 'disconnected',
    host: '',
    port: 51325,
    error: null,
    simulated: false,
    inputs: makeStrips('input', model, 'In'),
    zones: makeStrips('zone', model, 'Zone'),
    controlGroups: makeStrips('controlGroup', 32, 'CG'),
    sends: {},
    processing: Object.fromEntries(
      Array.from({ length: model }, (_, i) => [i + 1, defaultProcessing()]),
    ),
    sources: {},
    currentPreset: null,
    presetNames: {},
    configVersion: null,
  };
}

export function stripsFor(state: SystemState, kind: StripKind): Strip[] {
  if (kind === 'input') return state.inputs;
  if (kind === 'zone') return state.zones;
  return state.controlGroups;
}
