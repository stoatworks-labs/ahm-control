import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOPOLOGY_PRESETS,
  topologyFromPreset,
  allocateZones,
  validateTopology,
  usedZones,
  newGroup,
  type OutputTopology,
} from '../src/system/topology.ts';
import {
  createDeskSystem,
  deskForTopology,
  reconcileDesk,
  allocateDeskInputs,
  activeDesks,
  toggleSecondary,
  setSelectMode,
  deskInputWidth,
  validateDesks,
  type Desk,
  type DeskSystem,
} from '../src/system/desks.ts';
import {
  resolveRouting,
  diffRouting,
  managedCrosspoints,
  byGroup,
} from '../src/system/routing.ts';
import { dbToLevel } from '../src/protocol/levels.ts';
import { crosspointKey, type Crosspoint } from '../src/protocol/state.ts';

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

test('every preset builds and allocates zones without overlap', () => {
  for (const preset of TOPOLOGY_PRESETS) {
    const topology = topologyFromPreset(preset.id);
    assert.deepEqual(validateTopology(topology), preset.id === 'custom' ? ['No output groups defined.'] : []);
  }
});

test('the four named presets have the expected shape', () => {
  assert.deepEqual(
    topologyFromPreset('lr').groups.map((g) => [g.id, g.format, g.zones]),
    [['main', 'stereo', [1, 2]]],
  );

  assert.deepEqual(
    topologyFromPreset('lr-sub').groups.map((g) => [g.id, g.format, g.zones]),
    [
      ['main', 'stereo', [1, 2]],
      ['sub', 'mono', [3]],
    ],
  );

  assert.deepEqual(
    topologyFromPreset('lr-sub-ff').groups.map((g) => [g.id, g.zones]),
    [['main', [1, 2]], ['sub', [3]], ['frontfill', [4]]],
  );

  // Delays are stereo, so the full house system lands on six zones.
  assert.deepEqual(
    topologyFromPreset('lr-sub-ff-delay').groups.map((g) => [g.id, g.zones]),
    [['main', [1, 2]], ['sub', [3]], ['frontfill', [4]], ['delay', [5, 6]]],
  );
  assert.equal(usedZones(topologyFromPreset('lr-sub-ff-delay')), 6);
});

test('zone allocation renumbers everything below when a format changes', () => {
  const topology = topologyFromPreset('lr-sub-ff');
  // Make the subs stereo; the frontfill must move down a zone.
  const groups = topology.groups.map((g) => (g.id === 'sub' ? { ...g, format: 'stereo' as const } : g));
  const reallocated = allocateZones(groups, 64);

  assert.deepEqual(reallocated.map((g) => g.zones), [[1, 2], [3, 4], [5]]);
});

test('validation catches a topology that overruns the unit', () => {
  const topology = topologyFromPreset('lr-sub-ff-delay');
  const problems = validateTopology(topology, 4);
  assert.ok(problems.some((p) => p.includes('needs 6 zones')), problems.join('; '));
});

test('validation catches two groups sharing a zone', () => {
  const topology: OutputTopology = {
    preset: 'custom',
    groups: [
      { id: 'a', name: 'A', role: 'main', format: 'mono', zones: [1] },
      { id: 'b', name: 'B', role: 'sub', format: 'mono', zones: [1] },
    ],
  };
  assert.ok(validateTopology(topology).some((p) => p.includes('Zone 1 is used by both')));
});

test('newGroup does not collide with existing ids', () => {
  const topology = topologyFromPreset('lr');
  const first = newGroup(topology);
  const withFirst = { ...topology, groups: [...topology.groups, first] };
  assert.notEqual(newGroup(withFirst).id, first.id);
});

// ---------------------------------------------------------------------------
// Desks
// ---------------------------------------------------------------------------

/** Full house system, one production desk plus two secondaries, all matching. */
function rig(): { topology: OutputTopology; system: DeskSystem } {
  const topology = topologyFromPreset('lr-sub-ff-delay');
  const desks = allocateDeskInputs([
    deskForTopology('foh', 'Production FOH', 'production', topology),
    deskForTopology('band-a', 'Band A', 'secondary', topology),
    deskForTopology('band-b', 'Band B', 'secondary', topology),
  ]);
  return { topology, system: { ...createDeskSystem(), desks } };
}

