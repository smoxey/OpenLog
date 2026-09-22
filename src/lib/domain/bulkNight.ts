/**
 * Bulk night time — working out night for flights already written down.
 *
 * WHY THIS EXISTS. Phase 5 taught the entry form to work night time out from
 * the route and the clock, but it deliberately left the logbook that was
 * already there alone: a pilot arriving with hundreds of imported sectors got the new
 * behaviour on their next flight and nothing at all on the ones behind it. Some of
 * those carry a night figure from whatever tool wrote them, some carry none,
 * and the pilot has no way to see which. This module answers "work it out for
 * the flights I have already logged" — and, just as importantly, lets the
 * pilot say no to any of them one at a time.
 *
 * IT IS THE SAME CALCULATION THE FORM USES. `suggestNightForEntry` is called
 * here exactly as `FlightForm` calls it, with the same aerodrome lookup passed
 * in the same way. There is no second definition of night in this codebase and
 * there must never be one: a bulk tool that disagreed with the form would make
 * the logbook depend on which screen a flight happened to be entered from.
 *
 * IT REWRITES HISTORY, SO IT NEVER GUESSES. Everything here is a PLAN — pure,
 * inspectable, counted before anything is written — in the same shape
 * `domain/bulkAdjust` uses, because it is the same promise to the pilot. What
 * it cannot work out it SKIPS AND REPORTS: an aerodrome missing from the list,
 * a sector with no block times, a simulator session that has no sun. A silent
 * drop is the failure mode this project has been bitten by twice, and a night
 * figure quietly not written is indistinguishable from one written as zero.
 *
 * WHAT IT DOES NOT TOUCH. The landing columns. The entry form moves a landing
 * into the night column on a night arrival, and this tool deliberately does
 * not: that is a second claim about the flight, it is not what the pilot asked
 * for when they asked for night time, and unlike the night figure it cannot be
 * checked against anything on the screen afterwards. Night minutes only, said
 * plainly in the panel.
 */
import type { Airport } from '../airports/types';
import { suggestNightForEntry } from '../night/suggest';
import type { EntryType, Flight } from './flight';

/**
 * Which flights the tool offers to change.
 *
 * `missing` is the safe one and the default: it only ever fills a blank, so
 * nothing the pilot (or their old logbook) actually recorded is overwritten.
 * `all` also offers the flights that already carry a night figure — which is
 * the interesting case, because that is where OpenLog and the old tool
 * disagree, and it is exactly the disagreement the pilot may want to inspect
 * row by row before accepting any of it.
 */
export type BulkNightScope = 'missing' | 'all';

export interface BulkNightSpec {
  scope: BulkNightScope;
  /** Inclusive ISO date bounds. Empty on both sides means the whole logbook. */
  from: string;
  to: string;
}

export const EMPTY_NIGHT_SPEC: BulkNightSpec = {
  scope: 'missing',
  from: '',
  to: '',
};

/** One flight the plan would rewrite, with both sides of the change. */
export interface BulkNightChange {
  flight: Flight;
  /** The night figure currently on the record. */
  before: number;
  /** What the route and the clock say it should be. */
  after: number;
  /** The calculation puts the landing in the night column. Reported, never applied. */
  arrivalIsNight: boolean;
  /** The sun tracked close to −6°, so a minute either way is a real judgement call. */
  grazing: boolean;
}

/** Why a flight could not be worked out. Reported, never silently dropped. */
export type BulkNightSkipReason = 'unknownAerodrome' | 'incomplete' | 'simulator';

export interface BulkNightSkip {
  flight: Flight;
  reason: BulkNightSkipReason;
  /** Aerodrome codes that were not in the list. Empty for the other reasons. */
  missing: readonly string[];
}

