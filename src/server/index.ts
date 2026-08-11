/**
 * The local server. Holds the single TCP connection to the AHM and fans it out
 * to any number of browsers over a WebSocket.
 *
 * One connection to the unit, many operators: that is the install case this is
 * built for. The unit is the authority on everything the protocol can read;
 * anything it cannot read is held here and clearly labelled as local.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer, type WebSocket } from 'ws';

import { AhmDevice } from './device.ts';
import { AhmSimulator } from '../sim/simulator.ts';
import { readSystemConfig } from '../config/container.ts';
import { parseStripId } from '../protocol/addressing.ts';
import {
  createSystemState,
  crosspointKey,
  defaultProcessing,
  stripsFor,
  type SystemState,
  type ZoneProcessing,
} from '../protocol/state.ts';
import {
  allocateZones,
  topologyFromPreset,
  type OutputGroup,
  type TopologyPresetId,
} from '../system/topology.ts';
import {
  allocateDeskInputs,
  deskForTopology,
  reconcileDesk,
  setSelectMode,
  toggleSecondary,
  type Desk,
} from '../system/desks.ts';
import { diffRouting, managedCrosspoints, resolveRouting } from '../system/routing.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIST = join(HERE, '..', '..', 'web', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export interface ServerOptions {
  /** Port the browser connects to. */
  port?: number;
  /** AHM host. Omit to start with no device and connect from the UI. */
  ahmHost?: string;
  ahmPort?: number;
  model?: 16 | 32 | 64;
  /** Start an in-process simulator and point the client at it. */
  simulate?: boolean;
}

