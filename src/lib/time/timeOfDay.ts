/**
 * Times of day — how they are WRITTEN, and which clock they are written on.
 *
 * The logbook stores one thing and one thing only: a `"HH:MM"` string on the
 * 24-hour clock, in UTC. Everything in this module is a translation layer on
 * top of that, and none of it ever changes what is stored:
 *
 *  - `formatTimeOfDay` / `parseTimeOfDayInput` are the CLOCK: 24-hour by
 *    default, 12-hour with am/pm if the pilot asks for it in settings. A
 *    display preference, exactly like `durationDisplay` — no exporter reads it.
 *  - `localToUtc` / `utcToLocal` and the entry-level pair around them are the
 *    ZONE: they let a pilot type the times off their watch instead of doing the
 *    subtraction in their head. The subtraction happens here, once, and the
 *    record still lands in UTC.
 *
 * PURE: no settings, no storage, no clock, no DOM. The offset is always given,
 * never read from the device — a pilot entering last Tuesday's flight from an
 * airport hotel is not in the timezone their phone happens to be in, and the
 * device offset would also silently move with DST.
 *
 * WHY AN OFFSET AND NOT AN AERODROME TIMEZONE: the bundled airport table holds
 * a latitude and a longitude and deliberately nothing else (see
 * `airports/types.ts`). Real timezone data is a megabyte and a maintenance
 * subscription, both of which the offline-first promise refuses. An offset the
 * pilot picks is honest about being the pilot's answer.
 */
import { addDays, timeOfDayToMinutes } from './blockTime';

export type ClockDisplay = '24h' | '12h';

const MINUTES_PER_DAY = 24 * 60;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Minutes-since-midnight back to `"HH:MM"`. The inverse of
 * `timeOfDayToMinutes`, and the only place the canonical shape is written.
 *
 * Values outside a single day are wrapped, so callers doing offset arithmetic
 * do not each have to remember the modulo. `""` for a non-finite input rather
 * than "NaN:NaN".
 */
export function minutesToTimeOfDay(minutes: number): string {
  if (!Number.isFinite(minutes)) return '';
  const wrapped = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

/**
 * A stored `"HH:MM"` shown on the pilot's chosen clock.
 *
 * Anything that is not a valid time of day is passed straight back rather than
 * blanked: a display function is the wrong place to lose data, and an odd value
 * on screen is how a pilot finds out something is wrong with a record.
 */
export function formatTimeOfDay(value: string, clock: ClockDisplay): string {
  const minutes = timeOfDayToMinutes(value ?? '');
  if (Number.isNaN(minutes)) return (value ?? '').trim();
  if (clock === '24h') return minutesToTimeOfDay(minutes);

  const hours24 = Math.floor(minutes / 60);
  const suffix = hours24 < 12 ? 'AM' : 'PM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${pad(minutes % 60)} ${suffix}`;
}

/**
 * Read typed text as a time of day, into the canonical `"HH:MM"`.
 *
 * `null` for anything unreadable, so a caller can show an inline error without
 * discarding what was typed; `""` for empty input, which is a real answer —
 * a simulator session has no block times, and `validateFlight` is what decides
 * whether a blank is allowed here.
 *
 * DELIBERATELY GENEROUS, AND DELIBERATELY NOT DEPENDENT ON THE CLOCK SETTING.
 * Accepts `2336`, `23:36`, `23`, `11:36 pm`, `1136pm`, `11:36:00`. The setting
 * decides how a time is SHOWN; a pilot who types four digits into a 12-hour
 * field means the 24-hour reading of them, and refusing it because a preference
 * elsewhere says "am/pm" would be a preference getting in the way of an answer.
 * Without a suffix the digits are read on the 24-hour clock, so `11:36` is
 * morning — which is why the field re-renders as `11:36 AM` the moment it is
 * left, where a pilot who meant the evening can see it.
 */
export function parseTimeOfDayInput(text: string): string | null {
  const raw = (text ?? '').trim();
  if (raw === '') return '';

  // Case, spaces and the dots in "a.m." carry no information here.
  let body = raw.toLowerCase().replace(/[\s.]/g, '');

  const SUFFIXES = [
    ['am', 'am'],
    ['pm', 'pm'],
    ['a', 'am'],
    ['p', 'pm'],
  ] as const;

  let meridiem: 'am' | 'pm' | null = null;
  for (const [suffix, which] of SUFFIXES) {
    if (body.endsWith(suffix)) {
      meridiem = which;
      body = body.slice(0, -suffix.length);
      break;
    }
  }

  let hours: number;
  let minutes: number;

  const separated = /^(\d{1,2})[:h](\d{1,2})(?::\d{1,2})?$/.exec(body);
  if (separated) {
    hours = Number(separated[1]);
    minutes = Number(separated[2]);
  } else if (/^\d{3,4}$/.test(body)) {
    // "2336" and "936" — the shape a pilot types on a numeric keypad, and the
    // reason this field is not a native time picker.
    hours = Number(body.slice(0, body.length - 2));
    minutes = Number(body.slice(-2));
  } else if (/^\d{1,2}$/.test(body)) {
    hours = Number(body);
    minutes = 0;
  } else {
    return null;
  }

  if (minutes > 59) return null;

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === 'am') hours = hours === 12 ? 0 : hours;
    else hours = hours === 12 ? 12 : hours + 12;
  }

  if (hours > 23) return null;
  return `${pad(hours)}:${pad(minutes)}`;
}

