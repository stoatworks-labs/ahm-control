/**
 * The full path a UI action actually takes:
 *   browser WebSocket -> server -> AhmDevice -> TCP -> simulator
 *
 * Uses the same JSON command shapes the React app sends, so a change to the
 * wire format between browser and server breaks a test rather than a screen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { startServer } from '../src/server/index.ts';
import { dbToLevel } from '../src/protocol/levels.ts';

interface Rig {
  socket: WebSocket;
  port: number;
  latest: () => any;
  send: (command: unknown) => void;
  close: () => Promise<void>;
}

async function withServer(body: (rig: Rig) => Promise<void>): Promise<void> {
  // Port 0 so tests never fight over 8730 or a server left running.
  const server = await startServer({ port: 0, simulate: true, model: 16 });
  const port = server.port;

  let state: any = null;
  const socket = new WebSocket(`ws://localhost:${port}/ws`);
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(String((event as MessageEvent).data));
    if (msg.type === 'state') state = msg.state;
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('ws failed to open')));
  });

  const rig: Rig = {
    socket,
    port,
    latest: () => state,
    send: (command) => socket.send(JSON.stringify(command)),
    async close() {
      socket.close();
      await server.close();
    },
  };

  try {
    await body(rig);
  } finally {
    await rig.close();
  }
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('a new browser is sent the full state immediately', async () => {
  await withServer(async (rig) => {
    await waitFor(() => rig.latest() !== null);
    const state = rig.latest();
    assert.equal(state.model, 16);
    assert.equal(state.inputs.length, 16);
    assert.equal(state.zones.length, 16);
    assert.equal(state.controlGroups.length, 32);
    // The UI shows a simulator badge off this flag; it must never be wrong.
    assert.equal(state.simulated, true);
  });
});

test('a level command reaches the simulator and is confirmed back', async () => {
  await withServer(async (rig) => {
    await waitFor(() => rig.latest()?.status === 'connected');

    rig.send({ type: 'setLevel', ref: 'zone:2', level: dbToLevel(-10) });
    await waitFor(() => rig.latest().zones[1].level === dbToLevel(-10));
    await waitFor(() => rig.latest().zones[1].origin === 'device');
  });
});

test('a mute command round-trips', async () => {
  await withServer(async (rig) => {
    await waitFor(() => rig.latest()?.status === 'connected');

    rig.send({ type: 'setMute', ref: 'input:3', muted: true });
    await waitFor(() => rig.latest().inputs[2].muted === true);

    rig.send({ type: 'setMute', ref: 'input:3', muted: false });
    await waitFor(() => rig.latest().inputs[2].muted === false);
  });
});

test('a crosspoint command round-trips and keeps level through a mute', async () => {
  await withServer(async (rig) => {
    await waitFor(() => rig.latest()?.status === 'connected');

    rig.send({ type: 'setSendLevel', from: 'input:1', to: 'zone:4', level: 100 });
    await waitFor(() => rig.latest().sends['input:1->zone:4']?.level === 100);

    rig.send({ type: 'setSendMute', from: 'input:1', to: 'zone:4', muted: true });
    await waitFor(() => rig.latest().sends['input:1->zone:4']?.muted === true);
    assert.equal(rig.latest().sends['input:1->zone:4'].level, 100);
  });
});

test('a preset recall is echoed back as the current preset', async () => {
  await withServer(async (rig) => {
    await waitFor(() => rig.latest()?.status === 'connected');

    rig.send({ type: 'recallPreset', preset: 412 });
    await waitFor(() => rig.latest().currentPreset === 412);
  });
});

test('renaming a strip is local and does not need the unit', async () => {
  await withServer(async (rig) => {
    await waitFor(() => rig.latest() !== null);

    rig.send({ type: 'rename', ref: 'zone:1', name: 'Main Bar' });
    await waitFor(() => rig.latest().zones[0].name === 'Main Bar');
  });
});

test('processing edits are stored but never marked as device state', async () => {
  await withServer(async (rig) => {
    await waitFor(() => rig.latest() !== null);

    rig.send({
      type: 'setProcessing',
      zone: 2,
      processing: { delay: { enabled: true, milliseconds: 12.5 } },
    });
    await waitFor(() => rig.latest().processing['2'].delay.milliseconds === 12.5);

    // The load-bearing assertion: the protocol cannot write this, so it must
    // never claim to have come from the unit.
    assert.equal(rig.latest().processing['2'].origin, 'local');
    // And the rest of the block must survive a partial update.
    assert.equal(rig.latest().processing['2'].peq.length, 8);
  });
});

test('a crosspoint write is confirmed by read-back, not left pending', async () => {
  await withServer(async (rig) => {
    await waitFor(() => rig.latest()?.status === 'connected');

    rig.send({ type: 'setSendLevel', from: 'input:2', to: 'zone:5', level: 90 });
    // The simulator broadcasts to OTHER clients, so without an explicit
    // read-back this would sit at 'pending' forever and read as "not taken".
    await waitFor(() => rig.latest().sends['input:2->zone:5']?.origin === 'device');
    assert.equal(rig.latest().sends['input:2->zone:5'].level, 90);
  });
});

test('a topology preset plus a live desk patches the unit end to end', async () => {
  await withServer(async (rig) => {
    await waitFor(() => rig.latest()?.status === 'connected');

    rig.send({ type: 'setTopologyPreset', preset: 'lr-sub-ff-delay' });
    await waitFor(() => rig.latest().topology.groups.length === 4);

    // Mains stereo (1,2), subs mono (3), frontfill mono (4), delays stereo (5,6).
    assert.deepEqual(
      rig.latest().topology.groups.map((g: any) => g.zones),
      [[1, 2], [3], [4], [5, 6]],
    );

    // The default production desk matches the system, so six legs open.
    await waitFor(() => Object.values(rig.latest().sends).filter((s: any) => s.level > 0).length === 6);

    rig.send({ type: 'addDesk', id: 'band', name: 'Band' });
    await waitFor(() => rig.latest().desks.desks.length === 2);

    rig.send({ type: 'toggleSecondary', id: 'band' });
    await waitFor(() => Object.values(rig.latest().sends).filter((s: any) => s.level > 0).length === 12);

    // Switching it back out must close its crosspoints, not just stop feeding.
    rig.send({ type: 'toggleSecondary', id: 'band' });
    await waitFor(() => Object.values(rig.latest().sends).filter((s: any) => s.level > 0).length === 6);
  });
});

test('a mismatched desk is compensated on the wire', async () => {
  await withServer(async (rig) => {
    await waitFor(() => rig.latest()?.status === 'connected');

    rig.send({ type: 'setTopologyPreset', preset: 'lr-sub' });
    await waitFor(() => rig.latest().topology.groups.length === 2);

    // Reshape the production desk: mono mains, and no sub send at all.
    const desk = structuredClone(rig.latest().desks.desks[0]);
    desk.feeds[0].format = 'mono';
    desk.feeds[1].source = 'derived';
    desk.feeds[1].deriveFrom = 'main';
    rig.send({ type: 'updateDesk', desk });

    // Wait on the specific crosspoint the change should create. A count of 3 is
    // already true from the matching patch, so waiting on the count samples the
    // old state and passes for the wrong reason.
    await waitFor(() => (rig.latest().sends['input:1->zone:2']?.level ?? 0) > 0);

    const open = Object.entries(rig.latest().sends)
      .filter(([, v]: any) => v.level > 0)
      .map(([k]) => k)
      .sort();

    // One mono input feeds both sides of the mains AND the derived sub.
    assert.deepEqual(open, ['input:1->zone:1', 'input:1->zone:2', 'input:1->zone:3']);
    assert.deepEqual(rig.latest().routingWarnings, []);
  });
});

test('a bad command does not take the server down', async () => {
  await withServer(async (rig) => {
    await waitFor(() => rig.latest() !== null);

    rig.socket.send('not json at all');
    rig.socket.send(JSON.stringify({ type: 'nonsense' }));
    rig.socket.send(JSON.stringify({ type: 'setLevel', ref: 'bogus:1', level: 5 }));

    // Still serving.
    rig.send({ type: 'rename', ref: 'input:1', name: 'still alive' });
    await waitFor(() => rig.latest().inputs[0].name === 'still alive');
  });
});

test('importing a factory .cfg updates the model and version', async (t) => {
  const cfg = '/Applications/AHM System Manager 1.61.app/Contents/Resources/FactoryConfigs32/AHM-32 Default.cfg';
  if (!existsSync(cfg)) return t.skip('AHM System Manager not installed');

  await withServer(async (rig) => {
    await waitFor(() => rig.latest() !== null);

    const response = await fetch(`http://localhost:${rig.port}/api/config`, {
      method: 'POST',
      body: readFileSync(cfg),
    });
    const body = await response.json();

    assert.equal(response.ok, true, JSON.stringify(body));
    assert.equal(body.model, 32);
    assert.equal(body.channelCount, 32);
    assert.match(body.version, /Rev\./);
    await waitFor(() => rig.latest().configVersion === body.version);
  });
});
