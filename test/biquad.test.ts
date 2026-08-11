import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  designBiquad,
  magnitudeDb,
  combinedResponse,
  logFrequencies,
  msToMetres,
  metresToMs,
  DEFAULT_SAMPLE_RATE,
} from '../src/dsp/biquad.ts';
import { defaultProcessing, type PeqBand } from '../src/protocol/state.ts';

const close = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ${expected} +/- ${tolerance}, got ${actual}`,
  );

test('a bell delivers its gain at centre frequency', () => {
  const c = designBiquad('bell', 1000, 6, 2);
  close(magnitudeDb(c, 1000), 6, 0.05, 'bell peak');
});

test('a cut bell is the mirror of a boost', () => {
  const boost = magnitudeDb(designBiquad('bell', 1000, 6, 2), 1000);
  const cut = magnitudeDb(designBiquad('bell', 1000, -6, 2), 1000);
  close(boost, -cut, 0.05, 'symmetry');
});

test('a bell is transparent far from its centre', () => {
  const c = designBiquad('bell', 1000, 12, 4);
  close(magnitudeDb(c, 30), 0, 0.2, 'far below');
  close(magnitudeDb(c, 18000), 0, 0.5, 'far above');
});

test('a flat band contributes nothing', () => {
  const c = designBiquad('bell', 1000, 0, 1.4);
  for (const f of [100, 1000, 8000]) close(magnitudeDb(c, f), 0, 1e-9, `flat at ${f}`);
});

test('higher Q makes a narrower bell', () => {
  const wide = designBiquad('bell', 1000, 6, 0.7);
  const narrow = designBiquad('bell', 1000, 6, 8);
  // Both hit +6 at centre, but an octave away the narrow one has fallen further.
  close(magnitudeDb(wide, 1000), 6, 0.05, 'wide peak');
  close(magnitudeDb(narrow, 1000), 6, 0.05, 'narrow peak');
  assert.ok(
    magnitudeDb(narrow, 2000) < magnitudeDb(wide, 2000),
    'narrow band should be closer to flat an octave up',
  );
});

test('a high-pass is -3 dB at cutoff and rolls off below', () => {
  const c = designBiquad('highPass', 100, 0, Math.SQRT1_2);
  close(magnitudeDb(c, 100), -3, 0.1, 'butterworth cutoff');
  assert.ok(magnitudeDb(c, 25) < -20, 'two octaves down should be well attenuated');
  close(magnitudeDb(c, 10000), 0, 0.1, 'passband');
});

test('a low-pass is -3 dB at cutoff and rolls off above', () => {
  const c = designBiquad('lowPass', 8000, 0, Math.SQRT1_2);
  close(magnitudeDb(c, 8000), -3, 0.1, 'butterworth cutoff');
  close(magnitudeDb(c, 100), 0, 0.1, 'passband');
});

test('shelves reach their gain in the shelf and stay flat in the other band', () => {
  const low = designBiquad('lowShelf', 200, 6, Math.SQRT1_2);
  close(magnitudeDb(low, 20), 6, 0.3, 'low shelf plateau');
  close(magnitudeDb(low, 15000), 0, 0.3, 'low shelf far side');

  const high = designBiquad('highShelf', 4000, -6, Math.SQRT1_2);
  close(magnitudeDb(high, 19000), -6, 0.5, 'high shelf plateau');
  close(magnitudeDb(high, 40), 0, 0.3, 'high shelf far side');
});

test('a band pinned above Nyquist stays finite', () => {
  // Left unclamped this yields NaN coefficients and blanks the entire display.
  const c = designBiquad('bell', 96_000, 6, 2, DEFAULT_SAMPLE_RATE);
  for (const f of [100, 1000, 20000]) {
    assert.ok(Number.isFinite(magnitudeDb(c, f)), `magnitude at ${f} must be finite`);
  }
});

test('a zero Q does not produce NaN', () => {
  const c = designBiquad('bell', 1000, 6, 0);
  assert.ok(Number.isFinite(magnitudeDb(c, 1000)));
});

test('disabled bands are excluded from the combined response', () => {
  const bands: PeqBand[] = [
    { enabled: false, type: 'bell', frequency: 1000, gain: 12, q: 2 },
    { enabled: true, type: 'bell', frequency: 1000, gain: 3, q: 2 },
  ];
  const [atCentre] = combinedResponse(bands, [1000]);
  close(atCentre, 3, 0.05, 'only the enabled band counts');
});

test('cascaded bands add in dB', () => {
  const bands: PeqBand[] = [
    { enabled: true, type: 'bell', frequency: 1000, gain: 3, q: 2 },
    { enabled: true, type: 'bell', frequency: 1000, gain: 4, q: 2 },
  ];
  const [atCentre] = combinedResponse(bands, [1000]);
  close(atCentre, 7, 0.05, 'gains sum');
});

test('a default processing block is flat', () => {
  const { peq } = defaultProcessing();
  const frequencies = logFrequencies(64);
  for (const db of combinedResponse(peq, frequencies)) {
    close(db, 0, 1e-9, 'default curve');
  }
});

test('log frequency axis spans the audio band', () => {
  const f = logFrequencies(100, 20, 20000);
  assert.equal(f.length, 100);
  close(f[0], 20, 1e-9, 'start');
  close(f[99], 20000, 1e-6, 'end');
  // Log spacing: the midpoint of the axis is the geometric mean, not the mean.
  close(f[49] * f[50], 20 * 20000, 20000, 'geometric symmetry');
});

test('delay converts between time and distance', () => {
  close(msToMetres(1000), 343, 1e-9, 'one second');
  close(metresToMs(343), 1000, 1e-9, 'inverse');
  close(metresToMs(msToMetres(12.7)), 12.7, 1e-9, 'round trip');
});
