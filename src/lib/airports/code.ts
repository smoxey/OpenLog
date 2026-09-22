/**
 * How an aerodrome code is written, in one place.
 *
 * Its own module rather than a helper inside the lookup, because the generator
 * needs it too and the generator must not drag the CSV parser into the app
 * bundle by importing something that imports it.
 */

/** Trimmed and uppercased — the shape the logbook stores aerodromes in. */
export function normalizeAerodromeCode(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase();
}
