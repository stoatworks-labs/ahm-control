/**
 * Output topology — what the PA actually is.
 *
 * A system processor is not a matrix with 64 anonymous outputs. It is a handful
 * of named output groups (mains, subs, frontfills, delays), each mono or stereo,
 * each occupying one or two physical zones. Everything else in this app hangs
 * off that: routing is resolved per group, and processing is edited per group
 * with stereo pairs linked.
 *
 * Zones are the AHM's outputs. A stereo group occupies two consecutive zones.
 */

export type OutputRole = 'main' | 'sub' | 'frontfill' | 'delay' | 'other';
export type ChannelFormat = 'mono' | 'stereo';

export interface OutputGroup {
  id: string;
  name: string;
  role: OutputRole;
  format: ChannelFormat;
  /** AHM zone indices, 1-based. One entry for mono, two (L,R) for stereo. */
  zones: number[];
}

export interface OutputTopology {
  /** Which preset this came from, or 'custom' once edited. */
  preset: TopologyPresetId;
  groups: OutputGroup[];
}

export type TopologyPresetId =
  | 'lr'
  | 'lr-sub'
  | 'lr-sub-ff'
  | 'lr-sub-ff-delay'
  | 'custom';

interface GroupTemplate {
  id: string;
  name: string;
  role: OutputRole;
  format: ChannelFormat;
}

/**
 * Default formats: mains and delays stereo (they carry the image), subs and
 * frontfills mono (a sub array and a front fill run are almost always fed one
 * signal). All of it is editable — these are starting points, not rules.
 */
const MAIN: GroupTemplate = { id: 'main', name: 'Mains', role: 'main', format: 'stereo' };
const SUB: GroupTemplate = { id: 'sub', name: 'Subs', role: 'sub', format: 'mono' };
const FRONTFILL: GroupTemplate = { id: 'frontfill', name: 'Frontfills', role: 'frontfill', format: 'mono' };
const DELAY: GroupTemplate = { id: 'delay', name: 'Delays', role: 'delay', format: 'stereo' };

export interface TopologyPreset {
  id: TopologyPresetId;
  name: string;
  description: string;
  templates: GroupTemplate[];
}

export const TOPOLOGY_PRESETS: TopologyPreset[] = [
  {
    id: 'lr',
    name: 'Left & Right',
    description: 'A stereo pair and nothing else.',
    templates: [MAIN],
  },
  {
    id: 'lr-sub',
    name: 'Left & Right, Subs',
    description: 'Stereo mains with a mono sub feed.',
    templates: [MAIN, SUB],
  },
  {
    id: 'lr-sub-ff',
    name: 'Left & Right, Subs, Frontfills',
    description: 'Adds a mono frontfill run across the stage lip.',
    templates: [MAIN, SUB, FRONTFILL],
  },
  {
    id: 'lr-sub-ff-delay',
    name: 'Left & Right, Subs, Frontfills, Delays',
    description: 'Full house system with a stereo delay ring.',
    templates: [MAIN, SUB, FRONTFILL, DELAY],
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Build the output groups by hand.',
    templates: [],
  },
];

export function zoneCount(format: ChannelFormat): number {
  return format === 'stereo' ? 2 : 1;
}

/**
 * Assign zones to groups sequentially from zone 1, in order.
 *
 * Deliberately positional rather than sticky: reordering or resizing groups
 * renumbers everything below, which is what an engineer patching a rack expects
 * ("mains are 1 and 2, subs are 3"). A group can still be pinned by editing its
 * zones afterwards; `allocateZones` is only ever applied to groups that have not
 * been pinned.
 */
export function allocateZones(groups: OutputGroup[], maxZones: number): OutputGroup[] {
  let next = 1;
  return groups.map((group) => {
    const width = zoneCount(group.format);
    const zones = Array.from({ length: width }, (_, i) => next + i);
    next += width;
    return { ...group, zones: zones.filter((z) => z <= maxZones) };
  });
}

export function topologyFromPreset(preset: TopologyPresetId, maxZones = 64): OutputTopology {
  const found = TOPOLOGY_PRESETS.find((p) => p.id === preset);
  if (!found) throw new RangeError(`unknown topology preset ${preset}`);

  const groups = found.templates.map((template) => ({ ...template, zones: [] as number[] }));
  return { preset, groups: allocateZones(groups, maxZones) };
}

/** Total zones a topology occupies. */
export function usedZones(topology: OutputTopology): number {
  return topology.groups.reduce((total, group) => total + zoneCount(group.format), 0);
}

/**
 * Problems worth showing the operator. Returned rather than thrown: a
 * half-built custom topology is a normal editing state, not an error.
 */
export function validateTopology(topology: OutputTopology, maxZones = 64): string[] {
  const problems: string[] = [];

  if (topology.groups.length === 0) {
    problems.push('No output groups defined.');
  }

  const used = usedZones(topology);
  if (used > maxZones) {
    problems.push(`Topology needs ${used} zones but the unit has ${maxZones}.`);
  }

  const seen = new Map<number, string>();
  for (const group of topology.groups) {
    if (group.zones.length !== zoneCount(group.format)) {
      problems.push(`${group.name} is ${group.format} but has ${group.zones.length} zone(s).`);
    }
    for (const zone of group.zones) {
      const owner = seen.get(zone);
      // Two groups on one zone is a real patching mistake, not a preference.
      if (owner) problems.push(`Zone ${zone} is used by both ${owner} and ${group.name}.`);
      else seen.set(zone, group.name);
    }
  }

  const ids = topology.groups.map((g) => g.id);
  if (new Set(ids).size !== ids.length) problems.push('Two output groups share an id.');

  return problems;
}

export function findGroup(topology: OutputTopology, groupId: string): OutputGroup | null {
  return topology.groups.find((g) => g.id === groupId) ?? null;
}

/** A fresh group for the custom editor. */
export function newGroup(topology: OutputTopology): OutputGroup {
  let n = topology.groups.length + 1;
  while (topology.groups.some((g) => g.id === `out${n}`)) n++;
  return { id: `out${n}`, name: `Output ${n}`, role: 'other', format: 'mono', zones: [] };
}