export interface BulkNightPlan {
  spec: BulkNightSpec;
  /** Every entry inside the date bounds that the scope selects. */
  matched: readonly Flight[];
  /** Of those, the ones whose night figure actually moves. */
  changes: readonly BulkNightChange[];
  /** Entries the calculation could not speak for, with the reason. */
  skipped: readonly BulkNightSkip[];
  /** Matched entries whose night already reads what the calculation says. */
  unchangedCount: number;
  /** Of the entries that would change, the ones the pilot has unticked. */
  excludedCount: number;
  /** Night minutes across `changes`, before and after. */
  minutesBefore: number;
  minutesAfter: number;
  /** Changes whose sun sat close to the threshold — worth a second look. */
  grazingCount: number;
  /** Changes that would overwrite a night figure that was already there. */
  overwriteCount: number;
  /** Distinct aerodrome codes missing from the list, most frequent first. */
  missingAerodromes: readonly string[];
  /** Why this plan cannot be run yet. Absent when it can. */
  problem?: string;
}

/** Whether a record's date falls inside the spec's (inclusive, optional) bounds. */
function inRange(flight: Flight, spec: BulkNightSpec): boolean {
  const from = spec.from.trim();
  const to = spec.to.trim();
  if (from === '' && to === '') return true;
  const date = typeof flight.date === 'string' ? flight.date : '';
  // A record with no usable date cannot satisfy a bound — the same rule the
  // list filter and `domain/bulkAdjust` both use.
  if (from !== '' && (date === '' || date < from)) return false;
  if (to !== '' && (date === '' || date > to)) return false;
  return true;
}

