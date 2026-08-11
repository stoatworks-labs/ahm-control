/**
 * Level conversion for the AHM TCP/IP protocol.
 *
 * The published spec gives the curve as [(Gain + 48) / 58] * 127, mapping a
 * -48..+10 dB range onto a single 7-bit MIDI data byte.
 *
 * The spec's own reference table disagrees with that formula at two points --
 * see docs/protocol.md ("Known conflicts"). The formula is treated as canonical
 * here because it is exact at unity (0 dB -> 105 / 0x69) and self-consistent
 * across the whole documented range; the table's +5 dB row is not.
 */

/** Lowest gain the byte range can express. Byte 0 is also used for -inf. */
export const MIN_DB = -48;
/** Highest gain the byte range can express. */
export const MAX_DB = 10;
/** Span of the gain range, the divisor in the published curve. */
export const DB_SPAN = MAX_DB - MIN_DB; // 58

/** Sentinel for a fully closed level. The wire byte is 0, same as -48 dB. */
export const MINUS_INF = Number.NEGATIVE_INFINITY;

export function clampDb(db: number): number {
  if (db <= MIN_DB) return MIN_DB;
  if (db >= MAX_DB) return MAX_DB;
  return db;
}

/**
 * dB -> 7-bit level byte. -inf and anything at or below -48 dB collapse to 0,
 * which is what the unit treats as off.
 *
 * Truncates rather than rounds. That is not a stylistic choice: the published
 * reference table only reproduces under truncation. Rounding matches at most
 * gain points but disagrees at -40 dB (17 vs 18) and -45 dB (6 vs 7).
 *
 * The epsilon is load-bearing. Without it, binary floating point lands values
 * such as byte 3 on 2.9999999999999996 and the truncation loses a step, which
 * breaks byte -> dB -> byte round-trips.
 */
export function dbToLevel(db: number): number {
  if (!Number.isFinite(db)) return db > 0 ? 127 : 0;
  const raw = ((clampDb(db) - MIN_DB) / DB_SPAN) * 127;
  return Math.min(127, Math.max(0, Math.floor(raw + 1e-9)));
}

/**
 * 7-bit level byte -> dB. Byte 0 reports as -48 rather than -inf: the wire
 * cannot distinguish the two, so the caller decides which it means.
 */
export function levelToDb(level: number): number {
  const byte = Math.min(127, Math.max(0, Math.round(level)));
  return (byte / 127) * DB_SPAN + MIN_DB;
}

/** Round-trip-stable dB value for a byte, to one decimal place. */
export function levelToDbRounded(level: number): number {
  return Math.round(levelToDb(level) * 10) / 10;
}

/** Format a level byte for display, using the -inf convention at the bottom. */
export function formatLevel(level: number): string {
  if (level <= 0) return '-inf';
  const db = levelToDbRounded(level);
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}
