/**
 * Client <-> simulator over a real TCP socket.
 *
 * Both sides were written from the same published spec, so a pass here means
 * the client is internally consistent and the framing survives a real socket.
 * It is NOT evidence that a physical AHM accepts these bytes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { AhmSimulator } from '../src/sim/simulator.ts';
import { AhmDevice } from '../src/server/device.ts';
import { dbToLevel } from '../src/protocol/levels.ts';
import { crosspointKey } from '../src/protocol/state.ts';

/** Wait for a predicate to hold, polling the event stream. */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function withRig(
  model: 16 | 32 | 64,
  body: (sim: AhmSimulator, device: AhmDevice) => Promise<void>,
): Promise<void> {
  // Port 0 lets the OS pick, so tests never collide with a real unit or a
  // simulator someone left running on 51325.
  const sim = new AhmSimulator({ model, port: 0, host: '127.0.0.1' });
  const port = await sim.listen();

  const device = new AhmDevice({ host: '127.0.0.1', port, model, syncOnConnect: false });
  device.connect();
  await once(device, 'status');

  // Both sides, not just the client. The client reports 'connected' as soon as
  // the TCP handshake completes, but the server registers the socket in a later
  // turn of its event loop -- a broadcast fired in that window reaches nobody.
  await waitFor(() => device.state.status === 'connected' && sim.clientCount >= 1);

  try {
    await body(sim, device);
  } finally {
    device.close();
    await sim.close();
  }
}

test('connects and reports status', async () => {
  await withRig(64, async (sim, device) => {
    assert.equal(device.state.status, 'connected');
    assert.equal(sim.clientCount, 1);
  });
});

test('a level set reaches the simulator and comes back confirmed', async () => {
  await withRig(64, async (sim, device) => {
    const ref = { kind: 'zone', index: 3 } as const;
    device.setLevel(ref, dbToLevel(-6));

    // Before the echo, the client must not claim the unit agreed.
    assert.equal(device.state.zones[2].origin, 'pending');

    await waitFor(() => sim.peek(ref).level === dbToLevel(-6));
    assert.equal(sim.peek(ref).level, dbToLevel(-6));
  });
});

test('a mute round-trips through the two-message Note On pair', async () => {
  await withRig(64, async (sim, device) => {
    const ref = { kind: 'input', index: 5 } as const;
    device.setMute(ref, true);
    await waitFor(() => sim.peek(ref).muted === true);

    device.setMute(ref, false);
    await waitFor(() => sim.peek(ref).muted === false);
  });
});

test('a send crosspoint round-trips', async () => {
  await withRig(64, async (sim, device) => {
    const from = { kind: 'input', index: 2 } as const;
    const to = { kind: 'zone', index: 7 } as const;

    device.setSendLevel(from, to, dbToLevel(0));
    await waitFor(() => sim.peekSend(from, to)?.level === dbToLevel(0));

    device.setSendMute(from, to, true);
    await waitFor(() => sim.peekSend(from, to)?.muted === true);
    // Muting a crosspoint must not disturb its level.
    assert.equal(sim.peekSend(from, to)?.level, dbToLevel(0));
  });
});

test('preset recall is echoed back to the client that asked', async () => {
  await withRig(64, async (sim, device) => {
    device.recallPreset(300);
    await waitFor(() => sim.currentPreset === 300);
    // The unit transmits recalls to everyone, so the client learns its own.
    await waitFor(() => device.state.currentPreset === 300);
  });
});

test('preset recall works at the top of the short fourth bank', async () => {
  await withRig(64, async (sim, device) => {
    device.recallPreset(500);
    await waitFor(() => sim.currentPreset === 500);
    await waitFor(() => device.state.currentPreset === 500);
  });
});

test('source selection is answered with colour and name', async () => {
  await withRig(64, async (_sim, device) => {
    device.selectSource(4, 6);
    await waitFor(() => device.state.sources[4] === 6);
  });
});

test('an unsolicited change from the unit updates the client', async () => {
  await withRig(64, async (sim, device) => {
    // Nobody asked for this -- it is the front panel or another controller.
    sim.simulateLocalChange('zone', 9, 40);
    await waitFor(() => device.state.zones[8].level === 40);
    // And it must be marked as the unit's own value, not ours.
    assert.equal(device.state.zones[8].origin, 'device');
  });
});

test('syncOnConnect seeds every strip from the unit', async () => {
  const sim = new AhmSimulator({ model: 16, port: 0, host: '127.0.0.1' });
  const port = await sim.listen();
  sim.simulateLocalChange('zone', 2, 77);

  const device = new AhmDevice({ host: '127.0.0.1', port, model: 16, syncOnConnect: true });
  device.connect();

  try {
    await waitFor(() => device.state.zones[1].level === 77 && device.state.zones[1].origin === 'device');
    // Every strip should have been answered, not just the one we changed.
    await waitFor(() => device.state.inputs.every((s) => s.origin === 'device'));
  } finally {
    device.close();
    await sim.close();
  }
});

test('two clients stay in step', async () => {
  const sim = new AhmSimulator({ model: 64, port: 0, host: '127.0.0.1' });
  const port = await sim.listen();

  const a = new AhmDevice({ host: '127.0.0.1', port, syncOnConnect: false });
  const b = new AhmDevice({ host: '127.0.0.1', port, syncOnConnect: false });
  a.connect();
  b.connect();

  try {
    await waitFor(() => a.state.status === 'connected' && b.state.status === 'connected');

    a.setLevel({ kind: 'zone', index: 1 }, 60);
    // B did not send this, so it must arrive as a device-originated update.
    await waitFor(() => b.state.zones[0].level === 60);
    assert.equal(b.state.zones[0].origin, 'device');

    b.setMute({ kind: 'zone', index: 1 }, true);
    await waitFor(() => a.state.zones[0].muted === true);
  } finally {
    a.close();
    b.close();
    await sim.close();
  }
});

test('the client reconnects after the unit drops the link', async () => {
  const sim = new AhmSimulator({ model: 64, port: 0, host: '127.0.0.1' });
  const port = await sim.listen();

  const device = new AhmDevice({ host: '127.0.0.1', port, syncOnConnect: false });
  device.connect();

  try {
    await waitFor(() => device.state.status === 'connected');

    // Drop every client the way a rebooting processor would.
    await sim.close();
    await waitFor(() => device.state.status !== 'connected');

    const revived = new AhmSimulator({ model: 64, port, host: '127.0.0.1' });
    await revived.listen();
    await waitFor(() => device.state.status === 'connected', 8000);

    // And the link must be usable again, not merely reported as up.
    device.setLevel({ kind: 'zone', index: 1 }, 50);
    await waitFor(() => revived.peek({ kind: 'zone', index: 1 }).level === 50);
    await revived.close();
  } finally {
    device.close();
  }
});

test('crosspoint keys are stable and distinguish direction', () => {
  const input3 = { kind: 'input', index: 3 } as const;
  const zone1 = { kind: 'zone', index: 1 } as const;
  assert.equal(crosspointKey(input3, zone1), 'input:3->zone:1');
  assert.notEqual(crosspointKey(input3, zone1), crosspointKey(zone1, input3));
});
