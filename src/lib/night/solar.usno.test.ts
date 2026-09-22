/**
 * The −6° threshold, checked against the US Naval Observatory.
 *
 * Every other test in `night/` checks that this code does what it was designed
 * to do. This one checks the design against an outside authority: the USNO
 * publishes the official Begin and End of Civil Twilight for a place and a
 * date, and EASA night is defined as the gap between them. If `solar.ts` ever
 * drifts from that, the feature is wrong no matter how self-consistent it is.
 *
 * The table below was fetched once from
 * `https://aa.usno.navy.mil/api/rstt/oneday` (API version 4.0.1) and is
 * committed as a fixture — the test needs no network, in keeping with the rule
 * that nothing in this project touches one. Twelve places from Svalbard to
 * Ushuaia, six dates spanning the solstices and equinoxes, chosen to cover the
 * Nordic winter cases where twilight is long and the threshold matters most.
 *
 * USNO publishes to the nearest minute, so the assertion is to the minute.
 * When this was written the agreement was exact on all 128 twilight times, with
 * a signed mean of 0.00 minutes; the ±1 minute tolerance is for USNO's own
 * rounding, not for slack in the calculation.
 *
 * The eight site-days with `begin: null, end: null` are the polar cases where
 * USNO reports no civil twilight at all. They are the more interesting half of
 * the table: they assert that this code finds no crossing either, which is what
 * stops a high-latitude winter flight being silently logged as all night or all
 * day.
 */
import { describe, it, expect } from 'vitest';
import { sunAltitudeDegrees, CIVIL_TWILIGHT_DEGREES } from './solar';

interface UsnoDay {
  site: string;
  lat: number;
  lon: number;
  date: string;
  /** Morning civil twilight, "HH:MM" UTC, or null where there is none. */
  begin: string | null;
  /** Evening civil twilight, "HH:MM" UTC, or null where there is none. */
  end: string | null;
}

