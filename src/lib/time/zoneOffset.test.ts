import { describe, it, expect } from 'vitest';
import {
  deviceTimeZone,
  isValidTimeZone,
  listTimeZones,
  zoneOffsetForLocal,
  zoneOffsetOnDate,
} from './zoneOffset';

/**
 * These read the IANA rules out of `Intl`, which every browser and Node build
 * this app runs on already carries. The zones chosen are ones whose history is
 * settled and well known, and the dates are away from the transitions
 * themselves except where a transition is the thing being tested.
 */

const noon = 12 * 60;

describe('what a zone read at a moment', () => {
  it('reads standard time in winter and summer time in summer', () => {
    expect(zoneOffsetForLocal('Europe/Oslo', '2024-01-15', noon)).toBe(60);
    expect(zoneOffsetForLocal('Europe/Oslo', '2024-07-15', noon)).toBe(120);
  });

  it('reads a zone that keeps UTC in winter', () => {
    expect(zoneOffsetForLocal('Europe/London', '2024-02-10', noon)).toBe(0);
    expect(zoneOffsetForLocal('Europe/London', '2024-07-10', noon)).toBe(60);
    expect(zoneOffsetForLocal('Atlantic/Canary', '2024-01-18', noon)).toBe(0);
    expect(zoneOffsetForLocal('Atlantic/Canary', '2024-07-18', noon)).toBe(60);
  });

  it('reads a zone two hours east', () => {
    expect(zoneOffsetForLocal('Europe/Tallinn', '2024-02-20', noon)).toBe(120);
    expect(zoneOffsetForLocal('Europe/Tallinn', '2024-08-20', noon)).toBe(180);
  });

  it('reads a zone that never changes', () => {
    expect(zoneOffsetForLocal('UTC', '2024-01-01', noon)).toBe(0);
    expect(zoneOffsetForLocal('UTC', '2024-07-01', noon)).toBe(0);
  });

  it('reads a zone west of UTC, with the sign a pilot reads off a chart', () => {
    // Negative for west, matching `localToUtc` and `formatOffset`.
    expect(zoneOffsetForLocal('America/New_York', '2024-01-15', noon)).toBe(-300);
    expect(zoneOffsetForLocal('America/New_York', '2024-07-15', noon)).toBe(-240);
  });

  it('reads a half-hour zone', () => {
    expect(zoneOffsetForLocal('Asia/Kolkata', '2024-01-15', noon)).toBe(330);
  });

  it('lands on the right side of a transition', () => {
    // Europe changes at 01:00 UTC on the last Sunday in March. On 31 March 2024
    // that is 02:00 Oslo local, so 00:30 is still CET and 04:00 is CEST.
    expect(zoneOffsetForLocal('Europe/Oslo', '2024-03-31', 30)).toBe(60);
    expect(zoneOffsetForLocal('Europe/Oslo', '2024-03-31', 4 * 60)).toBe(120);
  });

  it('answers with a real neighbouring offset inside the spring-forward gap', () => {
    // 02:30 on 31 March 2024 never happened in Oslo. An aircraft blocking off
    // then is a fiction of the file, not something to refuse a whole import
    // over, so this returns one of the two adjacent offsets rather than null.
    const offset = zoneOffsetForLocal('Europe/Oslo', '2024-03-31', 2 * 60 + 30);
    expect([60, 120]).toContain(offset);
  });
});

describe('what it refuses', () => {
  it('returns null for a zone name Intl does not know', () => {
    expect(zoneOffsetForLocal('Europe/Nowhere', '2024-01-15', noon)).toBeNull();
    expect(isValidTimeZone('Europe/Nowhere')).toBe(false);
  });

  it('returns null for a date the calendar does not have', () => {
    // `Date.parse` would roll 30 February into 1 March and answer confidently.
    expect(zoneOffsetForLocal('Europe/Oslo', '2024-02-30', noon)).toBeNull();
    expect(zoneOffsetForLocal('Europe/Oslo', 'not a date', noon)).toBeNull();
    expect(zoneOffsetForLocal('Europe/Oslo', '', noon)).toBeNull();
  });

  it('returns null for a time that is not a number', () => {
    expect(zoneOffsetForLocal('Europe/Oslo', '2024-01-15', Number.NaN)).toBeNull();
  });
});

describe('the zone names on offer', () => {
  it('accepts a name it offers', () => {
    const zones = listTimeZones();
    expect(zones.length).toBeGreaterThan(0);
    expect(isValidTimeZone(zones[0])).toBe(true);
  });

  it('rejects what is not a name at all', () => {
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('   ')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });

  it('reports the device zone only when it is one Intl accepts', () => {
    const zone = deviceTimeZone();
    if (zone !== null) expect(isValidTimeZone(zone)).toBe(true);
  });
});

describe('labelling a zone', () => {
  it('gives the offset at midnight on a date', () => {
    expect(zoneOffsetOnDate('Europe/Oslo', '2024-01-15')).toBe(60);
    expect(zoneOffsetOnDate('Europe/Oslo', '2024-07-15')).toBe(120);
    expect(zoneOffsetOnDate('Europe/Nowhere', '2024-07-15')).toBeNull();
  });
});