/** The night figure on a record, read defensively. */
function currentNight(flight: Flight): number {
  const value = (flight as unknown as Record<string, unknown>).nightMinutes;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Apply the calculation to ONE record. Returns a new record; never mutates.
 *
 * Only `nightMinutes` moves. See the header for why the landing columns do not.
 */
export function applyNightToFlight(flight: Flight, minutes: number): Flight {
  return { ...flight, nightMinutes: minutes };
}

/**
 * Work out what the tool would do, without doing any of it.
 *
 * The lookup is passed in rather than imported, exactly as `suggestNightForEntry`
 * takes it: that is what lets this be unit-tested against a handful of
 * aerodromes instead of against the shipped 39,243, and it is the same shape
 * `findConflicts` uses where the caller supplies the set to compare against.
 */
export function planBulkNight(
  flights: readonly Flight[],
  spec: BulkNightSpec,
  lookup: (code: string) => Airport | undefined,
): BulkNightPlan {
  const empty: BulkNightPlan = {
    spec,
    matched: [],
    changes: [],
    skipped: [],
    unchangedCount: 0,
    excludedCount: 0,
    minutesBefore: 0,
    minutesAfter: 0,
    grazingCount: 0,
    overwriteCount: 0,
    missingAerodromes: [],
  };

  const from = spec.from.trim();
  const to = spec.to.trim();
  if (from !== '' && to !== '' && from > to) {
    return { ...empty, problem: 'The date range ends before it starts.' };
  }

  // A simulator session has no sun and no night column, so it is never even a
  // candidate — it is not "skipped", it was never in scope. Only flights whose
  // scope and dates select them reach the calculation.
  const matched = flights.filter(
    (flight) =>
      flight.entryType !== 'fstd' &&
      inRange(flight, spec) &&
      (spec.scope === 'all' || currentNight(flight) === 0),
  );

  const changes: BulkNightChange[] = [];
  const skipped: BulkNightSkip[] = [];
  const missingCounts = new Map<string, number>();
  let unchangedCount = 0;
  let minutesBefore = 0;
  let minutesAfter = 0;
  let grazingCount = 0;
  let overwriteCount = 0;

  for (const flight of matched) {
    const suggestion = suggestNightForEntry(
      {
        entryType: (flight.entryType ?? 'flight') as EntryType,
        date: String(flight.date ?? ''),
        offBlock: String(flight.offBlock ?? ''),
        onBlock: String(flight.onBlock ?? ''),
        depAerodrome: String(flight.depAerodrome ?? ''),
        arrAerodrome: String(flight.arrAerodrome ?? ''),
        totalMinutes: Number(flight.totalMinutes) || 0,
      },
      lookup,
    );

    if (suggestion.status === 'unknownAerodrome') {
      for (const code of suggestion.missing) {
        missingCounts.set(code, (missingCounts.get(code) ?? 0) + 1);
      }
      skipped.push({ flight, reason: 'unknownAerodrome', missing: suggestion.missing });
      continue;
    }
    if (suggestion.status !== 'ready') {
      // `incomplete` covers a missing date, a missing block time, or an
      // aerodrome too short to be a code at all. `notApplicable` cannot reach
      // here — simulators were filtered out above — but it is a reason to skip
      // rather than a reason to write zero, so it is folded in with the rest.
      skipped.push({
        flight,
        reason: suggestion.status === 'notApplicable' ? 'simulator' : 'incomplete',
        missing: [],
      });
      continue;
    }

    const before = currentNight(flight);
    const after = suggestion.nightMinutes;
    if (before === after) {
      unchangedCount += 1;
      continue;
    }

    changes.push({
      flight,
      before,
      after,
      arrivalIsNight: suggestion.arrivalIsNight,
      grazing: suggestion.grazing,
    });
    minutesBefore += before;
    minutesAfter += after;
    if (suggestion.grazing) grazingCount += 1;
    if (before > 0) overwriteCount += 1;
  }

  const missingAerodromes = [...missingCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([code]) => code);

  const plan: BulkNightPlan = {
    ...empty,
    matched,
    changes,
    skipped,
    unchangedCount,
    minutesBefore,
    minutesAfter,
    grazingCount,
    overwriteCount,
    missingAerodromes,
  };

  if (matched.length === 0) {
    return {
      ...plan,
      problem:
        spec.scope === 'missing'
          ? 'Every flight in range already has a night figure. Switch to "All flights" to compare them against the calculation.'
          : 'No flights in range.',
    };
  }
  if (changes.length === 0) {
    const noun = skipped.length === 1 ? 'flight' : 'flights';
    return {
      ...plan,
      problem:
        skipped.length === matched.length
          ? `Night could not be worked out for ${skipped.length} ${noun} in range — see below.`
          : 'Every flight that could be worked out already reads that way — nothing to change.',
    };
  }
  return plan;
}

/**
 * The same plan with some of its flights left alone.
 *
 * This is where "keep what I logged" lands. The review list goes on showing
 * every flight the scope selected, including the unticked ones — a row that
 * vanished when it was unticked could never be ticked back — so the narrowing
 * happens here rather than inside `planBulkNight`.
 *
 * `changes` narrows and everything counted off it narrows with it. `matched`,
 * `skipped` and `unchangedCount` do NOT: those describe the logbook, not the
 * ticks. Unticking everything is a `problem`, so the panel has one rule to
 * disable Apply by — the same contract `excludeFromPlan` keeps for the other
 * bulk tool.
 */
export function excludeFromNightPlan(
  plan: BulkNightPlan,
  excludedIds: ReadonlySet<string>,
): BulkNightPlan {
  if (plan.problem !== undefined || excludedIds.size === 0) return plan;

  const changes = plan.changes.filter((change) => !excludedIds.has(change.flight.id));
  const excludedCount = plan.changes.length - changes.length;
  if (excludedCount === 0) return plan;

  let minutesBefore = 0;
  let minutesAfter = 0;
  let grazingCount = 0;
  let overwriteCount = 0;
  for (const change of changes) {
    minutesBefore += change.before;
    minutesAfter += change.after;
    if (change.grazing) grazingCount += 1;
    if (change.before > 0) overwriteCount += 1;
  }

  const narrowed: BulkNightPlan = {
    ...plan,
    changes,
    excludedCount,
    minutesBefore,
    minutesAfter,
    grazingCount,
    overwriteCount,
  };

  if (changes.length === 0) {
    return { ...narrowed, problem: 'Every flight is unticked — nothing left to change.' };
  }
  return narrowed;
}

/** The records a plan would write, already updated. Empty for an unrunnable plan. */
export function nightPlanResults(plan: BulkNightPlan): Flight[] {
  if (plan.problem !== undefined) return [];
  return plan.changes.map((change) => applyNightToFlight(change.flight, change.after));
}
