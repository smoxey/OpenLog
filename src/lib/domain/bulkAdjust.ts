/**
 * Bulk adjust time — filing a whole aircraft's flights into a time column that
 * was never recorded.
 *
 * WHY THIS EXISTS. A logbook imported from somewhere else carries only the
 * columns that logbook kept. A pilot whose old app never recorded multi-pilot
 * or multi-engine time arrives here with hundreds of airline sectors reading
 * zero in every column but Total — and the fix is not "edit 400 flights", it is
 * "all my A320 time was multi-pilot". That sentence is what this module models.
 *
 * WHAT "ADD" AND "REMOVE" MEAN. These are EASA COLUMN-FILING operations, not
 * arithmetic on an amount:
 *
 *   ADD    -> the entry's whole time goes in that column
 *             (`totalMinutes` on a flight, `simulatorMinutes` on a session)
 *   REMOVE -> that column goes to zero
 *
 * An EASA logbook asks which column a flight's time belongs in, not how many
 * hours to sprinkle into it, so a free-form "+2.5 h across 400 flights" would
 * answer a question nobody is asking and would leave component times that no
 * longer relate to the totals they sit beside. The yardstick fields themselves
 * (`totalMinutes`, `simulatorMinutes`) are therefore NOT adjustable — they are
 * what every other column is measured against, and zeroing one in bulk would
 * delete flight time rather than reclassify it.
 *
 * IT REWRITES HISTORY, SO IT NEVER GUESSES. Everything here is a PLAN: pure,
 * inspectable, and counted before anything is written. The plan reports what it
 * would change, what it would leave alone, and where the result would be
 * internally odd — and the pilot confirms. The pilot can also read the plan
 * entry by entry and untick the ones they meant to keep, which is a second
 * pure narrowing of the same plan — see `excludeFromPlan`. Nothing in this
 * file touches storage, settings or the clock.
 *
 * IT DOES NOT DERIVE. `domain/derive` files a flight's time into exactly one of
 * SE / ME / Multi-Pilot because it is answering "what kind of aircraft is
 * this". This module is answering "what does the pilot say", so it writes the
 * one column it was asked for and clears no siblings. That is deliberate:
 * filling Multi-Pilot and then Multi-Engine in two passes must not silently
 * undo the first pass. Where the result leaves two mutually exclusive columns
 * set, the plan says so as a WARNING and still lets the pilot proceed — the
 * same treatment overlapping flights and unknown registrations get.
 */
import { appliesTo, copySourceKey, ENTRY_TYPES, FIELDS } from '../registry/fields';
import type { FieldDefinition } from '../registry/types';
import { DERIVED_TIME_FIELDS } from './derive';
import { normalizeRegistration } from './aircraft';
import type { EntryType, Flight } from './flight';

/** Fill the column, or empty it. See the header for what each one writes. */
export type BulkAdjustOperation = 'add' | 'remove';

/** Whether the pilot named an aircraft TYPE or a single aircraft. */
export type BulkAdjustTarget = 'aircraftType' | 'registration';

export interface BulkAdjustSpec {
  operation: BulkAdjustOperation;
  /** Registry key of the time column being filled or cleared. */
  fieldKey: string;
  target: BulkAdjustTarget;
  /** The type designator or registration to match. Matched EXACTLY — see `matches`. */
  value: string;
  /** Inclusive ISO date bounds. Empty on both sides means the whole logbook. */
  from: string;
  to: string;
}

export const EMPTY_SPEC: BulkAdjustSpec = {
  operation: 'add',
  fieldKey: '',
  target: 'aircraftType',
  value: '',
  from: '',
  to: '',
};

/**
 * The fields every other time column is measured against.
 *
 * Read out of the registry via `copySourceKey` rather than written down here,
 * so a future entry type with a third yardstick excludes itself automatically.
 */
const YARDSTICK_KEYS: ReadonlySet<string> = new Set(ENTRY_TYPES.map(copySourceKey));

