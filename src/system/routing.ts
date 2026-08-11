/**
 * The routing resolver.
 *
 * Turns (output topology + desks + which desks are live) into the exact set of
 * AHM crosspoints that should be open, and works out what to change to get
 * there from wherever the unit currently is.
 *
 * This is where a desk that does not match the system gets compensated:
 *
 *   desk stereo -> group stereo   L->L, R->R
 *   desk mono   -> group mono     1->1
 *   desk stereo -> group MONO     both legs into the one zone, each at the
 *                                 summing gain (a mono mixdown)
 *   desk mono   -> group STEREO   the one leg into both zones, unity each side
 *
 * and a group with no dedicated desk output takes another group's feed and runs
 * it through the same rules. That single mechanism covers the cases that matter
 * in practice: subs on an aux (a direct feed), subs derived as a mono mixdown of
 * stereo mains, and subs derived as stereo L/R when the sub group is itself
 * stereo — the operator picks the source, the format conversion follows from the
 * topology rather than being configured twice.
 *
 * Pure. No I/O, no protocol. The server turns the result into messages.
 */

import type { StripRef } from '../protocol/addressing.ts';
import { dbToLevel } from '../protocol/levels.ts';
import { crosspointKey, type Crosspoint } from '../protocol/state.ts';
import type { OutputGroup, OutputTopology } from './topology.ts';
import { activeDesks, type Desk, type DeskFeed, type DeskSystem } from './desks.ts';

export interface ResolvedCrosspoint {
  from: StripRef;
  to: StripRef;
  gainDb: number;
  /** Which desk and group produced it, for the UI and for debugging. */
  deskId: string;
  deskName: string;
  groupId: string;
  /** Human-readable account of any compensation applied. */
  note: string;
}

export interface ResolveResult {
  crosspoints: ResolvedCrosspoint[];
  /** Feeds that could not be resolved, with the reason. */
  warnings: string[];
}

/** Follow a derived feed to the feed that actually owns inputs. */
function resolveSourceFeed(
  desk: Desk,
  feed: DeskFeed,
  warnings: string[],
): DeskFeed | null {
  const seen = new Set<string>([feed.groupId]);
  let current = feed;

  while (current.source === 'derived') {
    const nextId = current.deriveFrom;
    if (!nextId) {
      warnings.push(`${desk.name}: "${current.groupId}" derives from nothing.`);
      return null;
    }
    if (seen.has(nextId)) {
      // A derives from B derives from A. Without this guard the loop never ends.
      warnings.push(`${desk.name}: derive loop through "${nextId}".`);
      return null;
    }
    seen.add(nextId);

    const next = desk.feeds.find((f) => f.groupId === nextId);
    if (!next) {
      warnings.push(`${desk.name}: "${current.groupId}" derives from missing group "${nextId}".`);
      return null;
    }
    current = next;
  }

  if (current.source === 'none') {
    warnings.push(
      `${desk.name}: "${feed.groupId}" derives from "${current.groupId}", which this desk does not feed.`,
    );
    return null;
  }

  return current;
}

/**
 * Map one desk feed onto one output group, applying format compensation.
 */
function mapFeedToGroup(
  desk: Desk,
  feed: DeskFeed,
  group: OutputGroup,
  system: DeskSystem,
  warnings: string[],
): ResolvedCrosspoint[] {
  const sourceFeed = resolveSourceFeed(desk, feed, warnings);
  if (!sourceFeed) return [];

  const inputs = sourceFeed.inputs;
  const zones = group.zones;

  if (inputs.length === 0) {
    warnings.push(`${desk.name}: "${group.name}" has no inputs assigned.`);
    return [];
  }
  if (zones.length === 0) {
    warnings.push(`"${group.name}" has no zones assigned.`);
    return [];
  }

  // Trims stack: the desk's own offset, plus this feed's, plus the feed the
  // signal actually came from when it was derived.
  const baseTrim =
    desk.trimDb + feed.trimDb + (sourceFeed === feed ? 0 : sourceFeed.trimDb);

  const derivedNote =
    sourceFeed === feed ? '' : ` (derived from ${sourceFeed.groupId})`;

  const at = (from: number, to: number, gainDb: number, note: string): ResolvedCrosspoint => ({
    from: { kind: 'input', index: from },
    to: { kind: 'zone', index: to },
    gainDb,
    deskId: desk.id,
    deskName: desk.name,
    groupId: group.id,
    note: note + derivedNote,
  });

  const sourceFormat = sourceFeed.format;

  // Stereo source into a mono group: sum both legs into the single zone.
  if (sourceFormat === 'stereo' && group.format === 'mono') {
    const gain = baseTrim + system.summingGainDb;
    return [
      at(inputs[0], zones[0], gain, `summed to mono at ${system.summingGainDb} dB/leg`),
      at(inputs[1] ?? inputs[0], zones[0], gain, `summed to mono at ${system.summingGainDb} dB/leg`),
    ];
  }

  // Mono source into a stereo group: same signal both sides, unity each side so
  // the level per side matches the source rather than dropping 3 dB.
  if (sourceFormat === 'mono' && group.format === 'stereo') {
    return [
      at(inputs[0], zones[0], baseTrim, 'mono fed to both sides'),
      at(inputs[0], zones[1], baseTrim, 'mono fed to both sides'),
    ];
  }

  // Matching formats: straight through, leg for leg.
  const width = Math.min(inputs.length, zones.length);
  return Array.from({ length: width }, (_, i) => at(inputs[i], zones[i], baseTrim, 'direct'));
}

