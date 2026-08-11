/**
 * Biquad coefficients and magnitude response, for drawing the EQ curve.
 *
 * RBJ Audio EQ Cookbook forms, evaluated on the unit circle. This models THIS
 * APP'S filters, not the AHM's: the unit's actual filter topology and its Q
 * convention are not published, so the drawn curve is a faithful picture of the
 * values in the editor rather than a prediction of the unit's output.
 *
 * Anything that needs to match hardware has to wait for the RE track.
 */

import type { FilterType, PeqBand } from '../protocol/state.ts';

export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export const DEFAULT_SAMPLE_RATE = 48_000;

export function designBiquad(
  type: FilterType,
  frequency: number,
  gainDb: number,
  q: number,
  sampleRate = DEFAULT_SAMPLE_RATE,
): BiquadCoefficients {
  // Clamp below Nyquist: a band parked at or above it produces NaN coefficients
  // and silently blanks the whole curve.
  const f = Math.min(Math.max(frequency, 1), sampleRate / 2 - 1);
  const safeQ = Math.max(q, 1e-4);

  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos0 = Math.cos(w0);
  const sin0 = Math.sin(w0);
  const alpha = sin0 / (2 * safeQ);

  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;

  switch (type) {
    case 'bell': {
      b0 = 1 + alpha * A;
      b1 = -2 * cos0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos0;
      a2 = 1 - alpha / A;
      break;
    }
    case 'lowShelf': {
      const sqrtA = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos0 + sqrtA);
      b1 = 2 * A * (A - 1 - (A + 1) * cos0);
      b2 = A * (A + 1 - (A - 1) * cos0 - sqrtA);
      a0 = A + 1 + (A - 1) * cos0 + sqrtA;
      a1 = -2 * (A - 1 + (A + 1) * cos0);
      a2 = A + 1 + (A - 1) * cos0 - sqrtA;
      break;
    }
    case 'highShelf': {
      const sqrtA = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos0 + sqrtA);
      b1 = -2 * A * (A - 1 + (A + 1) * cos0);
      b2 = A * (A + 1 + (A - 1) * cos0 - sqrtA);
      a0 = A + 1 - (A - 1) * cos0 + sqrtA;
      a1 = 2 * (A - 1 - (A + 1) * cos0);
      a2 = A + 1 - (A - 1) * cos0 - sqrtA;
      break;
    }
    case 'highPass': {
      b0 = (1 + cos0) / 2;
      b1 = -(1 + cos0);
      b2 = (1 + cos0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos0;
      a2 = 1 - alpha;
      break;
    }
    case 'lowPass': {
      b0 = (1 - cos0) / 2;
      b1 = 1 - cos0;
      b2 = (1 - cos0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos0;
      a2 = 1 - alpha;
      break;
    }
  }

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Magnitude response in dB at one frequency. */
export function magnitudeDb(
  c: BiquadCoefficients,
  frequency: number,
  sampleRate = DEFAULT_SAMPLE_RATE,
): number {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const cosw = Math.cos(w);
  const sinw = Math.sin(w);
  const cos2w = Math.cos(2 * w);
  const sin2w = Math.sin(2 * w);

  const numRe = c.b0 + c.b1 * cosw + c.b2 * cos2w;
  const numIm = -(c.b1 * sinw + c.b2 * sin2w);
  const denRe = 1 + c.a1 * cosw + c.a2 * cos2w;
  const denIm = -(c.a1 * sinw + c.a2 * sin2w);

  const num = Math.hypot(numRe, numIm);
  const den = Math.hypot(denRe, denIm);
  if (den === 0) return -120;
  return 20 * Math.log10(Math.max(num / den, 1e-6));
}

/** Log-spaced frequency axis, the way an EQ display is always drawn. */
export function logFrequencies(count: number, min = 20, max = 20_000): number[] {
  const logMin = Math.log10(min);
  const step = (Math.log10(max) - logMin) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.pow(10, logMin + i * step));
}

/** Summed response of every enabled band, in dB, over the given frequencies. */
export function combinedResponse(
  bands: PeqBand[],
  frequencies: number[],
  sampleRate = DEFAULT_SAMPLE_RATE,
): number[] {
  const active = bands
    .filter((band) => band.enabled)
    .map((band) => designBiquad(band.type, band.frequency, band.gain, band.q, sampleRate));

  return frequencies.map((f) => {
    let total = 0;
    // Cascaded filters multiply in magnitude, so they add in dB.
    for (const c of active) total += magnitudeDb(c, f, sampleRate);
    return total;
  });
}

/** Delay in milliseconds -> distance in metres, for the delay editor. */
export function msToMetres(ms: number, speedOfSound = 343): number {
  return (ms / 1000) * speedOfSound;
}

export function metresToMs(metres: number, speedOfSound = 343): number {
  return (metres / speedOfSound) * 1000;
}
