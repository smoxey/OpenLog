/**
 * What a named time zone's offset from UTC was at a given moment.
 *
 * THE ARGUMENT FOR THIS EXISTING AT ALL, given that `timeOfDay.ts` says in
 * writing that this app does not do aerodrome time zones:
 *
 * That rule is about the ENTRY FORM, and it stands. A pilot typing last
 * Tuesday's sector picks an offset, because the app cannot know where they were
 * or which clock they read the time off, and guessing on their behalf would be
 * an invention dressed as a fact.
 *
 * Reading somebody else's file is a different question. An Airside export
 * writes its block times on the DEPARTURE AERODROME'S wall clock, and no offset
 * the pilot could pick would be right for the whole file — a Scandinavian
 * short-haul year touches UTC+0, +1, +2 and +3, and moves between them twice a
 * year. Refusing to convert would put times in the logbook that are wrong by up
 * to three hours on a fifth of the rows, and every night-time figure computed
 * from them would inherit that.
 *
 * WHAT THIS DOES NOT DO: ship a time zone database. `Intl` is already in every
 * browser this app runs in, carrying the IANA rules and their history, and it
 * costs nothing to ask. What the app supplies is the zone NAME — which is a
 * question put to the pilot, not read off a table of aerodromes. The bundled
 * airport list still holds a latitude, a longitude and nothing else.
 *
 * PURE: no settings, no storage, no `Date.now()`, no DOM. Every answer is a
 * function of its arguments.
 */
import { isoDateToDayNumber } from './blockTime';

/** Formatters are not cheap to build and a file asks for the same zone 900 times. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  let built: Intl.DateTimeFormat;
  try {
    built = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    // An unknown zone name throws a RangeError. That is an ordinary outcome
    // here — the name may have come from a restored setting or a typed field —
    // so it comes back as `null` rather than as an exception.
    return null;
  }
  formatters.set(timeZone, built);
  return built;
}

/** Is this a zone name `Intl` recognises? */
export function isValidTimeZone(name: unknown): name is string {
  return typeof name === 'string' && name.trim() !== '' && formatterFor(name.trim()) !== null;
}

/**
 * Every zone name this browser knows, or a small fallback list.
 *
 * `Intl.supportedValuesOf` landed in 2022 and is in every evergreen browser,
 * but an older iPad is exactly the device this app is meant to run on, so its
 * absence is handled rather than assumed away. The fallback is deliberately
 * short: it is a starting point for a text field, not a claim to completeness,
 * and the field accepts any name `Intl` accepts.
 */
const FALLBACK_ZONES: readonly string[] = [
  'UTC',
  'Atlantic/Canary',
  'Atlantic/Reykjavik',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/Brussels',
  'Europe/Copenhagen',
  'Europe/Dublin',
  'Europe/Helsinki',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Oslo',
  'Europe/Paris',
  'Europe/Riga',
  'Europe/Rome',
  'Europe/Stockholm',
  'Europe/Tallinn',
  'Europe/Vilnius',
  'Europe/Warsaw',
  'Europe/Zurich',
];

export function listTimeZones(): readonly string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof supported !== 'function') return FALLBACK_ZONES;
  try {
    const zones = supported.call(Intl, 'timeZone');
    return Array.isArray(zones) && zones.length > 0 ? zones : FALLBACK_ZONES;
  } catch {
    return FALLBACK_ZONES;
  }
}

/** The device's own zone, or `null` when the browser will not say. */
export function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

const NUMERIC = /^\d+$/;

/**
 * The zone's offset, in minutes east of UTC, at an absolute instant.
 *
 * The standard trick, and the only one that works without a tz database of our
 * own: ask `Intl` what the wall clock in that zone reads at this instant, read
 * that answer back as if it were UTC, and the difference is the offset.
 */
function offsetAtInstant(timeZone: string, utcMs: number): number | null {
  const formatter = formatterFor(timeZone);
  if (!formatter || !Number.isFinite(utcMs)) return null;

  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type === 'literal' || !NUMERIC.test(part.value)) continue;
    parts[part.type] = Number(part.value);
  }
  const { year, month, day, hour, minute, second } = parts;
  if ([year, month, day, hour, minute, second].some((v) => v === undefined)) return null;

  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // `Date.UTC` maps years 0-99 onto 1900-1999. No logbook reaches back that
  // far, but a damaged date should not silently become a 20th-century one.
  if (year < 100) return null;
  return Math.round((asIfUtc - utcMs) / 60_000);
}

/**
 * `"2024-01-15"` and 480 minutes -> the ms of 2024-01-15T08:00:00Z.
 *
 * Through `isoDateToDayNumber` rather than `Date.parse`, because that rolls an
 * impossible date over into the next month rather than refusing it, and a
 * silently shifted date would be answered with a real-looking offset.
 */
function localWallClockMs(isoDate: string, minutesOfDay: number): number {
  const day = isoDateToDayNumber(String(isoDate ?? ''));
  if (!Number.isFinite(day) || !Number.isFinite(minutesOfDay)) return NaN;
  return day * 86_400_000 + minutesOfDay * 60_000;
}

/**
 * The offset a wall clock in `timeZone` was showing on `isoDate` at
 * `minutesOfDay`, in minutes east of UTC. `+120` means UTC+02:00.
 *
 * The inverse problem: the instant is what we want and the local reading is
 * what we have, so the answer is found by one refinement pass. The first guess
 * treats the local reading as if it were UTC, which is wrong by at most the
 * offset itself; evaluating the zone at that approximate instant then gives an
 * offset that is right unless the two instants fall on opposite sides of a DST
 * transition, and the second pass settles that.
 *
 * THE TWO CASES THIS CANNOT ANSWER PERFECTLY, both an hour wide, twice a year:
 * a local time that never happened (the spring-forward gap) and one that
 * happened twice (the autumn overlap). Both return a real, adjacent offset
 * rather than failing — an aircraft blocking off inside a DST gap is a fiction
 * of the file, not something to refuse a whole import over.
 */
export function zoneOffsetForLocal(
  timeZone: string,
  isoDate: string,
  minutesOfDay: number,
): number | null {
  const localMs = localWallClockMs(isoDate, minutesOfDay);
  if (!Number.isFinite(localMs)) return null;

  const first = offsetAtInstant(timeZone, localMs);
  if (first === null) return null;
  const refined = offsetAtInstant(timeZone, localMs - first * 60_000);
  return refined ?? first;
}

/** The offset at midnight UTC on a date. For labelling a zone in the UI. */
export function zoneOffsetOnDate(timeZone: string, isoDate: string): number | null {
  return zoneOffsetForLocal(timeZone, isoDate, 0);
}
