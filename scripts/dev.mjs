/**
 * Dev entrypoint: the local server and the Vite dev server, together.
 *
 * Vite proxies /api and /ws to the local server, so both must be up for the UI
 * to show anything. Defaults to the built-in simulator -- see AGENTS.md on why
 * no AHM hardware is involved anywhere in this project.
 *
 * Pass --host <address> to point at a real unit instead.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolve from this file, not the caller's cwd: the launch config that starts
// this lives in the home directory, so cwd is not the repo root.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const hostIndex = args.indexOf('--host');
const host = hostIndex === -1 ? null : args[hostIndex + 1];

const serverArgs = host ? ['--host', host] : ['--sim'];

const children = [
  spawn('node', ['src/server/index.ts', ...serverArgs], { stdio: 'inherit', cwd: ROOT }),
  spawn('npx', ['vite', '--config', 'web/vite.config.ts'], { stdio: 'inherit', cwd: ROOT }),
];

const shutdown = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

for (const child of children) {
  // If either half dies the other is useless, so take both down.
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) shutdown();
  });
}
