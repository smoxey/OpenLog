/**
 * Duration conversions.
 *
 * DESIGN: all durations in the logbook are stored as INTEGER MINUTES.
 * These represent the pilot's *logged* time — already rounded by the pilot to
 * tenths of an hour. Because one tenth of an hour is exactly 6 minutes, any
 * logged decimal value (x.y hours) converts to a whole number of minutes with
 * no loss. See README for the rationale.
 *
 * Decimal is the default display format; hh:mm is an alternative controlled by
 * a user setting. These functions are pure and side-effect free.
 */

const MINUTES_PER_HOUR = 60;

/**
 * Format integer minutes as decimal hours with exactly one decimal place.
 *   138 -> "2.3", 84 -> "1.4", 6 -> "0.1", 0 -> "0.0"
 */
export function minutesToDecimal(minutes: number): string {
  return (minutes / MINUTES_PER_HOUR).toFixed(1);
}

/**
 * Parse a decimal-hours value into integer minutes, rounding to the nearest
 * whole minute. Lossless for values that are multiples of a tenth of an hour.
 *   1.4 -> 84, 0.1 -> 6, 2.3 -> 138
 */
export function decimalToMinutes(decimalHours: number): number {
  return Math.round(decimalHours * MINUTES_PER_HOUR);
}

/**
 * Format integer minutes as hh:mm. Hours are not zero-padded; minutes are.
 *   138 -> "2:18", 6 -> "0:06", 0 -> "0:00", 1234 -> "20:34"
 */
export function minutesToHhmm(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / MINUTES_PER_HOUR);
  const mins = total % MINUTES_PER_HOUR;
  return `${hours}:${String(mins).padStart(2, '0')}`;
}

/**
 * Parse an "h:mm" (or "hh:mm") string into integer minutes.
 * Returns NaN for malformed input.
 *   "2:18" -> 138, "0:06" -> 6, "20:34" -> 1234
 */
export function hhmmToMinutes(value: string): number {
  const match = /^(\d{1,3}):([0-5]\d)$/.exec(value.trim());
  if (!match) return NaN;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  return hours * MINUTES_PER_HOUR + mins;
}
