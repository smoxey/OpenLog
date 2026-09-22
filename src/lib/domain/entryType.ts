/**
 * The entry-type invariants, in one place.
 *
 * THE GOVERNING RULE (`Claude Context/HOW_IT_WORKS.md`): simulator time is never flight
 * time. This module is where that stops being a principle and becomes
 * something a record physically cannot violate:
 *
 *   entryType === 'flight' -> simulatorMinutes === 0, simulatorRegistration === ''
 *   entryType === 'fstd'   -> totalMinutes === 0, aerodromes === 'SIM',
 *                             registration === ''
 *
 * It lives in the domain layer rather than inside the storage writer because it
 * has TWO callers that must not disagree: `storage/index` applies it to every
 * hand-entered flight, and `import/transform` applies it to every imported row.
 * Import cannot reach into storage for it — that module imports Dexie, and the
 * importer is pure by design — so a shared definition here is the only way both
 * paths enforce the same rule. This is the same argument that put
 * `findConflicts` in the domain layer: one rule, one definition, two callers.
 *
 * PURE: no storage, no settings, no clock.
 */
import { appliesTo, FIELDS } from '../registry/fields';
import { SIMULATOR_AERODROME, type EntryType, type Flight } from './flight';

/** The record shape this operates on: a complete flight minus its identity. */
export type EntryTypeInvariantInput = Omit<Flight, 'id' | 'schemaVersion'>;

/**
 * Force the fields an entry type owns, so a caller that forgets one cannot
 * violate the invariants.
 *
 * Every core field that does not apply to this entry type is reset to empty,
 * DRIVEN BY THE REGISTRY rather than a hand-maintained list. That is what stops
 * (say) three landings riding along on a simulator session and being summed
 * into a flight total — a hole a hardcoded list would have to remember to close
 * again for every new field.
 *
 * Returns a new object; the input is never mutated.
 */
export function applyEntryTypeInvariants<T extends EntryTypeInvariantInput>(record: T): T {
  const entryType: EntryType = record.entryType ?? 'flight';
  const next = { ...record } as unknown as Record<string, unknown>;

  for (const field of FIELDS) {
    if (field.storage !== 'core') continue;
    if (appliesTo(field, entryType)) continue;
    next[field.key] = field.type === 'durationMinutes' || field.type === 'count' ? 0 : '';
  }

  // The fields this entry type owns outright rather than merely allowing.
  if (entryType === 'fstd') {
    next.depAerodrome = SIMULATOR_AERODROME;
    next.arrAerodrome = SIMULATOR_AERODROME;
    // Not derived from anything: an FSTD entry's flight time IS zero, and this
    // is what makes every existing total exclude simulator time untouched.
    next.totalMinutes = 0;
  }

  return next as unknown as T;
}
