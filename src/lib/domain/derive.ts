/**
 * Derivation of the single-pilot / multi-pilot time columns.
 *
 * THE GOVERNING RULE: derived, but stored.
 *
 * SE/ME time is computed from the aircraft's class *at the moment of entry* and
 * then written to the flight record like any other field. It is never
 * recomputed on read. A logbook is a historical record: correcting an
 * aircraft's class in 2028 must not silently rewrite flights logged in 2026.
 *
 * That rule applies to the fallback class just as much as to a known aircraft.
 * The caller resolves the fallback from settings and passes it in; by the time
 * a flight is written the class is concrete, so nothing downstream — export,
 * totals, edit — ever needs to know whether a value came from a known aircraft
 * or from the fallback.
 *
 * This module is PURE. It reads no settings, touches no database, and imports
 * nothing from the UI. That is what makes the rule testable.
 */
import type { Aircraft, AircraftClass } from './aircraft';
import type { Flight } from './flight';

/**
 * The fields this module owns. `totalMinutes` is filed into exactly one of
 * them, and the other two are zeroed — `singlePilotSeMinutes` and
 * `singlePilotMeMinutes` are never both non-zero.
 */
export const DERIVED_TIME_FIELDS = [
  'singlePilotSeMinutes',
  'singlePilotMeMinutes',
  'multiPilotMinutes',
] as const;

export type DerivedTimeField = (typeof DERIVED_TIME_FIELDS)[number];

/** The slice of a Flight this function reads and writes. */
export type DerivableTimes = Pick<Flight, 'totalMinutes' | DerivedTimeField>;

/**
 * The class actually used for a flight: the aircraft's if known, otherwise the
 * caller-supplied fallback. Exposed so the form can show which one is in play.
 */
export function resolveAircraftClass(
  aircraft: Aircraft | undefined,
  fallbackClass: AircraftClass,
): AircraftClass {
  return aircraft?.class ?? fallbackClass;
}

/**
 * File `totalMinutes` into exactly one of the three columns.
 *
 *  - `multiPilot: false`, class SE -> `singlePilotSeMinutes`
 *  - `multiPilot: false`, class ME -> `singlePilotMeMinutes`
 *  - `multiPilot: true`          -> `multiPilotMinutes`, both single-pilot at 0
 *
 * An unknown aircraft resolves to `fallbackClass` and is assumed single-pilot.
 *
 * `touched` lists keys the pilot has edited by hand. A touched field is never
 * overwritten — a manual override sticks. (Overriding one column by hand can
 * legitimately leave SE and ME both non-zero; that is the pilot's explicit
 * choice, and the never-both invariant applies to derivation itself.)
 *
 * Returns a new object; the input is never mutated.
 */
export function deriveAircraftTimes<T extends DerivableTimes>(
  flight: T,
  aircraft: Aircraft | undefined,
  fallbackClass: AircraftClass,
  touched: Iterable<string> = [],
): T {
  const next = { ...flight };

  const total = flight.totalMinutes;
  // Nothing sensible to file if the total isn't a real duration yet (an empty
  // or half-typed form). Leave the record alone rather than writing NaN.
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return next;

  const skip = new Set(touched);
  const multiPilot = aircraft?.multiPilot ?? false;
  const resolvedClass = resolveAircraftClass(aircraft, fallbackClass);

  const derived: Record<DerivedTimeField, number> = {
    singlePilotSeMinutes: 0,
    singlePilotMeMinutes: 0,
    multiPilotMinutes: 0,
  };
  if (multiPilot) {
    derived.multiPilotMinutes = total;
  } else if (resolvedClass === 'SE') {
    derived.singlePilotSeMinutes = total;
  } else {
    derived.singlePilotMeMinutes = total;
  }

  // Widen once here: `T` is generic, so per-key assignment needs an index
  // signature the Flight interface deliberately doesn't have.
  const writable = next as unknown as Record<string, number>;
  for (const key of DERIVED_TIME_FIELDS) {
    if (!skip.has(key)) writable[key] = derived[key];
  }
  return next;
}