export function resolveRouting(
  topology: OutputTopology,
  system: DeskSystem,
): ResolveResult {
  const warnings: string[] = [];
  const crosspoints: ResolvedCrosspoint[] = [];

  for (const desk of activeDesks(system)) {
    for (const group of topology.groups) {
      const feed = desk.feeds.find((f) => f.groupId === group.id);
      if (!feed || feed.source === 'none') continue;
      crosspoints.push(...mapFeedToGroup(desk, feed, group, system, warnings));
    }
  }

  return { crosspoints, warnings };
}

// ---------------------------------------------------------------------------
// Applying a resolution to the unit
// ---------------------------------------------------------------------------

export interface CrosspointChange {
  from: StripRef;
  to: StripRef;
  level: number;
  reason: 'open' | 'change' | 'close';
}

/**
 * Every crosspoint this system is responsible for: any desk input into any
 * topology zone.
 *
 * Used to decide what may be closed. Without it, switching desks would either
 * leave the outgoing desk still feeding the system, or close crosspoints an
 * operator patched by hand outside the managed set. The managed space is
 * exactly "inputs we allocated" x "zones we allocated" — anything else on the
 * unit is left alone.
 */
export function managedCrosspoints(
  topology: OutputTopology,
  system: DeskSystem,
): Set<string> {
  const managed = new Set<string>();
  const zones = topology.groups.flatMap((g) => g.zones);

  for (const desk of system.desks) {
    for (const feed of desk.feeds) {
      for (const input of feed.inputs) {
        for (const zone of zones) {
          managed.add(crosspointKey({ kind: 'input', index: input }, { kind: 'zone', index: zone }));
        }
      }
    }
  }

  return managed;
}

/**
 * Work out the minimum set of crosspoint writes to move the unit from its
 * current state to the resolved routing.
 *
 * Sums duplicate crosspoints in dB rather than letting the last one win: a
 * stereo desk summed into a mono sub produces two entries for two different
 * inputs, but a topology where two groups share a zone would produce two for
 * the SAME pair, and silently dropping one would quietly lose a feed.
 */
export function diffRouting(
  resolved: ResolvedCrosspoint[],
  current: Record<string, Crosspoint>,
  managed: Set<string>,
): CrosspointChange[] {
  const desired = new Map<string, { from: StripRef; to: StripRef; level: number }>();

  for (const point of resolved) {
    const key = crosspointKey(point.from, point.to);
    const level = dbToLevel(point.gainDb);
    const existing = desired.get(key);
    // Two routes to the same crosspoint: keep the louder rather than the last.
    if (!existing || level > existing.level) {
      desired.set(key, { from: point.from, to: point.to, level });
    }
  }

  const changes: CrosspointChange[] = [];

  for (const [key, want] of desired) {
    const now = current[key];
    if (!now || now.level !== want.level) {
      changes.push({ ...want, reason: now && now.level > 0 ? 'change' : 'open' });
    }
  }

  // Close anything in the managed space that is open but no longer wanted.
  for (const key of managed) {
    if (desired.has(key)) continue;
    const now = current[key];
    if (!now || now.level === 0) continue;

    const [fromId, toId] = key.split('->');
    changes.push({
      from: parseRef(fromId),
      to: parseRef(toId),
      level: 0,
      reason: 'close',
    });
  }

  return changes;
}

function parseRef(id: string): StripRef {
  const [kind, index] = id.split(':');
  return { kind: kind as StripRef['kind'], index: Number(index) };
}

/** Group the resolution by output group, for display. */
export function byGroup(resolved: ResolvedCrosspoint[]): Map<string, ResolvedCrosspoint[]> {
  const out = new Map<string, ResolvedCrosspoint[]>();
  for (const point of resolved) {
    const list = out.get(point.groupId) ?? [];
    list.push(point);
    out.set(point.groupId, list);
  }
  return out;
}