/**
 * A time moved between clocks, and whether it fell off the end of the day.
 *
 * `dayShift` is the whole point of the return type. 01:30 in UTC+2 is 23:30
 * UTC *the day before*, and a conversion that returned only "23:30" would file
 * that flight on the wrong date — the one class of error this whole feature can
 * introduce, and the one it therefore reports rather than hides.
 */
export interface ShiftedTime {
  /** The canonical `"HH:MM"` on the target clock. */
  time: string;
  /** −1, 0 or +1: which calendar day the result landed on. */
  dayShift: number;
}

function shiftTime(value: string, deltaMinutes: number): ShiftedTime {
  const base = timeOfDayToMinutes(value ?? '');
  // A blank or malformed time is left exactly as it is. There is nothing to
  // convert, and inventing a shift would move the date off a value that says
  // nothing.
  if (Number.isNaN(base)) return { time: (value ?? '').trim(), dayShift: 0 };
  const total = base + deltaMinutes;
  const dayShift = Math.floor(total / MINUTES_PER_DAY);
  return { time: minutesToTimeOfDay(total - dayShift * MINUTES_PER_DAY), dayShift };
}

/**
 * A local wall-clock time to UTC. `UTC = local − offset`.
 *
 * `offsetMinutes` is the local zone's offset FROM UTC — +120 for UTC+02:00 —
 * which is the sign a pilot reads off a chart, not the sign
 * `Date.getTimezoneOffset()` uses.
 */
export function localToUtc(value: string, offsetMinutes: number): ShiftedTime {
  return shiftTime(value, -offsetMinutes);
}

/** UTC to a local wall-clock time. The exact inverse of `localToUtc`. */
export function utcToLocal(value: string, offsetMinutes: number): ShiftedTime {
  return shiftTime(value, offsetMinutes);
}

/** The three fields a zone conversion touches, and nothing else. */
export interface ZonedEntry {
  date: string;
  offBlock: string;
  onBlock: string;
}

/**
 * A local-time entry expressed in the UTC the logbook stores.
 *
 * THE DATE FOLLOWS THE OFF-BLOCK, and only the off-block. A record carries one
 * date, and what it means is the day the flight departed — so that is the value
 * a zone change may move. The on-block time needs no date of its own: a sector
 * landing after midnight is already expressed by an on-block earlier than the
 * off-block, which is how `elapsedMinutes` has always read it.
 */
export function entryLocalToUtc(entry: ZonedEntry, offsetMinutes: number): ZonedEntry {
  return convertEntry(entry, offsetMinutes, localToUtc);
}

/** The inverse: a stored UTC entry expressed on a local clock. */
export function entryUtcToLocal(entry: ZonedEntry, offsetMinutes: number): ZonedEntry {
  return convertEntry(entry, offsetMinutes, utcToLocal);
}

function convertEntry(
  entry: ZonedEntry,
  offsetMinutes: number,
  convert: (value: string, offsetMinutes: number) => ShiftedTime,
): ZonedEntry {
  if (!offsetMinutes) return { ...entry };

  const off = convert(entry.offBlock, offsetMinutes);
  const on = convert(entry.onBlock, offsetMinutes);

  let date = entry.date;
  if (off.dayShift !== 0) {
    const moved = addDays(entry.date, off.dayShift);
    // `addDays` returns "" for a date it cannot read. Keeping the original is
    // the safe half of that: a half-typed date must not be wiped by a shift.
    if (moved) date = moved;
  }

  return { date, offBlock: off.time, onBlock: on.time };
}

/**
 * The offsets a pilot can pick from, in minutes east of UTC.
 *
 * The real-world set rather than every quarter hour from −12:00 to +14:00 —
 * that would be 105 entries in a dropdown to reach the four dozen that exist.
 * Half and three-quarter hour zones are included because they are exactly the
 * ones a pilot cannot work around by guessing (+05:45 Nepal, +08:45 Eucla,
 * +12:45 Chatham).
 */
export const UTC_OFFSETS: readonly number[] = [
  -720, -660, -600, -570, -540, -480, -420, -360, -300, -240, -210, -180, -120, -60,
  0,
  60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 525, 540, 570, 600,
  630, 660, 720, 765, 780, 840,
];

/**
 * An offset as a label: `"UTC"`, `"UTC+02:00"`, `"UTC-03:30"`.
 *
 * Zero is "UTC" rather than "UTC+00:00" because that is the thing it is, and
 * because it is the default — the selector's resting state should read as an
 * answer, not as an arithmetic identity.
 */
export function formatOffset(offsetMinutes: number): string {
  if (!Number.isFinite(offsetMinutes) || offsetMinutes === 0) return 'UTC';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(offsetMinutes));
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** True when `offsetMinutes` is one this app offers. Guards a restored setting. */
export function isKnownOffset(offsetMinutes: unknown): offsetMinutes is number {
  return typeof offsetMinutes === 'number' && UTC_OFFSETS.includes(offsetMinutes);
}