/**
 * The time columns this tool can fill or clear, in EASA column order.
 *
 * REGISTRY-DRIVEN, with no hand-maintained list: every summable duration field
 * except the yardsticks. A new EASA time column added to the registry appears
 * in the dropdown with no change here, which is the rule in `Claude Context/HOW_IT_WORKS.md`.
 *
 * Landings are excluded because they are counts, not durations — "the entry's
 * whole time goes in this column" has no meaning for a number of landings.
 */
export const ADJUSTABLE_FIELDS: readonly FieldDefinition[] = FIELDS.filter(
  (field) =>
    field.type === 'durationMinutes' &&
    field.summable &&
    field.storage === 'core' &&
    !YARDSTICK_KEYS.has(field.key),
);

/** Look up an adjustable field by key. Unknown keys are not adjustable. */
export function getAdjustableField(key: string): FieldDefinition | undefined {
  return ADJUSTABLE_FIELDS.find((field) => field.key === key);
}

/**
 * The one normalization used for matching an aircraft, either side.
 *
 * Registrations go through `normalizeRegistration` — the single definition of
 * registration identity — and type designators get the same trim-and-uppercase
 * treatment, because `a320` and `A320` are one type in every logbook that has
 * ever existed.
 */
function normalizeMatchValue(value: unknown): string {
  return normalizeRegistration(String(value ?? ''));
}

/**
 * The aircraft identifier of a record, whatever kind of entry it is.
 *
 * A flight is identified by its registration; a simulator session has no
 * registration and is identified by its device id. The same idea as the
 * importer's aircraft-identifier role: one question, answered from whichever
 * field holds it on this row.
 */
function identifierOf(flight: Flight, target: BulkAdjustTarget): string {
  if (target === 'aircraftType') return normalizeMatchValue(flight.aircraftType);
  return flight.entryType === 'fstd'
    ? normalizeMatchValue(flight.simulatorRegistration)
    : normalizeMatchValue(flight.registration);
}

/**
 * Whether this record is one the spec names.
 *
 * EXACT, not substring — and this is the deliberate difference from
 * `domain/filter`, which matches loosely because it is narrowing a list the
 * pilot is looking at. Here a loose match REWRITES records: `A32` would take
 * the A321s along with the A320s, and there is no undo to discover that with.
 */
function matches(flight: Flight, spec: BulkAdjustSpec): boolean {
  const wanted = normalizeMatchValue(spec.value);
  if (wanted === '') return false;
  return identifierOf(flight, spec.target) === wanted;
}

/** Whether a record's date falls inside the spec's (inclusive, optional) bounds. */
function inRange(flight: Flight, spec: BulkAdjustSpec): boolean {
  const from = spec.from.trim();
  const to = spec.to.trim();
  if (from === '' && to === '') return true;
  const date = typeof flight.date === 'string' ? flight.date : '';
  // A record with no usable date cannot satisfy a bound. Same rule as the list
  // filter: only excluded once a bound is actually set.
  if (from !== '' && (date === '' || date < from)) return false;
  if (to !== '' && (date === '' || date > to)) return false;
  return true;
}

/** The value a column takes for this record under this operation. */
function targetValue(flight: Flight, spec: BulkAdjustSpec): number {
  if (spec.operation === 'remove') return 0;
  const source = flight[copySourceKey(flight.entryType as EntryType)];
  return typeof source === 'number' && Number.isFinite(source) && source >= 0 ? source : 0;
}