test('a matching desk takes one input per output leg', () => {
  const { system } = rig();
  const foh = system.desks[0];

  // stereo mains + mono sub + mono frontfill + stereo delay = 6 inputs
  assert.equal(deskInputWidth(foh), 6);
  assert.deepEqual(foh.feeds.map((f) => f.inputs), [[1, 2], [3], [4], [5, 6]]);

  // The next desk carries on where the first stopped.
  assert.deepEqual(system.desks[1].feeds.map((f) => f.inputs), [[7, 8], [9], [10], [11, 12]]);
  assert.deepEqual(system.desks[2].feeds[0].inputs, [13, 14]);
});

test('derived feeds consume no inputs and leave no gap in the patch', () => {
  const topology = topologyFromPreset('lr-sub');
  const desk = deskForTopology('d', 'Desk', 'production', topology);
  // This desk has no sub send; derive it from the mains.
  desk.feeds[1] = { ...desk.feeds[1], source: 'derived', deriveFrom: 'main' };

  const [allocated] = allocateDeskInputs([desk]);
  assert.deepEqual(allocated.feeds.map((f) => f.inputs), [[1, 2], []]);
  assert.equal(deskInputWidth(allocated), 2);
});

test('the production desk is always live and cannot be toggled off', () => {
  const { system } = rig();
  assert.deepEqual(activeDesks(system).map((d) => d.id), ['foh']);

  const after = toggleSecondary(system, 'foh');
  assert.deepEqual(activeDesks(after).map((d) => d.id), ['foh']);
});

test('single mode replaces the live secondary desk', () => {
  const { system } = rig();

  const withA = toggleSecondary(system, 'band-a');
  assert.deepEqual(activeDesks(withA).map((d) => d.id), ['foh', 'band-a']);

  const withB = toggleSecondary(withA, 'band-b');
  assert.deepEqual(activeDesks(withB).map((d) => d.id), ['foh', 'band-b']);

  // Selecting the live one again clears it, leaving production alone.
  assert.deepEqual(activeDesks(toggleSecondary(withB, 'band-b')).map((d) => d.id), ['foh']);
});

test('multi mode keeps several secondary desks live at once', () => {
  const { system } = rig();
  const multi = setSelectMode(system, 'multi');

  const both = toggleSecondary(toggleSecondary(multi, 'band-a'), 'band-b');
  assert.deepEqual(activeDesks(both).map((d) => d.id), ['foh', 'band-a', 'band-b']);

  assert.deepEqual(activeDesks(toggleSecondary(both, 'band-a')).map((d) => d.id), ['foh', 'band-b']);
});

test('dropping back to single mode does not leave two desks live', () => {
  const { system } = rig();
  const multi = setSelectMode(system, 'multi');
  const both = toggleSecondary(toggleSecondary(multi, 'band-a'), 'band-b');

  const single = setSelectMode(both, 'single');
  assert.equal(single.activeSecondaryIds.length, 1);
});

test('reconciling a desk keeps configured feeds and adds new groups', () => {
  const small = topologyFromPreset('lr-sub');
  let desk = deskForTopology('d', 'Desk', 'production', small);
  desk = { ...desk, feeds: desk.feeds.map((f) => (f.groupId === 'sub' ? { ...f, trimDb: -4 } : f)) };

  const bigger = topologyFromPreset('lr-sub-ff-delay');
  const reconciled = reconcileDesk(desk, bigger);

  assert.deepEqual(reconciled.feeds.map((f) => f.groupId), ['main', 'sub', 'frontfill', 'delay']);
  // The deliberate trim on the sub feed survives the topology change.
  assert.equal(reconciled.feeds.find((f) => f.groupId === 'sub')!.trimDb, -4);
});

