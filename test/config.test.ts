/**
 * These tests run against the factory .cfg files that ship inside AHM System
 * Manager. They skip cleanly when it is not installed, so CI stays green on a
 * machine that has no Allen & Heath software -- no fixture is vendored into
 * this repo, because those files are Allen & Heath's, not ours.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { readSystemConfig, untar } from '../src/config/container.ts';
import { parseMixerConfig, expandPairs, MIXER_MAGIC } from '../src/config/mixer.ts';

const APP = '/Applications/AHM System Manager 1.61.app/Contents/Resources';
const CONFIG_DIRS = ['FactoryConfigs16', 'FactoryConfigs32', 'FactoryConfigs'];
const installed = existsSync(APP);

function factoryConfigs(): Array<{ label: string; bytes: Uint8Array }> {
  const out: Array<{ label: string; bytes: Uint8Array }> = [];
  for (const dir of CONFIG_DIRS) {
    const path = join(APP, dir);
    if (!existsSync(path)) continue;
    for (const file of readdirSync(path)) {
      if (file.endsWith('.cfg')) {
        out.push({ label: file, bytes: readFileSync(join(path, file)) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure parsing -- no installed software required
// ---------------------------------------------------------------------------

test('parses a Mixer.cfg block', () => {
  const text = [MIXER_MAGIC, 'mmmmmmSS', 'mmmmmmmm', '12', '0'.repeat(16), 'N'.repeat(8)].join('\r\n');
  const cfg = parseMixerConfig(text);

  assert.equal(cfg.channelCount, 16);
  assert.equal(cfg.declaredCount, 12);
  assert.equal(cfg.mapA.length, 8);
  assert.deepEqual(cfg.mapA.slice(6), ['stereo', 'stereo']);
  assert.equal(cfg.mapB.every((p) => p === 'mono'), true);
});

test('rejects a Mixer.cfg with an unknown magic', () => {
  assert.throws(() => parseMixerConfig('MixerConfigV9\r\nmm\r\nmm\r\n4\r\n0000\r\nNN'), /magic/);
});

test('rejects an unknown pairing character rather than silently dropping it', () => {
  assert.throws(() => parseMixerConfig([MIXER_MAGIC, 'mmX', 'mmm', '6', '0'.repeat(6), 'NNN'].join('\r\n')), /unexpected/);
});

test('expandPairs yields two channels per map entry', () => {
  const expanded = expandPairs(['mono', 'stereo']);
  assert.deepEqual(expanded.map((e) => e.channel), [1, 2, 3, 4]);
  assert.deepEqual(expanded.map((e) => e.pairing), ['mono', 'mono', 'stereo', 'stereo']);
  assert.deepEqual(expanded.map((e) => e.isRight), [false, true, false, true]);
});

test('untar reads a hand-built archive', () => {
  // 512-byte header: name at 0, octal size at 124, type flag at 156.
  const header = new Uint8Array(512);
  const put = (s: string, at: number) => {
    for (let i = 0; i < s.length; i++) header[at + i] = s.charCodeAt(i);
  };
  put('archive/hello.txt', 0);
  put('000000000005', 124);
  put('0', 156);

  const payload = new Uint8Array(512);
  for (let i = 0; i < 5; i++) payload[i] = 'hello'.charCodeAt(i);

  const archive = new Uint8Array(512 * 4);
  archive.set(header, 0);
  archive.set(payload, 512);

  const entries = untar(archive);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'archive/hello.txt');
  assert.equal(new TextDecoder().decode(entries[0].data), 'hello');
});

// ---------------------------------------------------------------------------
// Against the real factory files
// ---------------------------------------------------------------------------

test('reads every factory config that ships with System Manager', { skip: !installed }, () => {
  const configs = factoryConfigs();
  assert.ok(configs.length >= 6, `expected at least 6 factory configs, found ${configs.length}`);

  for (const { label, bytes } of configs) {
    const cfg = readSystemConfig(bytes);

    // The model in the marker filename must agree with the geometry in Mixer.cfg.
    assert.equal(
      cfg.mixer.channelCount,
      cfg.model,
      `${label}: Mixer.cfg geometry (${cfg.mixer.channelCount}) disagrees with unit type (${cfg.model})`,
    );
    assert.match(cfg.version, /^\d+\s/, `${label}: unexpected Version.txt`);
    assert.ok(cfg.raw.has('archive/CurrentSettings.dat'), `${label}: no CurrentSettings.dat`);
    assert.ok(cfg.raw.has('archive/Scene1.dat'), `${label}: no Scene1.dat`);
  }
});

test('the "Empty" configs declare a count equal to the channel count', { skip: !installed }, () => {
  for (const { label, bytes } of factoryConfigs()) {
    if (!label.includes('Empty')) continue;
    const cfg = readSystemConfig(bytes);
    assert.equal(cfg.mixer.declaredCount, cfg.model, `${label}`);
    assert.equal(cfg.mixer.mapA.every((p) => p === 'mono'), true, `${label}: expected all-mono`);
  }
});

test('the "Default" configs carry stereo pairs and a smaller declared count', { skip: !installed }, () => {
  for (const { label, bytes } of factoryConfigs()) {
    if (!label.includes('Default')) continue;
    const cfg = readSystemConfig(bytes);
    assert.ok(
      cfg.mixer.mapA.includes('stereo'),
      `${label}: expected at least one stereo pair in map A`,
    );
    // Recorded as an observation, not a derivation: see mixer.ts on why the
    // declared count is not computed from the maps.
    assert.ok(cfg.mixer.declaredCount < cfg.model, `${label}`);
  }
});