/** The current value of the column on a record, read defensively. */
function currentValue(flight: Flight, fieldKey: string): number {
  const value = (flight as unknown as Record<string, unknown>)[fieldKey];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Apply a spec to ONE record. Returns a new record; the input is never mutated.
 *
 * Assumes the record was selected by `planBulkAdjust` — it writes the column
 * unconditionally. The entry-type invariants and the validator run in the
 * storage layer, as they do for every other write in the app.
 */
export function adjustFlight(flight: Flight, spec: BulkAdjustSpec): Flight {
  return { ...flight, [spec.fieldKey]: targetValue(flight, spec) } as Flight;
}

/** One record the plan would rewrite, with both sides of the change. */
export interface BulkAdjustChange {
  flight: Flight;
  before: number;
  after: number;
}

/**
 * A record whose result would leave two mutually exclusive columns non-zero.
 *
 * SE, ME and Multi-Pilot are the three ways of filing one flight's time, and a
 * flight is only ever one of them. This is reported rather than corrected: a
 * pilot filling Multi-Pilot on their A320s and then Multi-Engine on the same
 * flights is doing something the EASA form does not expect, but it is their
 * logbook and their claim to make.
 */
export interface ExclusivityWarning {
  flight: Flight;
  /** The other column that would still be non-zero afterwards. */
  otherKey: string;
  otherLabel: string;
}

export interface BulkAdjustPlan {
  spec: BulkAdjustSpec;
  field: FieldDefinition | undefined;
  /** Every entry the spec names — matched aircraft, inside the dates, column applies. */
  matched: readonly Flight[];
  /** Of those, the ones whose value actually moves. */
  changes: readonly BulkAdjustChange[];
  /** Matched entries already holding the wanted value, so nothing is written. */
  unchangedCount: number;
  /** Of the entries that would change, the ones the pilot has unticked. */
  excludedCount: number;
  /** Split of `changes` by kind of entry, for a sentence that says which. */
  changedFlightCount: number;
  changedFstdCount: number;
  /** Minutes in the column across `changes`, before and after. */
  minutesBefore: number;
  minutesAfter: number;
  exclusivityWarnings: readonly ExclusivityWarning[];
  /** Why this plan cannot be run yet. Absent when it can. */
  problem?: string;
}

/**
 * Work out exactly what a spec would do, without doing any of it.
 *
 * Selection is three conditions, all of which must hold: the aircraft matches
 * exactly, the date is inside the bounds, and the column APPLIES to that kind
 * of entry. The third is what keeps a multi-pilot fill from touching simulator
 * sessions, which have no such column — `applyEntryTypeInvariants` would zero
 * it again on write, so writing it would be a lie told twice.
 */
export function planBulkAdjust(
  flights: readonly Flight[],
  spec: BulkAdjustSpec,
): BulkAdjustPlan {
  const field = getAdjustableField(spec.fieldKey);

  const empty: BulkAdjustPlan = {
    spec,
    field,
    matched: [],
    changes: [],
    unchangedCount: 0,
    excludedCount: 0,
    changedFlightCount: 0,
    changedFstdCount: 0,
    minutesBefore: 0,
    minutesAfter: 0,
    exclusivityWarnings: [],
  };

  if (spec.fieldKey.trim() === '') {
    return { ...empty, problem: 'Choose a time column to adjust.' };
  }
  if (field === undefined) {
    return { ...empty, problem: `"${spec.fieldKey}" is not a time column this tool can adjust.` };
  }
  if (normalizeMatchValue(spec.value) === '') {
    return {
      ...empty,
      problem:
        spec.target === 'aircraftType'
          ? 'Enter an aircraft type.'
          : 'Enter an aircraft registration.',
    };
  }
  const from = spec.from.trim();
  const to = spec.to.trim();
  if (from !== '' && to !== '' && from > to) {
    return { ...empty, problem: 'The date range ends before it starts.' };
  }

  const matched = flights.filter(
    (flight) =>
      matches(flight, spec) &&
      inRange(flight, spec) &&
      appliesTo(field, flight.entryType as EntryType),
  );

  const changes: BulkAdjustChange[] = [];
  const exclusivityWarnings: ExclusivityWarning[] = [];
  let changedFlightCount = 0;
  let changedFstdCount = 0;
  let minutesBefore = 0;
  let minutesAfter = 0;

  for (const flight of matched) {
    const before = currentValue(flight, spec.fieldKey);
    const after = targetValue(flight, spec);
    if (before === after) continue;

    changes.push({ flight, before, after });
    if (flight.entryType === 'fstd') changedFstdCount += 1;
    else changedFlightCount += 1;
    minutesBefore += before;
    minutesAfter += after;

    // Only a fill can create a clash; emptying a column can only resolve one.
    if (after > 0 && (DERIVED_TIME_FIELDS as readonly string[]).includes(spec.fieldKey)) {
      for (const other of DERIVED_TIME_FIELDS) {
        if (other === spec.fieldKey) continue;
        if (currentValue(flight, other) === 0) continue;
        exclusivityWarnings.push({
          flight,
          otherKey: other,
          otherLabel: FIELDS.find((f) => f.key === other)?.label ?? other,
        });
      }
    }
  }

  const plan: BulkAdjustPlan = {
    spec,
    field,
    matched,
    changes,
    unchangedCount: matched.length - changes.length,
    excludedCount: 0,
    changedFlightCount,
    changedFstdCount,
    minutesBefore,
    minutesAfter,
    exclusivityWarnings,
  };

  if (matched.length === 0) {
    return { ...plan, problem: 'Nothing in the logbook matches that.' };
  }
  if (changes.length === 0) {
    const noun = matched.length === 1 ? 'entry' : 'entries';
    return {
      ...plan,
      problem: `All ${matched.length} matching ${noun} already read that way — nothing to change.`,
    };
  }
  return plan;
}

/**
 * The same plan with some of its entries left alone.
 *
 * The review list lets a pilot untick a row — "all my A320 time was
 * multi-pilot, except the two line checks I flew as an observer" — and this is
 * where that decision lands. It is a second pure step rather than another
 * argument to `planBulkAdjust` on purpose: the review list has to go on showing
 * every entry the sentence selected, including the unticked ones, or a row
 * would vanish the moment it was unticked and there would be no way to tick it
 * back.
 *
 * Everything the screen and the write read off `changes` therefore narrows —
 * the count, the minutes, the split by kind of entry, the clash warnings. What
 * does NOT narrow is `matched` and `unchangedCount`: those describe the
 * logbook, not the ticks. Unticking every entry is a `problem`, in exactly the
 * same way matching nothing is — the plan reports it, and the screen has one
 * rule to disable Apply by.
 *
 * Unknown ids are ignored rather than an error, so a set left over from a
 * sentence the pilot has since edited cannot silently drop a record.
 */
export function excludeFromPlan(
  plan: BulkAdjustPlan,
  excludedIds: ReadonlySet<string>,
): BulkAdjustPlan {
  if (plan.problem !== undefined || excludedIds.size === 0) return plan;

  const changes = plan.changes.filter((change) => !excludedIds.has(change.flight.id));
  const excludedCount = plan.changes.length - changes.length;
  if (excludedCount === 0) return plan;

  let changedFlightCount = 0;
  let changedFstdCount = 0;
  let minutesBefore = 0;
  let minutesAfter = 0;
  for (const change of changes) {
    if (change.flight.entryType === 'fstd') changedFstdCount += 1;
    else changedFlightCount += 1;
    minutesBefore += change.before;
    minutesAfter += change.after;
  }

  const narrowed: BulkAdjustPlan = {
    ...plan,
    changes,
    excludedCount,
    changedFlightCount,
    changedFstdCount,
    minutesBefore,
    minutesAfter,
    exclusivityWarnings: plan.exclusivityWarnings.filter(
      (warning) => !excludedIds.has(warning.flight.id),
    ),
  };

  if (changes.length === 0) {
    return { ...narrowed, problem: 'Every entry is unticked — nothing left to change.' };
  }
  return narrowed;
}

/** The records a plan would write, already adjusted. Empty for an unrunnable plan. */
export function planResults(plan: BulkAdjustPlan): Flight[] {
  if (plan.problem !== undefined) return [];
  return plan.changes.map((change) => adjustFlight(change.flight, plan.spec));
}

/**
 * Every distinct value of `target` present in the logbook, sorted.
 *
 * Offered to the pilot as a list to pick from rather than a box to type into:
 * this tool matches exactly, so a typo would otherwise read as "nothing
 * matched" and leave them wondering which of the two is wrong.
 */
export function knownValues(flights: readonly Flight[], target: BulkAdjustTarget): string[] {
  const seen = new Set<string>();
  for (const flight of flights) {
    const value = identifierOf(flight, target);
    if (value !== '') seen.add(value);
  }
  return [...seen].sort();
}
