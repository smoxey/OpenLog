import { describe, it, expect } from 'vitest';
import {
  CIVIL_TWILIGHT_DEGREES,
  equationOfTimeMinutes,
  solarDeclinationDegrees,
  sunAltitudeDegrees,
} from './solar';

/**
 * These tests check the sun against things that are true by GEOMETRY, not
 * against numbers copied out of an almanac. An almanac figure typed in by hand
 * proves the typing; "the sun at the north pole sits at the declination all
 * day" proves the algorithm, and fails loudly if a sign, a longitude convention
 * or a unit conversion is wrong.
 *
 * The one that matters most is the last: on the equator at an equinox the sun
 * descends 15° an hour, so the fall from the horizon to −6° takes 24 minutes.
 * Every part of the pipeline has to be right for that number to come out.
 */

const utc = (
  y: number,
  m: number,
  d: number,
  h = 0,
  min = 0,
  s = 0,
): Date => new Date(Date.UTC(y, m - 1, d, h, min, s));

/** The greatest altitude the sun reaches on a day, found by scanning it. */
function maxAltitudeOnDay(date: Date, lat: number, lon: number): number {
  let max = -Infinity;
  for (let minute = 0; minute < 1440; minute++) {
    const when = new Date(date.getTime() + minute * 60_000);
    max = Math.max(max, sunAltitudeDegrees(when, { lat, lon }));
  }
  return max;
}

/** The first instant after `fromSeconds` at which the altitude drops below a
 *  threshold, in seconds from midnight. -1 if it never does. */
function firstCrossingBelow(
  date: Date,
  coords: { lat: number; lon: number },
  threshold: number,
  fromSeconds: number,
): number {
  for (let s = fromSeconds; s < 86_400; s++) {
    if (sunAltitudeDegrees(new Date(date.getTime() + s * 1000), coords) < threshold) return s;
  }
  return -1;
}

describe('solar declination', () => {
  it('reaches the tilt of the earth at the solstices', () => {
    expect(solarDeclinationDegrees(utc(2026, 6, 21, 12))).toBeCloseTo(23.44, 1);
    expect(solarDeclinationDegrees(utc(2026, 12, 21, 12))).toBeCloseTo(-23.44, 1);
  });

  it('passes through zero at the equinoxes', () => {
    expect(Math.abs(solarDeclinationDegrees(utc(2026, 3, 20, 12)))).toBeLessThan(0.3);
    expect(Math.abs(solarDeclinationDegrees(utc(2026, 9, 23, 12)))).toBeLessThan(0.3);
  });

  it('is the same tilt in any year — it is not drifting', () => {
    expect(solarDeclinationDegrees(utc(1990, 6, 21, 12))).toBeCloseTo(23.44, 1);
    expect(solarDeclinationDegrees(utc(2049, 6, 21, 12))).toBeCloseTo(23.44, 1);
  });
});

describe('the equation of time', () => {
  // Sign convention: apparent solar time minus mean. Negative means the sun
  // reaches the meridian LATER than the clock says noon.
  it('has the sun running about 14 minutes late in mid-February', () => {
    expect(equationOfTimeMinutes(utc(2026, 2, 11, 12))).toBeCloseTo(-14.2, 0);
  });

  it('has the sun running about 16 minutes early in early November', () => {
    expect(equationOfTimeMinutes(utc(2026, 11, 3, 12))).toBeCloseTo(16.4, 0);
  });

  it('passes through zero four times a year', () => {
    for (const [month, day] of [
      [4, 15],
      [6, 13],
      [9, 1],
      [12, 25],
    ]) {
      expect(Math.abs(equationOfTimeMinutes(utc(2026, month, day, 12)))).toBeLessThan(1);
    }
  });
});

