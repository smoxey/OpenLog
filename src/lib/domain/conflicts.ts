/**
 * Conflict detection.
 *
 * THE GOVERNING RULE: a pilot cannot be in two places at once. Two entries
 * whose block times intersect cannot both be true, so at least one of them is
 * wrong.
 *
 * This is a DATA-INTEGRITY check, not a duplicate check. It fires on entries
 * that are obviously different from each other — different route, different
 * aircraft, different everything — but that describe overlapping time. Run
 * against a real logbook the rule found three genuine errors, including
 * a turnaround whose return leg departed before the outbound landed.
 *
 * ONE FUNCTION, TWO CALLERS: the entry form (a soft warning that never blocks a
 * save) and the importer (a pause the user confirms once for the whole file).
 * If those two ever disagreed about what a conflict is, the feature would be
 * worthless — so the definition lives here, in the domain layer, and both
 * callers ask this function.
 *
 * This module is PURE. No storage, no settings, no clock, no UI imports. The
 * caller supplies the set to compare against; that is what makes the rule
 * testable and what keeps the form from re-reading the database on a keystroke.
 *
 * KNOWN CAVEAT: imported block times are not dependably true UTC — a conflict involving a timezone-crossing sector
 * may be an hour out. The app reports a conflict; it never silently corrects
 * one.
 */
import { elapsedMinutes, isoDateToDayNumber, timeOfDayToMinutes } from '../time/blockTime';
import type { EntryType } from './flight';

const MINUTES_PER_DAY = 24 * 60;

/**
 * The minimum a record must carry to take part in conflict detection.
 *
 * Deliberately narrow: `registration` is absent because the rule IGNORES it.
 * The rule is about the pilot, not the aircraft — two flights in different
 * aircraft at the same time are exactly the case worth catching.
 */
export interface ConflictComparable {
  /** Optional: a candidate typed into the form has no id until it is saved. */
  id?: string;
  entryType?: EntryType;
  date: string;
  offBlock: string;
  onBlock: string;
}

/** A half-open span of minutes on the absolute timeline: `[start, end)`. */
interface Interval {
  start: number;
  end: number;
}

/**
 * Place an entry on an absolute date-plus-time timeline, or return `null` if it
 * does not occupy one.
 *
 * The timeline is minutes since 1970-01-01T00:00Z. Comparing times of day alone
 * would be wrong twice over: it would miss a flight that crosses midnight into
 * the next day, and it would report two flights a year apart that happen to
 * share an hour.
 *
 * Returns `null` — meaning "takes no part" — for:
 *
 *  - FSTD entries. A simulator session carries no block times at all: schema v3
 *    forces `offBlock` and `onBlock` empty, so there is nothing to intersect.
 *    Note that "you cannot be in a sim and an aircraft at once" is true in
 *    principle; it is only the absent data that stops us checking it. If FSTD
 *    entries ever gain real times, this exclusion should be revisited rather
 *    than assumed correct.
 *  - Missing or malformed dates or times. A half-typed form calls this on every
 *    keystroke, so an incomplete entry must simply find nothing rather than
 *    throw or guess.
 *  - Zero-duration entries (`14:00–14:00`, the aborted-before-taxi case in the
 *    sample logbook). An entry occupying no time cannot intersect anything.
 */
function toInterval(entry: ConflictComparable | null | undefined): Interval | null {
  if (!entry) return null;
  if (entry.entryType === 'fstd') return null;

  const { date, offBlock, onBlock } = entry;
  if (typeof date !== 'string' || typeof offBlock !== 'string' || typeof onBlock !== 'string') {
    return null;
  }

  const day = isoDateToDayNumber(date);
  const off = timeOfDayToMinutes(offBlock);
  // The one place midnight arithmetic is done, reused rather than rewritten:
  // an on-block earlier than its off-block means the entry ended the next day.
  const duration = elapsedMinutes(offBlock, onBlock);
  if (Number.isNaN(day) || Number.isNaN(off) || Number.isNaN(duration)) return null;
  if (duration <= 0) return null;

  const start = day * MINUTES_PER_DAY + off;
  return { start, end: start + duration };
}

/**
 * Strict intersection. TOUCHING IS NOT OVERLAPPING: `07:00–08:00` and
 * `08:00–09:00` are ordinary back-to-back legs and must stay silent, which is
 * why both comparisons are `<` and not `<=`.
 */
function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Deterministic display order: date, then id. */
function byDateThenId(a: ConflictComparable, b: ConflictComparable): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const aId = a.id ?? '';
  const bId = b.id ?? '';
  if (aId === bId) return 0;
  return aId < bId ? -1 : 1;
}

/**
 * Every entry in `existing` whose block times intersect the candidate's.
 *
 * Returns the conflicting RECORDS, not a boolean, because both callers have to
 * show the pilot what the entry clashed with — an unexplained warning is worse
 * than none. Every conflict is returned, not just the first: more than one is
 * rare, but a pilot who has double-entered a day should see the whole mess at
 * once.
 *
 * An entry never conflicts with itself. Matching is on `id`, so re-checking a
 * saved flight while editing it does not report its own stored copy.
 *
 * Neither argument is mutated.
 */
export function findConflicts<T extends ConflictComparable>(
  candidate: ConflictComparable,
  existing: readonly T[],
): T[] {
  const target = toInterval(candidate);
  if (!target) return [];

  const candidateId = typeof candidate.id === 'string' ? candidate.id : '';
  const found: T[] = [];

  for (const entry of existing ?? []) {
    // Never compare an entry with itself. An id is only meaningful once the
    // record has one, so a blank candidate id matches nothing.
    if (candidateId !== '' && entry?.id === candidateId) continue;
    const other = toInterval(entry);
    if (other && overlaps(target, other)) found.push(entry);
  }

  // Sorting `found` — a fresh array — leaves `existing` in its original order.
  return found.sort(byDateThenId);
}
