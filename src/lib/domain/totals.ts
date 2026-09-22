/**
 * The totals engine.
 *
 * PURE: flights in, totals out. No storage, no settings, no DOM — and no clock.
 * `now` is always a parameter, which is what makes "the last 90 days" testable
 * without freezing time.
 *
 * REGISTRY-DRIVEN. Every figure here is produced by iterating `SUMMABLE_FIELDS`.
 * Nothing in this module names a duration or landing column, and adding one to
 * the registry adds it to every total below with no edit here.
 *
 * WHY SIMULATOR TIME NEEDS NO FILTER. `simulatorMinutes` is `summable: false`,
 * so no registry-driven sum can reach it; and an FSTD entry stores
 * `totalMinutes: 0` with every flight-time column at zero, so it contributes
 * nothing to a flight total by construction. That is the entry-type design
 * working as intended, and it is why you will not find an `entryType` check in
 * the summing code. Simulator time is reported separately, by
 * `simulatorTotals`, which is the one function here that names a field on
 * purpose — because it is reporting the exception, not the rule.
 */
import { SUMMABLE_FIELDS } from '../registry/fields';
import type { FieldDefinition } from '../registry/types';
import { addDays, localIsoDate } from '../time/blockTime';
import { normalizeRegistration } from './aircraft';
import type { Flight } from './flight';

/** A set of totals keyed by registry field key, in minutes or in counts. */
export type TotalsSet = Record<string, number>;

/** The ranges the totals view offers. */
export type RangeKey = 'last28' | 'last90' | 'calendarYear' | 'allTime';

export const RANGE_KEYS: readonly RangeKey[] = [
  'last28',
  'last90',
  'calendarYear',
  'allTime',
];

export const RANGE_LABELS: Readonly<Record<RangeKey, string>> = {
  last28: 'Last 28 days',
  last90: 'Last 90 days',
  calendarYear: 'This year',
  allTime: 'All time',
};

/**
 * An inclusive window of plain calendar dates. `null` means unbounded.
 *
 * Both ends are ISO "YYYY-MM-DD" strings and are compared as STRINGS. ISO dates
 * sort lexically in calendar order, so this needs no date objects at all —
 * which matters, because a `Date` would drag a timezone into a record that
 * deliberately has none.
 */
export interface DateRange {
  from: string | null;
  to: string | null;
}

/** Simulator time, reported on its own and never mixed into a flight total. */
export interface SimulatorTotals {
  /** Total session time in minutes. */
  sessionMinutes: number;
  /** How many simulator sessions produced it. */
  sessionCount: number;
}

export interface LogbookTotals {
  range: RangeKey;
  /** The window actually used, so a caller can display or re-check it. */
  window: DateRange;
  /** Flight entries counted — simulator sessions are not among them. */
  flightCount: number;
  totals: TotalsSet;
  simulator: SimulatorTotals;
}

/** One row of a by-type or by-registration breakdown. */
export interface GroupTotals {
  /** The grouping value, normalized. Empty string for records that lack one. */
  key: string;
  flightCount: number;
  totals: TotalsSet;
}

/** Which field a breakdown groups by. */
export type GroupBy = 'aircraftType' | 'registration';

/**
 * The window for a range, as of `now`.
 *
 * THE BOUNDARY IS INCLUSIVE AT BOTH ENDS, and the day-count windows reach back
 * N whole days from today: a flight exactly 28 days ago is inside the 28-day
 * window and one 29 days ago is not. That matches how aviation recency is
 * written and read — "within the preceding 90 days" counts the flight made on
 * day 90 — and getting it wrong by one day in the other direction would tell a
 * pilot they had lost a currency they still hold.
 *
 * `now` is a real `Date` and its LOCAL calendar date is what "today" means. See
 * `localIsoDate` for why local rather than UTC.
 */
export function rangeWindow(range: RangeKey, now: Date): DateRange {
  const today = localIsoDate(now);
  switch (range) {
    case 'last28':
      return { from: addDays(today, -28), to: today };
    case 'last90':
      return { from: addDays(today, -90), to: today };
    case 'calendarYear':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'allTime':
    default:
      return { from: null, to: null };
  }
}

/**
 * Whether a record's date falls inside a window.
 *
 * A malformed or missing date is OUTSIDE every bounded window but inside the
 * unbounded one — so a damaged record still shows up in the all-time total,
 * where its absence would be a silent loss, rather than being quietly dropped
 * from every figure the app displays.
 */