test('reconciling drops a dangling deriveFrom rather than routing nothing', () => {
  const big = topologyFromPreset('lr-sub-ff-delay');
  let desk = deskForTopology('d', 'Desk', 'production', big);
  desk = {
    ...desk,
    feeds: desk.feeds.map((f) => (f.groupId === 'sub' ? { ...f, source: 'derived' as const, deriveFrom: 'delay' } : f)),
  };

  // Shrink the system so 'delay' no longer exists.
  const reconciled = reconcileDesk(desk, topologyFromPreset('lr-sub'));
  const sub = reconciled.feeds.find((f) => f.groupId === 'sub')!;
  assert.equal(sub.source, 'direct');
  assert.equal(sub.deriveFrom, undefined);
});

test('validation catches a missing production console and an input overrun', () => {
  const { topology } = rig();
  const many = allocateDeskInputs(
    Array.from({ length: 12 }, (_, i) => deskForTopology(`d${i}`, `Desk ${i}`, 'secondary', topology)),
  );
  const problems = validateDesks({ ...createDeskSystem(), desks: many });

  assert.ok(problems.some((p) => p.includes('No production console')));
  assert.ok(problems.some((p) => p.includes('need 72 inputs')), problems.join('; '));
});

// ---------------------------------------------------------------------------
// The resolver — format compensation
// ---------------------------------------------------------------------------

test('a matching desk routes leg for leg at unity', () => {
  const { topology, system } = rig();
  const { crosspoints, warnings } = resolveRouting(topology, system);

  assert.deepEqual(warnings, []);
  // 6 legs, production desk only.
  assert.equal(crosspoints.length, 6);
  assert.ok(crosspoints.every((c) => c.gainDb === 0));

  const mains = crosspoints.filter((c) => c.groupId === 'main');
  assert.deepEqual(mains.map((c) => [c.from.index, c.to.index]), [[1, 1], [2, 2]]);
});

test('a stereo desk feeding a mono group is summed', () => {
  const topology = topologyFromPreset('lr-sub');
  // Desk sends stereo to the sub group, which is mono.
  const desk = deskForTopology('d', 'Desk', 'production', topology);
  desk.feeds[1] = { ...desk.feeds[1], format: 'stereo' };
  const system = { ...createDeskSystem(), desks: allocateDeskInputs([desk]) };

  const { crosspoints } = resolveRouting(topology, system);
  const subs = crosspoints.filter((c) => c.groupId === 'sub');

  // Both legs land on the single sub zone, each at the summing gain.
  assert.deepEqual(subs.map((c) => [c.from.index, c.to.index]), [[3, 3], [4, 3]]);
  assert.ok(subs.every((c) => c.gainDb === -3));
  assert.ok(subs[0].note.includes('summed to mono'));
});

test('a mono desk feeding a stereo group goes to both sides at unity', () => {
  const topology = topologyFromPreset('lr');
  const desk = deskForTopology('d', 'Desk', 'production', topology);
  desk.feeds[0] = { ...desk.feeds[0], format: 'mono' };
  const system = { ...createDeskSystem(), desks: allocateDeskInputs([desk]) };

  const { crosspoints } = resolveRouting(topology, system);
  assert.deepEqual(crosspoints.map((c) => [c.from.index, c.to.index]), [[1, 1], [1, 2]]);
  // Unity per side, not -3: each side should match the source level.
  assert.ok(crosspoints.every((c) => c.gainDb === 0));
});

test('subs derived from stereo mains become a mono mixdown', () => {
  const topology = topologyFromPreset('lr-sub'); // sub group is mono
  const desk = deskForTopology('d', 'Desk with no sub send', 'production', topology);
  desk.feeds[1] = { ...desk.feeds[1], source: 'derived', deriveFrom: 'main' };
  const system = { ...createDeskSystem(), desks: allocateDeskInputs([desk]) };

  const { crosspoints, warnings } = resolveRouting(topology, system);
  assert.deepEqual(warnings, []);

  const subs = crosspoints.filter((c) => c.groupId === 'sub');
  // The MAINS inputs feed the sub zone -- no extra desk output was needed.
  assert.deepEqual(subs.map((c) => [c.from.index, c.to.index]), [[1, 3], [2, 3]]);
  assert.ok(subs.every((c) => c.gainDb === -3));
  assert.ok(subs[0].note.includes('derived from main'));
});