/** Fetched from the USNO API; see the note at the top of this file. */
const USNO: readonly UsnoDay[] = [
  { site: 'EGLL', lat: 51.4707, lon: -0.4614, date: '2024-03-20', begin: '05:30', end: '18:49' },
  { site: 'EGLL', lat: 51.4707, lon: -0.4614, date: '2024-05-16', begin: '03:26', end: '20:31' },
  { site: 'EGLL', lat: 51.4707, lon: -0.4614, date: '2024-06-20', begin: '02:57', end: '21:10' },
  { site: 'EGLL', lat: 51.4707, lon: -0.4614, date: '2024-09-22', begin: '05:15', end: '18:32' },
  { site: 'EGLL', lat: 51.4707, lon: -0.4614, date: '2024-12-21', begin: '07:25', end: '16:35' },
  { site: 'EGLL', lat: 51.4707, lon: -0.4614, date: '2025-01-10', begin: '07:25', end: '16:54' },
  { site: 'EKCH', lat: 55.6179, lon: 12.656, date: '2024-03-20', begin: '04:34', end: '18:01' },
  { site: 'EKCH', lat: 55.6179, lon: 12.656, date: '2024-05-16', begin: '02:07', end: '20:07' },
  { site: 'EKCH', lat: 55.6179, lon: 12.656, date: '2024-06-20', begin: '01:24', end: '20:58' },
  { site: 'EKCH', lat: 55.6179, lon: 12.656, date: '2024-09-22', begin: '04:19', end: '17:44' },
  { site: 'EKCH', lat: 55.6179, lon: 12.656, date: '2024-12-21', begin: '06:50', end: '15:25' },
  { site: 'EKCH', lat: 55.6179, lon: 12.656, date: '2025-01-10', begin: '06:48', end: '15:46' },
  { site: 'ENBO', lat: 67.2692, lon: 14.3653, date: '2024-03-20', begin: '04:07', end: '18:15' },
  { site: 'ENBO', lat: 67.2692, lon: 14.3653, date: '2024-05-16', begin: null, end: null },
  { site: 'ENBO', lat: 67.2692, lon: 14.3653, date: '2024-06-20', begin: null, end: null },
  { site: 'ENBO', lat: 67.2692, lon: 14.3653, date: '2024-09-22', begin: '03:51', end: '17:57' },
  { site: 'ENBO', lat: 67.2692, lon: 14.3653, date: '2024-12-21', begin: '08:12', end: '13:50' },
  { site: 'ENBO', lat: 67.2692, lon: 14.3653, date: '2025-01-10', begin: '07:58', end: '14:23' },
  { site: 'ENGM', lat: 60.1939, lon: 11.1004, date: '2024-03-20', begin: '04:34', end: '18:13' },
  { site: 'ENGM', lat: 60.1939, lon: 11.1004, date: '2024-05-16', begin: '01:28', end: '20:59' },
  { site: 'ENGM', lat: 60.1939, lon: 11.1004, date: '2024-06-20', begin: '23:56', end: '22:39' },
  { site: 'ENGM', lat: 60.1939, lon: 11.1004, date: '2024-09-22', begin: '04:19', end: '17:56' },
  { site: 'ENGM', lat: 60.1939, lon: 11.1004, date: '2024-12-21', begin: '07:21', end: '15:07' },
  { site: 'ENGM', lat: 60.1939, lon: 11.1004, date: '2025-01-10', begin: '07:17', end: '15:30' },
  { site: 'ENSB', lat: 78.2461, lon: 15.4656, date: '2024-03-20', begin: '03:02', end: '19:15' },
  { site: 'ENSB', lat: 78.2461, lon: 15.4656, date: '2024-05-16', begin: null, end: null },
  { site: 'ENSB', lat: 78.2461, lon: 15.4656, date: '2024-06-20', begin: null, end: null },
  { site: 'ENSB', lat: 78.2461, lon: 15.4656, date: '2024-09-22', begin: '02:44', end: '18:52' },
  { site: 'ENSB', lat: 78.2461, lon: 15.4656, date: '2024-12-21', begin: null, end: null },
  { site: 'ENSB', lat: 78.2461, lon: 15.4656, date: '2025-01-10', begin: null, end: null },
  { site: 'ENTC', lat: 69.6833, lon: 18.9189, date: '2024-03-20', begin: '03:42', end: '18:04' },
  { site: 'ENTC', lat: 69.6833, lon: 18.9189, date: '2024-05-16', begin: null, end: null },
  { site: 'ENTC', lat: 69.6833, lon: 18.9189, date: '2024-06-20', begin: null, end: null },
  { site: 'ENTC', lat: 69.6833, lon: 18.9189, date: '2024-09-22', begin: '03:25', end: '17:46' },
  { site: 'ENTC', lat: 69.6833, lon: 18.9189, date: '2024-12-21', begin: '08:32', end: '12:53' },
  { site: 'ENTC', lat: 69.6833, lon: 18.9189, date: '2025-01-10', begin: '08:10', end: '13:34' },
  { site: 'EQUATOR', lat: 0, lon: 0, date: '2024-03-20', begin: '05:43', end: '18:31' },
  { site: 'EQUATOR', lat: 0, lon: 0, date: '2024-05-16', begin: '05:31', end: '18:22' },
  { site: 'EQUATOR', lat: 0, lon: 0, date: '2024-06-20', begin: '05:35', end: '18:28' },
  { site: 'EQUATOR', lat: 0, lon: 0, date: '2024-09-22', begin: '05:29', end: '18:16' },
  { site: 'EQUATOR', lat: 0, lon: 0, date: '2024-12-21', begin: '05:32', end: '18:25' },
  { site: 'EQUATOR', lat: 0, lon: 0, date: '2025-01-10', begin: '05:42', end: '18:34' },
  { site: 'ESSA', lat: 59.6519, lon: 17.9186, date: '2024-03-20', begin: '04:08', end: '17:45' },
  { site: 'ESSA', lat: 59.6519, lon: 17.9186, date: '2024-05-16', begin: '01:07', end: '20:25' },
  { site: 'ESSA', lat: 59.6519, lon: 17.9186, date: '2024-06-20', begin: '23:50', end: '21:50' },
  { site: 'ESSA', lat: 59.6519, lon: 17.9186, date: '2024-09-22', begin: '03:52', end: '17:28' },
  { site: 'ESSA', lat: 59.6519, lon: 17.9186, date: '2024-12-21', begin: '06:51', end: '14:43' },
  { site: 'ESSA', lat: 59.6519, lon: 17.9186, date: '2025-01-10', begin: '06:46', end: '15:06' },
  { site: 'GCLP', lat: 27.9319, lon: -15.3866, date: '2024-03-20', begin: '06:42', end: '19:37' },
  { site: 'GCLP', lat: 27.9319, lon: -15.3866, date: '2024-05-16', begin: '05:46', end: '20:11' },
  { site: 'GCLP', lat: 27.9319, lon: -15.3866, date: '2024-06-20', begin: '05:39', end: '20:27' },
  { site: 'GCLP', lat: 27.9319, lon: -15.3866, date: '2024-09-22', begin: '06:27', end: '19:21' },
  { site: 'GCLP', lat: 27.9319, lon: -15.3866, date: '2024-12-21', begin: '07:23', end: '18:37' },
  { site: 'GCLP', lat: 27.9319, lon: -15.3866, date: '2025-01-10', begin: '07:29', end: '18:50' },
  { site: 'LIMC', lat: 45.6306, lon: 8.7281, date: '2024-03-20', begin: '04:58', end: '18:08' },
  { site: 'LIMC', lat: 45.6306, lon: 8.7281, date: '2024-05-16', begin: '03:18', end: '19:26' },
  { site: 'LIMC', lat: 45.6306, lon: 8.7281, date: '2024-06-20', begin: '02:58', end: '19:56' },
  { site: 'LIMC', lat: 45.6306, lon: 8.7281, date: '2024-09-22', begin: '04:43', end: '17:52' },
  { site: 'LIMC', lat: 45.6306, lon: 8.7281, date: '2024-12-21', begin: '06:28', end: '16:18' },
  { site: 'LIMC', lat: 45.6306, lon: 8.7281, date: '2025-01-10', begin: '06:31', end: '16:35' },
  { site: 'SYDNEY', lat: -33.9461, lon: 151.1772, date: '2024-03-20', begin: '19:34', end: '08:31' },
  { site: 'SYDNEY', lat: -33.9461, lon: 151.1772, date: '2024-05-16', begin: '20:15', end: '07:28' },
  { site: 'SYDNEY', lat: -33.9461, lon: 151.1772, date: '2024-06-20', begin: '20:33', end: '07:21' },
  { site: 'SYDNEY', lat: -33.9461, lon: 151.1772, date: '2024-09-22', begin: '19:18', end: '08:17' },
  { site: 'SYDNEY', lat: -33.9461, lon: 151.1772, date: '2024-12-21', begin: '18:12', end: '09:35' },
  { site: 'SYDNEY', lat: -33.9461, lon: 151.1772, date: '2025-01-10', begin: '18:27', end: '09:39' },
  { site: 'USHUAIA', lat: -54.8433, lon: -68.2958, date: '2024-03-20', begin: '09:59', end: '23:20' },
  { site: 'USHUAIA', lat: -54.8433, lon: -68.2958, date: '2024-05-16', begin: '11:40', end: '21:18' },
  { site: 'USHUAIA', lat: -54.8433, lon: -68.2958, date: '2024-06-20', begin: '12:14', end: '20:56' },
  { site: 'USHUAIA', lat: -54.8433, lon: -68.2958, date: '2024-09-22', begin: '09:44', end: '23:08' },
  { site: 'USHUAIA', lat: -54.8433, lon: -68.2958, date: '2024-12-21', begin: '06:54', end: '02:09' },
  { site: 'USHUAIA', lat: -54.8433, lon: -68.2958, date: '2025-01-10', begin: '07:21', end: '02:01' },];

