/**
 * Deterministic ordering for exports.
 *
 * Two exports of the same unchanged database must be byte-identical, or the
 * round-trip fixture test becomes flaky and stops meaning anything. Neither
 * IndexedDB iteration order nor JS object key order is something to rely on, so
 * every list and every object is explicitly ordered here.
 *
 * Pure: no storage, no settings, no clock.
 */
import { FIELDS } from '../registry/fields';
import type { Flight } from '../domain/flight';
import type { Aircraft } from '../domain/aircraft';

/** Registry core keys, in registry (EASA column) order. */
const REGISTRY_CORE_KEYS: readonly string[] = FIELDS.filter((f) => f.storage === 'core').map(
  (f) => f.key,
);

/** Keys placed by hand rather than by the registry. */
const IDENTITY_KEYS = ['id', 'schemaVersion'] as const;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Flights sorted by date, then id — stable regardless of insertion order. */
export function sortFlights(flights: readonly Flight[]): Flight[] {
  return [...flights].sort(
    (a, b) => compareStrings(a.date, b.date) || compareStrings(a.id, b.id),
  );
}

/** Aircraft sorted by their normalized registration key. */
export function sortAircraft(aircraft: readonly Aircraft[]): Aircraft[] {
  return [...aircraft].sort((a, b) => compareStrings(a.registration, b.registration));
}

/**
 * Recursively order object keys alphabetically. Arrays keep their order —
 * position is data in an array, not incidental.
 *
 * Caveat worth knowing: JS emits integer-like string keys ("0", "1") before
 * other keys regardless of insertion order, so an `extra` object keyed by
 * numeric strings orders by that rule instead. Still deterministic — the same
 * input always produces the same output — which is all byte-identity needs.
 */
export function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareStrings)) out[key] = sortDeep(source[key]);
    return out;
  }
  return value;
}

/**
 * Rebuild a flight with keys in emission order: identity, then registry order,
 * then anything else alphabetically, then `extra` last.
 *
 * `extra` goes last so a human opening the file reads the EASA columns first and
 * the open-ended bag afterwards. Nothing is dropped: an unexpected core key
 * still gets emitted (alphabetically) rather than silently disappearing.
 */
export function orderFlight(flight: Flight): Record<string, unknown> {
  const source = flight as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const placed = new Set<string>(['extra']);

  for (const key of IDENTITY_KEYS) {
    out[key] = source[key];
    placed.add(key);
  }
  for (const key of REGISTRY_CORE_KEYS) {
    out[key] = source[key];
    placed.add(key);
  }
  for (const key of Object.keys(source).sort(compareStrings)) {
    if (!placed.has(key)) out[key] = source[key];
  }

  out.extra = sortDeep(flight.extra ?? {});
  return out;
}

/** Aircraft key order, fixed by hand — the table has no registry. */
export function orderAircraft(aircraft: Aircraft): Record<string, unknown> {
  return {
    registration: aircraft.registration,
    type: aircraft.type,
    class: aircraft.class,
    multiPilot: aircraft.multiPilot,
  };
}
