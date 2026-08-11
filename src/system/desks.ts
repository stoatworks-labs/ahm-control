/**
 * Consoles feeding the system.
 *
 * A desk provides one feed per output group — one input per output type. The
 * production desk is always live; secondary desks are switched in, either one
 * at a time or several together.
 *
 * A desk does NOT have to match the system. It may be stereo where the system
 * is mono, mono where the system is stereo, or have no dedicated send for a
 * group at all. That mismatch is declared here, per feed, and the resolver in
 * routing.ts compensates for it — see that file for what each case does.
 */

import type { ChannelFormat, OutputTopology } from './topology.ts';
import { zoneCount } from './topology.ts';

export type FeedSource =
  /** The desk has a dedicated output for this group (a matrix, an aux, an LR pair). */
  | 'direct'
  /** No dedicated output — take another group's feed and convert it. */
  | 'derived'
  /** This desk does not feed this group at all. */
  | 'none';

export interface DeskFeed {
  groupId: string;
  source: FeedSource;
  /** What the DESK provides. May differ from the output group's format. */
  format: ChannelFormat;
  /** AHM input indices, 1-based. Only meaningful when source is 'direct'. */
  inputs: number[];
  /** Group id to take the feed from when source is 'derived'. */
  deriveFrom?: string;
  trimDb: number;
}

export type DeskRole = 'production' | 'secondary';

export interface Desk {
  id: string;
  name: string;
  role: DeskRole;
  /** Applied on top of every feed's own trim. */
  trimDb: number;
  feeds: DeskFeed[];
}

export type SecondarySelectMode = 'single' | 'multi';

export interface DeskSystem {
  desks: Desk[];
  /** Ids of the secondary desks currently switched in. */
  activeSecondaryIds: string[];
  selectMode: SecondarySelectMode;
  /**
   * Level applied to EACH leg when two are summed into one zone.
   *
   * -3 dB is the default: it holds loudness for the uncorrelated content that
   * dominates a music mix. Correlated material sums closer to +6 dB, so a
   * system that runs hot into a mono sub feed may want -6. It is a preference,
   * not a fact, which is why it is exposed rather than baked in.
   */
  summingGainDb: number;
}

export function createDeskSystem(): DeskSystem {
  return { desks: [], activeSecondaryIds: [], selectMode: 'single', summingGainDb: -3 };
}

/** A desk that matches the system exactly: one direct feed per group. */
export function deskForTopology(
  id: string,
  name: string,
  role: DeskRole,
  topology: OutputTopology,
): Desk {
  return {
    id,
    name,
    role,
    trimDb: 0,
    feeds: topology.groups.map((group) => ({
      groupId: group.id,
      source: 'direct' as FeedSource,
      format: group.format,
      inputs: [],
      trimDb: 0,
    })),
  };
}

/**
 * Bring a desk's feeds into line with the topology after the topology changes.
 *
 * Groups that already have a feed keep it, including any mismatch the operator
 * deliberately configured. New groups get a matching direct feed. Feeds for
 * groups that no longer exist are dropped, as is a `deriveFrom` pointing at a
 * group that has gone.
 */
export function reconcileDesk(desk: Desk, topology: OutputTopology): Desk {
  const groupIds = new Set(topology.groups.map((g) => g.id));

  const feeds = topology.groups.map((group) => {
    const existing = desk.feeds.find((f) => f.groupId === group.id);
    if (!existing) {
      return { groupId: group.id, source: 'direct' as FeedSource, format: group.format, inputs: [], trimDb: 0 };
    }
    if (existing.deriveFrom && !groupIds.has(existing.deriveFrom)) {
      // The group it derived from is gone; fall back to a direct feed rather
      // than leaving a dangling reference that silently routes nothing.
      return { ...existing, source: 'direct' as FeedSource, deriveFrom: undefined };
    }
    return existing;
  });

  return { ...desk, feeds };
}

/** How many AHM inputs a desk occupies. Derived feeds consume none. */
export function deskInputWidth(desk: Desk): number {
  return desk.feeds
    .filter((feed) => feed.source === 'direct')
    .reduce((total, feed) => total + zoneCount(feed.format), 0);
}

/**
 * Assign AHM inputs to every desk, sequentially, in desk order.
 *
 * Same positional rule as zone allocation: predictable over sticky. Derived
 * feeds are skipped because they reuse another feed's inputs — allocating for
 * them would leave permanent gaps in the patch.
 */
export function allocateDeskInputs(desks: Desk[], maxInputs = 64): Desk[] {
  let next = 1;
  return desks.map((desk) => ({
    ...desk,
    feeds: desk.feeds.map((feed) => {
      if (feed.source !== 'direct') return { ...feed, inputs: [] };
      const width = zoneCount(feed.format);
      const inputs = Array.from({ length: width }, (_, i) => next + i).filter((n) => n <= maxInputs);
      next += width;
      return { ...feed, inputs };
    }),
  }));
}

/** Every desk that is currently feeding the system. */
export function activeDesks(system: DeskSystem): Desk[] {
  return system.desks.filter(
    (desk) => desk.role === 'production' || system.activeSecondaryIds.includes(desk.id),
  );
}

/**
 * Switch a secondary desk in or out, honouring the select mode.
 *
 * In 'single' mode selecting a desk replaces the selection; selecting the one
 * already live clears it. The production desk is never affected — it is always
 * live, and trying to toggle it is a no-op rather than an error.
 */
export function toggleSecondary(system: DeskSystem, deskId: string): DeskSystem {
  const desk = system.desks.find((d) => d.id === deskId);
  if (!desk || desk.role === 'production') return system;

  const live = system.activeSecondaryIds.includes(deskId);

  if (system.selectMode === 'single') {
    return { ...system, activeSecondaryIds: live ? [] : [deskId] };
  }
  return {
    ...system,
    activeSecondaryIds: live
      ? system.activeSecondaryIds.filter((id) => id !== deskId)
      : [...system.activeSecondaryIds, deskId],
  };
}

/** Switching to single mode must not leave several desks live. */
export function setSelectMode(system: DeskSystem, mode: SecondarySelectMode): DeskSystem {
  if (mode === 'multi') return { ...system, selectMode: mode };
  return {
    ...system,
    selectMode: mode,
    activeSecondaryIds: system.activeSecondaryIds.slice(0, 1),
  };
}

export function validateDesks(system: DeskSystem, maxInputs = 64): string[] {
  const problems: string[] = [];

  const production = system.desks.filter((d) => d.role === 'production');
  if (production.length === 0) problems.push('No production console defined.');
  if (production.length > 1) problems.push('More than one console is marked as the production console.');

  const total = system.desks.reduce((sum, desk) => sum + deskInputWidth(desk), 0);
  if (total > maxInputs) {
    problems.push(`Desks need ${total} inputs but the unit has ${maxInputs}.`);
  }

  for (const desk of system.desks) {
    for (const feed of desk.feeds) {
      if (feed.source === 'derived' && !feed.deriveFrom) {
        problems.push(`${desk.name}: ${feed.groupId} is set to derive but has no source group.`);
      }
      if (feed.source === 'derived' && feed.deriveFrom === feed.groupId) {
        problems.push(`${desk.name}: ${feed.groupId} derives from itself.`);
      }
      if (feed.source === 'direct' && feed.inputs.length !== zoneCount(feed.format)) {
        problems.push(
          `${desk.name}: ${feed.groupId} is ${feed.format} but has ${feed.inputs.length} input(s).`,
        );
      }
    }
  }

  return problems;
}