test('subs derived from mains stay stereo L/R when the sub group is stereo', () => {
  // Same desk configuration, different topology -- the conversion follows the
  // system rather than being configured a second time.
  const topology = topologyFromPreset('lr-sub');
  topology.groups[1] = { ...topology.groups[1], format: 'stereo', zones: [3, 4] };

  const desk = deskForTopology('d', 'Desk', 'production', topology);
  desk.feeds[1] = { ...desk.feeds[1], source: 'derived', deriveFrom: 'main', format: 'stereo' };
  const system = { ...createDeskSystem(), desks: allocateDeskInputs([desk]) };

  const subs = resolveRouting(topology, system).crosspoints.filter((c) => c.groupId === 'sub');
  assert.deepEqual(subs.map((c) => [c.from.index, c.to.index]), [[1, 3], [2, 4]]);
  assert.ok(subs.every((c) => c.gainDb === 0), 'a stereo-to-stereo derive must not sum');
});

test('subs on an aux are just a direct feed', () => {
  const topology = topologyFromPreset('lr-sub');
  const desk = deskForTopology('d', 'Desk', 'production', topology);
  const system = { ...createDeskSystem(), desks: allocateDeskInputs([desk]) };

  const subs = resolveRouting(topology, system).crosspoints.filter((c) => c.groupId === 'sub');
  assert.deepEqual(subs.map((c) => [c.from.index, c.to.index]), [[3, 3]]);
  assert.equal(subs[0].note, 'direct');
});

test('trims stack across desk, feed and the feed derived from', () => {
  const topology = topologyFromPreset('lr-sub');
  let desk = deskForTopology('d', 'Desk', 'production', topology);
  desk = { ...desk, trimDb: -1 };
  desk.feeds[0] = { ...desk.feeds[0], trimDb: -2 };
  desk.feeds[1] = { ...desk.feeds[1], source: 'derived', deriveFrom: 'main', trimDb: -4 };
  const system = { ...createDeskSystem(), desks: allocateDeskInputs([desk]) };

  const { crosspoints } = resolveRouting(topology, system);
  // Mains: desk -1 + feed -2 = -3
  assert.equal(crosspoints.find((c) => c.groupId === 'main')!.gainDb, -3);
  // Subs: desk -1 + this feed -4 + the mains feed it came from -2 + summing -3
  assert.equal(crosspoints.find((c) => c.groupId === 'sub')!.gainDb, -10);
});

test('a feed set to none routes nothing and warns about nothing', () => {
  const topology = topologyFromPreset('lr-sub');
  const desk = deskForTopology('d', 'Desk', 'production', topology);
  desk.feeds[1] = { ...desk.feeds[1], source: 'none' };
  const system = { ...createDeskSystem(), desks: allocateDeskInputs([desk]) };

  const { crosspoints, warnings } = resolveRouting(topology, system);
  assert.deepEqual(warnings, []);
  assert.equal(crosspoints.filter((c) => c.groupId === 'sub').length, 0);
});

test('a derive loop is caught rather than hanging', () => {
  const topology = topologyFromPreset('lr-sub');
  const desk = deskForTopology('d', 'Desk', 'production', topology);
  desk.feeds[0] = { ...desk.feeds[0], source: 'derived', deriveFrom: 'sub' };
  desk.feeds[1] = { ...desk.feeds[1], source: 'derived', deriveFrom: 'main' };
  const system = { ...createDeskSystem(), desks: allocateDeskInputs([desk]) };

  const { crosspoints, warnings } = resolveRouting(topology, system);
  assert.equal(crosspoints.length, 0);
  assert.ok(warnings.some((w) => w.includes('derive loop')), warnings.join('; '));
});

test('deriving from a group the desk does not feed warns', () => {
  const topology = topologyFromPreset('lr-sub');
  const desk = deskForTopology('d', 'Desk', 'production', topology);
  desk.feeds[0] = { ...desk.feeds[0], source: 'none' };
  desk.feeds[1] = { ...desk.feeds[1], source: 'derived', deriveFrom: 'main' };
  const system = { ...createDeskSystem(), desks: allocateDeskInputs([desk]) };

  const { warnings } = resolveRouting(topology, system);
  assert.ok(warnings.some((w) => w.includes('does not feed')), warnings.join('; '));
});