const MINUTE = 60_000;

/** The instant the sun crosses the threshold, searched over one UTC day. */
function crossings(day: UsnoDay): { begin: Date | null; end: Date | null } {
  const where = { lat: day.lat, lon: day.lon };
  const start = Date.parse(`${day.date}T00:00:00Z`);
  const above = (ms: number) => sunAltitudeDegrees(new Date(ms), where) >= CIVIL_TWILIGHT_DEGREES;

  let begin: Date | null = null;
  let end: Date | null = null;
  let prev = above(start);
  for (let m = 1; m <= 1440; m++) {
    const ms = start + m * MINUTE;
    const now = above(ms);
    if (now !== prev) {
      const at = new Date(refine(ms - MINUTE, ms, where, now));
      if (now && !begin) begin = at;
      if (!now) end = at;
    }
    prev = now;
  }
  return { begin, end };
}

/** Bisect a one-minute bracket down to the second. */
function refine(lo: number, hi: number, where: { lat: number; lon: number }, rising: boolean): number {
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if ((sunAltitudeDegrees(new Date(mid), where) >= CIVIL_TWILIGHT_DEGREES) === rising) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** To the nearest minute, the way USNO publishes it. */
function hhmm(d: Date): string {
  const r = new Date(Math.round(d.getTime() / MINUTE) * MINUTE);
  return `${String(r.getUTCHours()).padStart(2, '0')}:${String(r.getUTCMinutes()).padStart(2, '0')}`;
}

/** Clock-face difference in minutes, shortest way round the dial. */
function minutesApart(a: string, b: string): number {
  const asMinutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  let d = asMinutes(a) - asMinutes(b);
  if (d > 720) d -= 1440;
  if (d < -720) d += 1440;
  return d;
}

describe('civil twilight against the US Naval Observatory', () => {
  it.each(USNO.filter((d) => d.begin || d.end))(
    '$site $date matches the published twilight times',
    (day) => {
      const ours = crossings(day);
      if (day.begin) {
        expect(ours.begin).not.toBeNull();
        expect(Math.abs(minutesApart(hhmm(ours.begin!), day.begin))).toBeLessThanOrEqual(1);
      }
      if (day.end) {
        expect(ours.end).not.toBeNull();
        expect(Math.abs(minutesApart(hhmm(ours.end!), day.end))).toBeLessThanOrEqual(1);
      }
    },
  );

  it.each(USNO.filter((d) => !d.begin && !d.end))(
    '$site $date has no civil twilight, and neither do we',
    (day) => {
      const ours = crossings(day);
      expect(ours.begin).toBeNull();
      expect(ours.end).toBeNull();
    },
  );

  it('agrees with the whole table to within a minute, with no systematic bias', () => {
    const errors: number[] = [];
    for (const day of USNO) {
      const ours = crossings(day);
      if (day.begin && ours.begin) errors.push(minutesApart(hhmm(ours.begin), day.begin));
      if (day.end && ours.end) errors.push(minutesApart(hhmm(ours.end), day.end));
    }
    expect(errors.length).toBe(128);
    const mean = errors.reduce((sum, e) => sum + e, 0) / errors.length;
    // A threshold or sign error would show up here as a bias, where a handful
    // of rounding disagreements cannot.
    expect(Math.abs(mean)).toBeLessThan(0.25);
    expect(Math.max(...errors.map(Math.abs))).toBeLessThanOrEqual(1);
  });
});