export function isInRange(date: unknown, window: DateRange): boolean {
  if (window.from === null && window.to === null) return true;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  if (window.from !== null && date < window.from) return false;
  if (window.to !== null && date > window.to) return false;
  return true;
}

/** Read a summable field off a record, honouring core vs `extra` storage. */
function readNumber(flight: Flight, field: FieldDefinition): number {
  const raw =
    field.storage === 'extra'
      ? flight.extra?.[field.key]
      : (flight as unknown as Record<string, unknown>)[field.key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/** A totals set with every summable field at zero. */
export function emptyTotals(): TotalsSet {
  const totals: TotalsSet = {};
  for (const field of SUMMABLE_FIELDS) totals[field.key] = 0;
  return totals;
}

/**
 * Sum every summable field across a set of records.
 *
 * Takes whatever it is given: the CALLER decides which records belong in a
 * figure. That is deliberate — a filter buried in here would be invisible to
 * the caller and impossible to test independently.
 */
export function sumTotals(flights: readonly Flight[]): TotalsSet {
  const totals = emptyTotals();
  for (const flight of flights) {
    for (const field of SUMMABLE_FIELDS) {
      totals[field.key] += readNumber(flight, field);
    }
  }
  return totals;
}

/**
 * Simulator session time, on its own.
 *
 * The one function here that names a field, because it reports the exception
 * the rest of the module is built to exclude. Reading `simulatorMinutes` from
 * every record regardless of `entryType` would be wrong in principle and right
 * by accident — a flight always stores zero there — so the entry type is
 * checked explicitly and the count means what it says.
 */
export function simulatorTotals(flights: readonly Flight[]): SimulatorTotals {
  let sessionMinutes = 0;
  let sessionCount = 0;
  for (const flight of flights) {
    if (flight.entryType !== 'fstd') continue;
    sessionCount += 1;
    const value = flight.simulatorMinutes;
    if (typeof value === 'number' && Number.isFinite(value)) sessionMinutes += value;
  }
  return { sessionMinutes, sessionCount };
}

/**
 * Every figure for one range: the summable set, the flight count, and the
 * simulator figure alongside it.
 *
 * The opening balance is NOT applied here and this module knows nothing about
 * it. See `applyOpeningBalance` — a brought-forward figure has no date, so it
 * can only ever belong to the all-time total, and keeping it out of the engine
 * is what stops it leaking into a range or a grouping.
 */
export function computeTotals(
  flights: readonly Flight[],
  range: RangeKey,
  now: Date,
): LogbookTotals {
  const window = rangeWindow(range, now);
  const inWindow = flights.filter((f) => isInRange(f.date, window));
  return {
    range,
    window,
    flightCount: inWindow.filter((f) => f.entryType !== 'fstd').length,
    totals: sumTotals(inWindow),
    simulator: simulatorTotals(inWindow),
  };
}

/** The grouping value for a record, normalized. */
function groupKeyOf(flight: Flight, groupBy: GroupBy): string {
  if (groupBy === 'registration') {
    // Through the one function that decides registration identity, so `ln-abc`
    // and `LN-ABC` are one aircraft here exactly as they are in the store.
    return normalizeRegistration(String(flight.registration ?? ''));
  }
  return String(flight.aircraftType ?? '').trim();
}

/**
 * Break a set of records down by type or by registration.
 *
 * SIMULATOR SESSIONS ARE NOT GROUPED. A session has no registration and its
 * "type" is a device, so putting it in a by-aircraft breakdown would invent an
 * aircraft that does not exist. It is reported by `simulatorTotals` instead.
 *
 * Ordered by total flight time descending, then by key ascending, so equal
 * totals still render in the same order every time.
 */
export function groupTotals(
  flights: readonly Flight[],
  groupBy: GroupBy,
): GroupTotals[] {
  const buckets = new Map<string, Flight[]>();
  for (const flight of flights) {
    if (flight.entryType === 'fstd') continue;
    const key = groupKeyOf(flight, groupBy);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(flight);
    else buckets.set(key, [flight]);
  }

  const rows: GroupTotals[] = [];
  for (const [key, bucket] of buckets) {
    rows.push({ key, flightCount: bucket.length, totals: sumTotals(bucket) });
  }

  rows.sort((a, b) => {
    const byTime = (b.totals.totalMinutes ?? 0) - (a.totals.totalMinutes ?? 0);
    if (byTime !== 0) return byTime;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return rows;
}