test('several live desks all reach the same output groups', () => {
  const { topology, system } = rig();
  const multi = setSelectMode(system, 'multi');
  const live = toggleSecondary(toggleSecondary(multi, 'band-a'), 'band-b');

  const { crosspoints } = resolveRouting(topology, live);
  assert.equal(crosspoints.length, 18); // three desks x six legs

  // Every desk lands on the same mains zones -- that is the point.
  const mainsLeft = crosspoints.filter((c) => c.groupId === 'main' && c.to.index === 1);
  assert.deepEqual(mainsLeft.map((c) => c.from.index).sort((a, b) => a - b), [1, 7, 13]);
  assert.deepEqual(new Set(byGroup(crosspoints).keys()), new Set(['main', 'sub', 'frontfill', 'delay']));
});

// ---------------------------------------------------------------------------
// Diffing onto the unit
// ---------------------------------------------------------------------------

const unity = dbToLevel(0);

test('a first resolve opens every crosspoint', () => {
  const { topology, system } = rig();
  const { crosspoints } = resolveRouting(topology, system);

  const changes = diffRouting(crosspoints, {}, managedCrosspoints(topology, system));
  assert.equal(changes.length, 6);
  assert.ok(changes.every((c) => c.reason === 'open' && c.level === unity));
});

test('re-resolving an unchanged system writes nothing', () => {
  const { topology, system } = rig();
  const { crosspoints } = resolveRouting(topology, system);

  const current: Record<string, Crosspoint> = {};
  for (const point of crosspoints) {
    current[crosspointKey(point.from, point.to)] = { level: unity, muted: false, origin: 'device' };
  }

  assert.deepEqual(diffRouting(crosspoints, current, managedCrosspoints(topology, system)), []);
});

test('switching secondary desks closes the outgoing desk', () => {
  const { topology, system } = rig();
  const managed = managedCrosspoints(topology, system);

  const withA = toggleSecondary(system, 'band-a');
  const resolvedA = resolveRouting(topology, withA).crosspoints;

  const current: Record<string, Crosspoint> = {};
  for (const point of resolvedA) {
    current[crosspointKey(point.from, point.to)] = { level: unity, muted: false, origin: 'device' };
  }

  const withB = toggleSecondary(withA, 'band-b');
  const changes = diffRouting(resolveRouting(topology, withB).crosspoints, current, managed);

  const closed = changes.filter((c) => c.reason === 'close');
  const opened = changes.filter((c) => c.reason === 'open');

  // Band A's six legs close, Band B's six open, production is untouched.
  assert.equal(closed.length, 6);
  assert.equal(opened.length, 6);
  assert.ok(closed.every((c) => c.from.index >= 7 && c.from.index <= 12));
  assert.ok(opened.every((c) => c.from.index >= 13 && c.from.index <= 18));
});

test('crosspoints outside the managed space are never closed', () => {
  const { topology, system } = rig();
  const { crosspoints } = resolveRouting(topology, system);

  // Someone patched input 40 into zone 20 by hand. Not ours; leave it.
  const stray = crosspointKey({ kind: 'input', index: 40 }, { kind: 'zone', index: 20 });
  const current: Record<string, Crosspoint> = {
    [stray]: { level: unity, muted: false, origin: 'device' },
  };

  const changes = diffRouting(crosspoints, current, managedCrosspoints(topology, system));
  assert.equal(changes.some((c) => c.reason === 'close'), false);
});

test('a trim change rewrites only the affected crosspoints', () => {
  const { topology, system } = rig();
  const before = resolveRouting(topology, system).crosspoints;

  const current: Record<string, Crosspoint> = {};
  for (const point of before) {
    current[crosspointKey(point.from, point.to)] = { level: unity, muted: false, origin: 'device' };
  }

  const desks = system.desks.map((d) =>
    d.id === 'foh'
      ? { ...d, feeds: d.feeds.map((f) => (f.groupId === 'sub' ? { ...f, trimDb: -6 } : f)) }
      : d,
  );
  const after = resolveRouting(topology, { ...system, desks }).crosspoints;

  const changes = diffRouting(after, current, managedCrosspoints(topology, { ...system, desks }));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].reason, 'change');
  assert.equal(changes[0].level, dbToLevel(-6));
});