export async function startServer(options: ServerOptions = {}) {
  const port = options.port ?? 8730;
  const model = options.model ?? 64;

  let device: AhmDevice | null = null;
  let simulator: AhmSimulator | null = null;
  /** State shown when no device exists, so the UI always has something. */
  let offlineState: SystemState = createSystemState(model);

  /**
   * Every crosspoint this server has ever opened.
   *
   * The managed space computed from the CURRENT allocation is not enough to
   * close things down. Reconfiguring a desk to use fewer inputs — a stereo feed
   * becoming mono, or a group switching to derived — drops those inputs out of
   * the allocation, so their still-open crosspoints fall outside the managed set
   * and can never be closed again. That leaves a console you thought you had
   * removed still feeding the PA.
   *
   * Remembering what we opened means we can always close it. It is deliberately
   * additive and never pruned: forgetting is exactly the failure being fixed.
   * It does not survive a restart, which is the one gap — a fresh server does
   * not know what the previous one opened.
   */
  const opened = new Set<string>();

  const sockets = new Set<WebSocket>();

  const currentState = (): SystemState => {
    const state = device ? device.state : offlineState;
    return { ...state, simulated: simulator !== null };
  };

  const broadcast = () => {
    const payload = JSON.stringify({ type: 'state', state: currentState() });
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  };

  const attachDevice = (next: AhmDevice) => {
    device?.close();
    device = next;
    // Carry across everything the unit cannot tell us: names and processing.
    next.state.processing = offlineState.processing;
    next.state.presetNames = offlineState.presetNames;
    next.state.configVersion = offlineState.configVersion;
    // The system design is ours, not the unit's -- it must survive a reconnect
    // or an operator would lose their whole patch on a dropped link.
    next.state.topology = offlineState.topology;
    next.state.desks = offlineState.desks;
    next.state.routingWarnings = offlineState.routingWarnings;
    for (const kind of ['input', 'zone', 'controlGroup'] as const) {
      const previous = stripsFor(offlineState, kind);
      stripsFor(next.state, kind).forEach((strip, i) => {
        if (previous[i]?.name) strip.name = previous[i].name;
      });
    }
    next.on('state', broadcast);
    next.connect();
  };

  if (options.simulate) {
    simulator = new AhmSimulator({ model, port: 0, host: '127.0.0.1' });
    const simPort = await simulator.listen();
    attachDevice(new AhmDevice({ host: '127.0.0.1', port: simPort, model }));
  } else if (options.ahmHost) {
    attachDevice(new AhmDevice({ host: options.ahmHost, port: options.ahmPort, model }));
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/config' && req.method === 'POST') {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const config = readSystemConfig(new Uint8Array(Buffer.concat(chunks)));

        const target = device ? device.state : offlineState;
        target.model = config.model;
        target.configVersion = config.version;

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            model: config.model,
            version: config.version,
            channelCount: config.mixer.channelCount,
            declaredCount: config.mixer.declaredCount,
            stereoPairs: config.mixer.mapA.filter((p) => p === 'stereo').length,
            members: [...config.raw.keys()],
          }),
        );
        broadcast();
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(currentState()));
      return;
    }

    // Static files, when a production build exists.
    if (!existsSync(WEB_DIST)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('web/dist not built -- run `npm run dev` for the Vite dev server');
      return;
    }

    // normalize + prefix check keeps ../ out of the served tree.
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = normalize(join(WEB_DIST, requested));
    if (!filePath.startsWith(WEB_DIST)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    try {
      const body = await readFile(existsSync(filePath) ? filePath : join(WEB_DIST, 'index.html'));
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.send(JSON.stringify({ type: 'state', state: currentState() }));

    socket.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      // A malformed ref or a bad value must not take the socket down with it --
      // one buggy browser tab should never disconnect the room.
      try {
        handleCommand(msg);
      } catch (err) {
        socket.send(JSON.stringify({ type: 'error', message: (err as Error).message }));
      }
    });

    socket.on('close', () => sockets.delete(socket));
  });

  /**
   * Re-derive the patch and push only what changed.
   *
   * Called after ANY change to the topology, the desks, or which desks are
   * live. Desks are reconciled and re-allocated first so a topology edit cannot
   * leave a desk feeding a group that no longer exists.
   *
   * Crosspoints outside the managed space are never touched — see
   * managedCrosspoints() for why that containment matters.
   */
  function applyRouting(state: SystemState): void {
    state.topology = {
      ...state.topology,
      groups: allocateZones(state.topology.groups, state.model),
    };
    state.desks = {
      ...state.desks,
      desks: allocateDeskInputs(
        state.desks.desks.map((desk) => reconcileDesk(desk, state.topology)),
        state.model,
      ),
    };

    const { crosspoints, warnings } = resolveRouting(state.topology, state.desks);
    state.routingWarnings = warnings;

    if (device) {
      const managed = managedCrosspoints(state.topology, state.desks);
      for (const key of opened) managed.add(key);

      const changes = diffRouting(crosspoints, state.sends, managed);
      for (const change of changes) {
        device.setSendLevel(change.from, change.to, change.level);
        if (change.level > 0) opened.add(crosspointKey(change.from, change.to));
      }
    }

    broadcast();
  }

  function handleCommand(msg: Record<string, unknown>): void {
    const state = device ? device.state : offlineState;

    switch (msg.type) {
      // ---- system design -------------------------------------------------

      case 'setTopologyPreset': {
        state.topology = topologyFromPreset(String(msg.preset) as TopologyPresetId, state.model);
        applyRouting(state);
        break;
      }

      case 'setTopologyGroups': {
        state.topology = {
          preset: 'custom',
          groups: msg.groups as OutputGroup[],
        };
        applyRouting(state);
        break;
      }

      case 'addDesk': {
        const id = String(msg.id ?? `desk${state.desks.desks.length + 1}`);
        const role = state.desks.desks.some((d) => d.role === 'production')
          ? ('secondary' as const)
          : ('production' as const);
        state.desks = {
          ...state.desks,
          desks: [
            ...state.desks.desks,
            deskForTopology(id, String(msg.name ?? `Desk ${state.desks.desks.length + 1}`), role, state.topology),
          ],
        };
        applyRouting(state);
        break;
      }

      case 'updateDesk': {
        const incoming = msg.desk as Desk;
        state.desks = {
          ...state.desks,
          desks: state.desks.desks.map((desk) => (desk.id === incoming.id ? incoming : desk)),
        };
        applyRouting(state);
        break;
      }

      case 'removeDesk': {
        const id = String(msg.id);
        state.desks = {
          ...state.desks,
          desks: state.desks.desks.filter((desk) => desk.id !== id),
          activeSecondaryIds: state.desks.activeSecondaryIds.filter((active) => active !== id),
        };
        applyRouting(state);
        break;
      }

      case 'toggleSecondary':
        state.desks = toggleSecondary(state.desks, String(msg.id));
        applyRouting(state);
        break;

      case 'setSelectMode':
        state.desks = setSelectMode(state.desks, msg.mode === 'multi' ? 'multi' : 'single');
        applyRouting(state);
        break;

      case 'setSummingGain':
        state.desks = { ...state.desks, summingGainDb: Number(msg.db) };
        applyRouting(state);
        break;

      case 'reapplyRouting':
        applyRouting(state);
        break;

      case 'setLevel':
        device?.setLevel(parseStripId(String(msg.ref)), Number(msg.level));
        break;

      case 'setMute':
        device?.setMute(parseStripId(String(msg.ref)), Boolean(msg.muted));
        break;

      case 'setSendLevel':
        device?.setSendLevel(
          parseStripId(String(msg.from)),
          parseStripId(String(msg.to)),
          Number(msg.level),
        );
        break;

      case 'setSendMute':
        device?.setSendMute(
          parseStripId(String(msg.from)),
          parseStripId(String(msg.to)),
          Boolean(msg.muted),
        );
        break;

      case 'recallPreset':
        device?.recallPreset(Number(msg.preset));
        break;

      case 'selectSource':
        device?.selectSource(Number(msg.zone), Number(msg.source));
        break;

      case 'rename': {
        const ref = parseStripId(String(msg.ref));
        const strip = stripsFor(state, ref.kind)[ref.index - 1];
        if (strip) strip.name = String(msg.name);
        broadcast();
        break;
      }

      case 'setPresetName':
        state.presetNames[Number(msg.preset)] = String(msg.name);
        broadcast();
        break;

      case 'setProcessing': {
        // Local only. The published protocol cannot write processing, so this
        // never touches the socket -- and it stays marked as local so the UI
        // keeps saying so.
        const zone = Number(msg.zone);
        const incoming = msg.processing as Partial<ZoneProcessing> | undefined;
        state.processing[zone] = {
          ...(state.processing[zone] ?? defaultProcessing()),
          ...incoming,
          origin: 'local',
        };
        broadcast();
        break;
      }

      case 'setGroupProcessing': {
        // Processing lives on the output, so every desk routed to a group
        // shares it. A stereo group's two zones are edited as one.
        const group = state.topology.groups.find((g) => g.id === String(msg.group));
        if (!group) break;
        const incoming = msg.processing as Partial<ZoneProcessing> | undefined;
        for (const zone of group.zones) {
          state.processing[zone] = {
            ...(state.processing[zone] ?? defaultProcessing()),
            ...incoming,
            origin: 'local',
          };
        }
        broadcast();
        break;
      }

      case 'connect': {
        offlineState = device ? device.state : offlineState;
        attachDevice(
          new AhmDevice({
            host: String(msg.host),
            port: msg.port ? Number(msg.port) : undefined,
            model: (Number(msg.model) || model) as 16 | 32 | 64,
          }),
        );
        broadcast();
        break;
      }

      case 'disconnect':
        device?.close();
        device = null;
        broadcast();
        break;

      default:
        break;
    }
  }

  await new Promise<void>((resolve) => server.listen(port, resolve));

  // Report the port actually bound, not the one requested: port 0 means "pick
  // one", and callers need to know which.
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  return {
    port: boundPort,
    url: `http://localhost:${boundPort}`,
    simulated: simulator !== null,
    async close() {
      for (const socket of sockets) socket.close();
      wss.close();
      device?.close();
      await simulator?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Run directly: `node src/server/index.ts --sim`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };

  const started = await startServer({
    port: Number(flag('--port') ?? 8730),
    ahmHost: flag('--host'),
    ahmPort: flag('--ahm-port') ? Number(flag('--ahm-port')) : undefined,
    model: (Number(flag('--model')) || 64) as 16 | 32 | 64,
    simulate: args.includes('--sim'),
  });

  const target = started.simulated ? 'built-in simulator (no hardware)' : (flag('--host') ?? 'no device');
  console.log(`ahm-control listening on ${started.url}  ->  ${target}`);
}