describe('sun altitude', () => {
  it('sits at the declination all day at the north pole', () => {
    // There is no sunrise and no sunset at the pole: the sun circles the
    // horizon at a constant height, which is the declination itself.
    const declination = solarDeclinationDegrees(utc(2026, 6, 21, 12));
    for (const hour of [0, 6, 12, 18]) {
      expect(sunAltitudeDegrees(utc(2026, 6, 21, hour), { lat: 90, lon: 0 })).toBeCloseTo(
        declination,
        1,
      );
    }
  });

  it('is below the horizon all day at the north pole in December', () => {
    expect(maxAltitudeOnDay(utc(2026, 12, 21), 90, 0)).toBeCloseTo(-23.44, 1);
  });

  it('peaks at 90 − |lat − declination|, wherever you stand', () => {
    // The transit altitude identity. It holds at every latitude, which is what
    // makes it a real test of the latitude and hour-angle arithmetic rather
    // than of one hand-picked place.
    const date = utc(2026, 6, 21);
    const declination = solarDeclinationDegrees(utc(2026, 6, 21, 12));
    for (const lat of [-45, -10, 0, 23.44, 51.48, 69.65]) {
      const expected = 90 - Math.abs(lat - declination);
      expect(maxAltitudeOnDay(date, lat, 0)).toBeCloseTo(expected, 1);
    }
  });

  it('gives the same sun on the far side of the world half a day later', () => {
    // Longitude and time are the same thing seen twice. If the 4-minutes-per-
    // degree conversion were wrong, these would not agree at all.
    //
    // Taken at a solstice, where the declination is momentarily stationary:
    // half a day apart at any other time of year the sun genuinely HAS moved
    // (up to 0.2° near an equinox), and a tighter tolerance would be asserting
    // that the seasons do not change.
    const here = sunAltitudeDegrees(utc(2026, 6, 21, 12), { lat: 10, lon: 0 });
    const there = sunAltitudeDegrees(utc(2026, 6, 21, 0), { lat: 10, lon: 180 });
    expect(Math.abs(there - here)).toBeLessThan(0.1);
  });

  it('takes 24 minutes to fall from the horizon to civil twilight on the equator', () => {
    // The end-to-end physics check. On the equator at an equinox the sun sets
    // straight down at 15° per hour, so 6° takes exactly 24 minutes. Nothing
    // in the pipeline can be wrong and still produce this.
    const date = utc(2026, 3, 20);
    const equator = { lat: 0, lon: 0 };
    const sunset = firstCrossingBelow(date, equator, 0, 12 * 3600);
    const twilightEnd = firstCrossingBelow(date, equator, CIVIL_TWILIGHT_DEGREES, sunset);

    expect(sunset).toBeGreaterThan(0);
    expect((twilightEnd - sunset) / 60).toBeCloseTo(24, 0);
  });

  it('leaves Tromsø in twilight rather than darkness at midwinter noon', () => {
    // 69.65°N on the December solstice: the sun peaks at 90 − 69.65 − 23.44 =
    // −3.09°, so it never rises, and it never gets properly dark at midday
    // either. A pilot landing there at noon in December lands in twilight,
    // which the logbook counts as day.
    const max = maxAltitudeOnDay(utc(2026, 12, 21), 69.65, 18.96);
    expect(max).toBeCloseTo(-3.09, 1);
    expect(max).toBeLessThan(0); // polar night: the sun does not rise
    expect(max).toBeGreaterThan(CIVIL_TWILIGHT_DEGREES); // but it is not night
  });

  it('reads longitude east-positive', () => {
    // Noon UTC is midday at Greenwich and evening in Asia, not the other way
    // round. A flipped longitude sign is the classic silent bug here.
    const greenwich = sunAltitudeDegrees(utc(2026, 3, 20, 12), { lat: 0, lon: 0 });
    const east = sunAltitudeDegrees(utc(2026, 3, 20, 12), { lat: 0, lon: 90 });
    const west = sunAltitudeDegrees(utc(2026, 3, 20, 12), { lat: 0, lon: -90 });

    expect(greenwich).toBeGreaterThan(80); // overhead
    // Both a quarter-turn away are within a couple of degrees of the horizon —
    // not exactly on it, because the equation of time is about −7 minutes in
    // late March and that is worth nearly two degrees of rotation.
    expect(Math.abs(east)).toBeLessThan(3);
    expect(Math.abs(west)).toBeLessThan(3);
    expect(east).toBeCloseTo(-west, 0);

    // Which of the two is setting is what the sign of the longitude decides.
    const eastLater = sunAltitudeDegrees(utc(2026, 3, 20, 12, 10), { lat: 0, lon: 90 });
    const westLater = sunAltitudeDegrees(utc(2026, 3, 20, 12, 10), { lat: 0, lon: -90 });
    expect(eastLater).toBeLessThan(east); // east is heading for the night
    expect(westLater).toBeGreaterThan(west); // west is coming out of it
  });

  it('answers NaN for nonsense rather than a plausible-looking number', () => {
    expect(sunAltitudeDegrees(new Date(NaN), { lat: 0, lon: 0 })).toBeNaN();
    expect(sunAltitudeDegrees(utc(2026, 6, 21, 12), { lat: NaN, lon: 0 })).toBeNaN();
    expect(sunAltitudeDegrees(utc(2026, 6, 21, 12), { lat: 0, lon: NaN })).toBeNaN();
  });

  it('never answers NaN at the poles, where the arithmetic runs to the limit', () => {
    for (const lat of [90, -90]) {
      for (const hour of [0, 6, 12, 18]) {
        expect(sunAltitudeDegrees(utc(2026, 6, 21, hour), { lat, lon: 0 })).not.toBeNaN();
      }
    }
  });
});

describe('the civil twilight threshold', () => {
  it('is −6 degrees, and is the one place the definition lives', () => {
    expect(CIVIL_TWILIGHT_DEGREES).toBe(-6);
  });
});
