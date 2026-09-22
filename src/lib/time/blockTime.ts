/**
 * Block-time helpers.
 *
 * Times of day (off-block / on-block) are stored as "HH:MM" strings in UTC, and
 * dates as ISO "YYYY-MM-DD". Everything that turns those two strings into
 * numbers lives here, so no caller has to reimplement the arithmetic — see
 * `domain/conflicts`, which combines both to place an entry on an absolute
 * timeline.
 */

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TENTH_OF_HOUR_MINUTES = 6; // one tenth of an hour

/** Parse "HH:MM" into minutes-since-midnight, or NaN if malformed. */
export function timeOfDayToMinutes(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Raw elapsed minutes between two block times, handling flights that cross
 * midnight. Does NOT round.
 *   "23:30" -> "01:10"  =>  100
 *   "10:00" -> "11:30"  =>  90
 */
export function elapsedMinutes(offBlock: string, onBlock: string): number {
  const off = timeOfDayToMinutes(offBlock);
  const on = timeOfDayToMinutes(onBlock);
  if (Number.isNaN(off) || Number.isNaN(on)) return NaN;
  return (on - off + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * Day number for an ISO "YYYY-MM-DD" date: whole days since 1970-01-01 UTC, or
 * NaN if the string is malformed or not a real calendar date.
 *
 * The number itself is meaningless; only differences between two of them are
 * used, which is what lets a date and a time of day be combined into one
 * absolute minute count. Negative for dates before 1970, which is fine —
 * subtraction still works.
 *
 *   "1970-01-01" =>  0
 *   "1970-01-02" =>  1
 *   "2026-02-31" =>  NaN  (there is no such day)
 */
export function isoDateToDayNumber(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Built from the epoch rather than `new Date(y, m, d)` so two-digit years are
  // not silently shifted into the 1900s.
  const dt = new Date(0);
  dt.setUTCFullYear(year, month - 1, day);
  dt.setUTCHours(0, 0, 0, 0);

  // Date rolls impossible dates over silently ("2026-02-31" becomes 3 March),
  // so round-trip the parts to reject them rather than compare the wrong day.
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return NaN;
  }
  return Math.round(dt.getTime() / MS_PER_DAY);
}

/**
 * The inverse of `isoDateToDayNumber`: a day number back to "YYYY-MM-DD".
 *
 * Exists so date arithmetic — "28 days before this one" — can be done on day
 * numbers and turned back into the plain calendar date the records store,
 * without a caller ever constructing a `Date` and picking up a timezone with
 * it. Returns "" for a non-finite input rather than "Invalid Date".
 */
export function dayNumberToIsoDate(dayNumber: number): string {
  if (!Number.isFinite(dayNumber)) return '';
  const dt = new Date(Math.round(dayNumber) * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Shift an ISO date by whole days. "" for a malformed input.
 *
 *   addDays("2026-03-01", -1)  =>  "2026-02-28"
 *   addDays("2024-02-28",  1)  =>  "2024-02-29"   (leap year)
 */
export function addDays(isoDate: string, days: number): string {
  const day = isoDateToDayNumber(isoDate);
  if (Number.isNaN(day)) return '';
  return dayNumberToIsoDate(day + days);
}

/**
 * The LOCAL calendar date of a `Date`, as "YYYY-MM-DD".
 *
 * Local, not UTC, and deliberately: a pilot in Norway at 00:30 on the 5th is on
 * the 5th, and a totals window that silently used UTC would tell them the 4th
 * for half an hour every night. The records themselves carry no timezone at
 * all — `date` is a plain calendar date — so the only place a timezone can
 * legitimately enter is here, at the moment "today" is decided.
 */
export function localIsoDate(now: Date): string {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Suggest a logged total time from block times: elapsed time rounded to the
 * nearest tenth of an hour (nearest 6 minutes). Used to PRE-FILL the duration
 * field in the flight form — the pilot's confirmed value is what gets stored.
 *
 *   "10:00" -> "11:30"  => 90   (already a tenth; unchanged)
 *   "23:30" -> "01:10"  => 102  (raw 100 rounds up to the nearest 6)
 *   "00:00" -> "00:03"  => 6    (raw 3 rounds up to one tenth)
 *
 * Returns NaN if either time is malformed.
 */
export function suggestTotalMinutes(offBlock: string, onBlock: string): number {
  const elapsed = elapsedMinutes(offBlock, onBlock);
  if (Number.isNaN(elapsed)) return NaN;
  return Math.round(elapsed / TENTH_OF_HOUR_MINUTES) * TENTH_OF_HOUR_MINUTES;
}
