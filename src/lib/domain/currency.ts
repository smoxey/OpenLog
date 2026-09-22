/**
 * Passenger-carrying recency — EASA FCL.060(b)(1).
 *
 * THE RULE: a pilot may not carry passengers unless, in the preceding 90 days,
 * they have made at least 3 take-offs and landings in an aircraft of the same
 * type or class.
 *
 * THIS IS THE ONE PLACE IN THE APP WHERE BEING WRONG IS A SAFETY PROBLEM RATHER
 * THAN AN INCONVENIENCE. Telling a pilot they are current when they are not is
 * a different kind of error from a total that is off by a tenth, and every
 * decision below is made in that direction: when the data cannot answer the
 * question, this module says so rather than guessing in the pilot's favour.
 *
 * PURE. No storage, no settings, no clock — `now` is a parameter.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. No night variant, no IR recency, no
 * licence or medical expiry. Those were considered and declined; the last of
 * them is the only feature in Phase 4 that would have the app storing personal
 * identity documents.
 */
import { addDays, localIsoDate } from '../time/blockTime';
import type { DateRange } from './totals';
import type { Flight } from './flight';

/** Take-offs and landings required by FCL.060(b)(1). */
export const REQUIRED_LANDINGS = 3;

/** The look-back period, in days. */
export const CURRENCY_WINDOW_DAYS = 90;

/**
 * The kind of currency a group describes.
 *
 * `unclassified` is not a failure mode to be tidied away — it is the honest
 * answer for a record whose class cannot be read back, and it is reported so a
 * pilot can go and fix the record rather than being quietly told the wrong
 * thing about it.
 */
export type CurrencyKind = 'SE' | 'ME' | 'MP' | 'unclassified';

export interface CurrencyGroup {
  /** Stable identity: "SE", "ME", "MP:A320", or "unclassified". */
  key: string;
  kind: CurrencyKind;
  /** The type designator, for multi-pilot groups. Empty otherwise. */
  typeDesignator: string;
  /** Take-offs and landings inside the window. */
  landings: number;
  /** How many are still needed. Zero once current. */
  shortfall: number;
  current: boolean;
  /**
   * The LAST DATE this currency still holds — 90 days after the qualifying
   * landing — or `null` when the pilot is not current.
   *
   * A pilot needs this more than they need the boolean: "current" is only ever
   * true as of today, and the date is what tells them when to fly again.
   */
  currentUntil: string | null;
  /** The most recent flight in this group inside the window. */
  lastFlightDate: string | null;
  flightCount: number;
}

export interface CurrencyReport {
  /** The window every figure was computed over. */
  window: DateRange;
  /** One group per class or multi-pilot type, most landings first. */
  groups: CurrencyGroup[];
  /**
   * Entries inside the window that were skipped entirely.
   *
   * Simulator sessions and future-dated records. Counted rather than dropped
   * silently: a pilot whose figure looks low deserves to know something was set
   * aside.
   */
  skipped: { simulator: number; future: number };
}

/**
 * Take-offs are not stored; landings are. THIS IS AN ASSUMPTION, and it is the
 * first thing to revisit if a currency figure ever looks wrong.
 *
 * The rule requires three take-offs AND three landings, but a logbook records
 * only the landings. Treating the landing count as satisfying both halves is
 * the standard reading — a touch-and-go is one take-off and one landing, and a
 * flight that landed necessarily took off — and it is what every other logbook
 * does. It is stated here, and stated again in the UI, rather than being buried.
 */
function landingsOf(flight: Flight): number {
  const day = typeof flight.landingsDay === 'number' ? flight.landingsDay : 0;
  const night = typeof flight.landingsNight === 'number' ? flight.landingsNight : 0;
  if (!Number.isFinite(day) || !Number.isFinite(night)) return 0;
  return Math.max(0, day) + Math.max(0, night);
}

/**
 * Which class or type a flight counted toward, read from the flight's OWN
 * stored columns.
 *
 * Never from today's aircraft record. Derived values are stored, not recomputed
 * on read (`Claude Context/HOW_IT_WORKS.md`): correcting an aircraft's class in 2028 must not
 * change what a 2026 flight counted toward, because the flight did not change.
 * The stored SE / ME / multi-pilot columns are that historical record, already
 * resolved at the moment of entry.
 *
 * EXACTLY ONE of the three must be non-zero. A hand override can leave two
 * populated, and that is a record whose class is genuinely ambiguous — so it is
 * reported as unclassified rather than assigned to whichever branch happens to
 * be tested first.
 */
