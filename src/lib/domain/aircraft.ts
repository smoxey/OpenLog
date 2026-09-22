/**
 * The minimal aircraft record — the Phase 2b slice of Phase 5's aircraft
 * profiles.
 *
 * Deliberately small: registration, type, class, multi-pilot flag. Make/model,
 * variant and type-rating detail stay in Phase 5. This exists for one reason —
 * to let the entry form derive SE/ME/multi-pilot time without asking the pilot
 * twice.
 *
 * NOTE: an aircraft record describes the aircraft *now*. It is never a source
 * of truth for a flight already written: derived times are stored on the flight
 * at entry, so correcting a class here leaves historical records alone.
 */

export type AircraftClass = 'SE' | 'ME';

export interface Aircraft {
  /** Normalized registration — the primary key. See `normalizeRegistration`. */
  registration: string;
  /** Aircraft type designator, e.g. "C172". */
  type: string;
  /** Single-engine or multi-engine. */
  class: AircraftClass;
  /** True for aircraft certified for multi-pilot operation. */
  multiPilot: boolean;
}

/**
 * The canonical lookup key for a registration: trimmed and uppercased.
 *
 * This is the ONE place that decides registration identity. Both the aircraft
 * store and the entry form call it, so `ln-abc`, `LN-ABC ` and `LN-ABC` can
 * never become three separate aircraft.
 *
 * Punctuation is preserved on purpose — `LN-ABC` and `LNABC` are different
 * strings in a logbook and merging them is a Phase 5 decision, not a silent one.
 */
export function normalizeRegistration(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * The canonical form of an aircraft record, ready to be written.
 *
 * One definition with several callers — `upsertAircraft` writes one at a time
 * from the entry form, and the CSV importer writes a whole fileful inside its
 * transaction. Both must produce byte-identical records for the same input, or
 * confirming an aircraft during an import would create a second, subtly
 * different copy of one the entry form had already stored.
 *
 * Anything that is not the literal `"ME"` files as `"SE"`, and `multiPilot` is
 * true only for the literal `true` — deliberately strict, because these arrive
 * from files and forms rather than from code.
 */
export function normalizeAircraft(input: Partial<Aircraft>): Aircraft {
  return {
    registration: normalizeRegistration(input.registration ?? ''),
    type: (input.type ?? '').trim(),
    class: input.class === 'ME' ? 'ME' : 'SE',
    multiPilot: input.multiPilot === true,
  };
}