export function currencyClassOf(flight: Flight): { kind: CurrencyKind; typeDesignator: string } {
  const se = num(flight.singlePilotSeMinutes);
  const me = num(flight.singlePilotMeMinutes);
  const mp = num(flight.multiPilotMinutes);
  const populated = [se > 0, me > 0, mp > 0].filter(Boolean).length;

  if (populated !== 1) return { kind: 'unclassified', typeDesignator: '' };
  if (mp > 0) {
    // Multi-pilot recency is per TYPE, not per class: an A320 does nothing for
    // a B738. The type designator is part of the identity here.
    return { kind: 'MP', typeDesignator: String(flight.aircraftType ?? '').trim() };
  }
  return { kind: me > 0 ? 'ME' : 'SE', typeDesignator: '' };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function groupKey(kind: CurrencyKind, typeDesignator: string): string {
  if (kind === 'MP') return `MP:${typeDesignator || '—'}`;
  return kind;
}

/**
 * Passenger-carrying recency as of `now`, one figure per class and per
 * multi-pilot type.
 *
 * The window is the preceding 90 days INCLUSIVE at both ends: a landing made
 * exactly 90 days ago still counts. That matches how "within the preceding 90
 * days" is read, and the error in the other direction would tell a pilot they
 * had lost a currency they still hold.
 *
 * The opening balance is not an input and cannot be one. Brought-forward
 * landings have no dates, so there is no window they could fall inside.
 */
export function currencyReport(flights: readonly Flight[], now: Date): CurrencyReport {
  const today = localIsoDate(now);
  const window: DateRange = { from: addDays(today, -CURRENCY_WINDOW_DAYS), to: today };

  const skipped = { simulator: 0, future: 0 };
  const buckets = new Map<string, { kind: CurrencyKind; typeDesignator: string; flights: Flight[] }>();

  for (const flight of flights) {
    /*
      SIMULATOR SESSIONS COUNT TOWARD NOTHING, and this filter is explicit on
      purpose. An FSTD entry stores zero landings, so it would contribute
      nothing anyway — but an exclusion that holds only by accident is one
      refactor away from disappearing, and the roadmap asks for this one to be
      visible and tested. FSTD landings do not satisfy FCL.060(b)(1).
    */
    if (flight.entryType !== 'flight') {
      if (isInWindow(flight.date, window)) skipped.simulator += 1;
      continue;
    }

    const date = typeof flight.date === 'string' ? flight.date : '';
    // A flight dated in the future cannot confer a currency the pilot holds
    // today. Usually a typo; never a reason to report someone as current.
    if (date > today) {
      skipped.future += 1;
      continue;
    }
    if (!isInWindow(date, window)) continue;
    if (landingsOf(flight) === 0) continue;

    const { kind, typeDesignator } = currencyClassOf(flight);
    const key = groupKey(kind, typeDesignator);
    const bucket = buckets.get(key);
    if (bucket) bucket.flights.push(flight);
    else buckets.set(key, { kind, typeDesignator, flights: [flight] });
  }

  const groups: CurrencyGroup[] = [];
  for (const [key, bucket] of buckets) {
    groups.push(summarize(key, bucket.kind, bucket.typeDesignator, bucket.flights));
  }

  // Most landings first, then by key, so the same logbook always renders the
  // same way. Unclassified sinks to the bottom: it is a note, not a currency.
  groups.sort((a, b) => {
    if (a.kind === 'unclassified' && b.kind !== 'unclassified') return 1;
    if (b.kind === 'unclassified' && a.kind !== 'unclassified') return -1;
    if (b.landings !== a.landings) return b.landings - a.landings;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return { window, groups, skipped };
}

function isInWindow(date: unknown, window: DateRange): boolean {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  if (window.from !== null && date < window.from) return false;
  if (window.to !== null && date > window.to) return false;
  return true;
}

function summarize(
  key: string,
  kind: CurrencyKind,
  typeDesignator: string,
  flights: Flight[],
): CurrencyGroup {
  // Newest first: the qualifying landing is found by walking back from today.
  const ordered = [...flights].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  let landings = 0;
  let qualifyingDate: string | null = null;
  for (const flight of ordered) {
    landings += landingsOf(flight);
    if (qualifyingDate === null && landings >= REQUIRED_LANDINGS) {
      /*
        The date the THIRD-most-recent landing was made. Currency lasts 90 days
        from that landing: once it falls out of the window there are only two
        left, and the pilot is no longer current. A flight carrying several
        landings can supply the third one on its own, which is why this counts
        landings rather than flights.
      */
      qualifyingDate = flight.date;
    }
  }

  const current = landings >= REQUIRED_LANDINGS;
  return {
    key,
    kind,
    typeDesignator,
    landings,
    shortfall: Math.max(0, REQUIRED_LANDINGS - landings),
    // An unclassified record cannot confer a currency, because there is no
    // class to be current ON. It is reported so the record can be corrected.
    current: current && kind !== 'unclassified',
    currentUntil:
      current && kind !== 'unclassified' && qualifyingDate
        ? addDays(qualifyingDate, CURRENCY_WINDOW_DAYS)
        : null,
    lastFlightDate: ordered[0]?.date ?? null,
    flightCount: ordered.length,
  };
}
