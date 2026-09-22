import { describe, it, expect } from 'vitest';
import {
  greatCircleDistanceNm,
  interpolateGreatCircle,
  isValidCoordinates,
  type Coordinates,
} from './greatCircle';

const ENGM: Coordinates = { lat: 60.1939, lon: 11.1004 }; // Oslo
const EGLL: Coordinates = { lat: 51.4775, lon: -0.4614 }; // London Heathrow
const RJTT: Coordinates = { lat: 35.5533, lon: 139.7811 }; // Tokyo Haneda
const KLAX: Coordinates = { lat: 33.9425, lon: -118.408 }; // Los Angeles

describe('great-circle distance', () => {
  it('is a quarter of the way round the world from the equator to the pole', () => {
    // 90° of latitude = 5,400 nautical miles, by the definition of the mile.
    expect(greatCircleDistanceNm({ lat: 0, lon: 0 }, { lat: 90, lon: 0 })).toBeCloseTo(5400, -1);
  });

  it('is one nautical mile per minute of latitude', () => {
    // The definition the unit is named for. A degree is 60 nm.
    expect(greatCircleDistanceNm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(60, 0);
  });

  it('is zero between a point and itself', () => {
    expect(greatCircleDistanceNm(ENGM, ENGM)).toBeCloseTo(0, 6);
  });

  it('is symmetric', () => {
    expect(greatCircleDistanceNm(ENGM, RJTT)).toBeCloseTo(greatCircleDistanceNm(RJTT, ENGM), 6);
  });

  it('gets a real route about right', () => {
    // Oslo to Heathrow is a bit over 600 nm; Oslo to Tokyo a bit over 4,600.
    expect(greatCircleDistanceNm(ENGM, EGLL)).toBeGreaterThan(590);
    expect(greatCircleDistanceNm(ENGM, EGLL)).toBeLessThan(660);
    expect(greatCircleDistanceNm(ENGM, RJTT)).toBeGreaterThan(4400);
    expect(greatCircleDistanceNm(ENGM, RJTT)).toBeLessThan(4900);
  });

  it('answers NaN for a coordinate that is not one', () => {
    expect(greatCircleDistanceNm({ lat: 200, lon: 0 }, ENGM)).toBeNaN();
    expect(greatCircleDistanceNm({ lat: NaN, lon: 0 }, ENGM)).toBeNaN();
  });
});

describe('interpolating along the path', () => {
  it('returns the endpoints exactly', () => {
    expect(interpolateGreatCircle(ENGM, RJTT, 0)).toEqual(ENGM);
    expect(interpolateGreatCircle(ENGM, RJTT, 1)).toEqual(RJTT);
  });

  it('clamps a fraction outside the flight to its endpoints', () => {
    expect(interpolateGreatCircle(ENGM, RJTT, -0.5)).toEqual(ENGM);
    expect(interpolateGreatCircle(ENGM, RJTT, 2)).toEqual(RJTT);
  });

  it('puts the halfway point of two equatorial points halfway between them', () => {
    const mid = interpolateGreatCircle({ lat: 0, lon: 0 }, { lat: 0, lon: 90 }, 0.5);
    expect(mid.lat).toBeCloseTo(0, 6);
    expect(mid.lon).toBeCloseTo(45, 6);
  });

  it('bulges towards the pole between two points on the same parallel', () => {
    // The reason a great circle is not a straight line on a map, and the reason
    // this cannot be done by averaging latitudes: the shortest path between
    // two points at 60°N runs NORTH of 60°N.
    const mid = interpolateGreatCircle({ lat: 60, lon: -30 }, { lat: 60, lon: 30 }, 0.5);
    expect(mid.lat).toBeGreaterThan(60);
    expect(mid.lon).toBeCloseTo(0, 6);
  });

  it('crosses the antimeridian without coming out at the wrong longitude', () => {
    // Tokyo to Los Angeles crosses 180°. Averaging longitudes would send the
    // aircraft the long way round, over Africa.
    const mid = interpolateGreatCircle(RJTT, KLAX, 0.5);
    const eastOfDateLine = mid.lon > 150;
    const westOfDateLine = mid.lon < -150;
    expect(eastOfDateLine || westOfDateLine).toBe(true);
    expect(mid.lat).toBeGreaterThan(35); // the great circle arcs north
  });

  it('divides the path into equal parts', () => {
    // Ten equal steps should each be a tenth of the total. This is what makes
    // "a constant fraction of the path per minute" mean constant ground speed.
    const total = greatCircleDistanceNm(ENGM, RJTT);
    let previous = ENGM;
    for (let i = 1; i <= 10; i++) {
      const next = interpolateGreatCircle(ENGM, RJTT, i / 10);
      expect(greatCircleDistanceNm(previous, next)).toBeCloseTo(total / 10, 3);
      previous = next;
    }
  });

  it('keeps a local flight at its aerodrome', () => {
    // A circuit detail departs and lands at the same place. There is no path,
    // and dividing by its length must not produce NaN.
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const point = interpolateGreatCircle(ENGM, ENGM, fraction);
      expect(point.lat).toBeCloseTo(ENGM.lat, 6);
      expect(point.lon).toBeCloseTo(ENGM.lon, 6);
    }
  });

  it('stays finite between antipodal points, which have no unique path', () => {
    // Documented as stable rather than correct: no two aerodromes are
    // antipodal, and the question itself has no answer.
    const point = interpolateGreatCircle({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }, 0.5);
    expect(Number.isFinite(point.lat)).toBe(true);
    expect(Number.isFinite(point.lon)).toBe(true);
  });

  it('answers NaN for a coordinate that is not one', () => {
    const point = interpolateGreatCircle({ lat: 91, lon: 0 }, ENGM, 0.5);
    expect(point.lat).toBeNaN();
    expect(point.lon).toBeNaN();
  });
});

describe('coordinate validation', () => {
  it('accepts the extremes and rejects what is past them', () => {
    expect(isValidCoordinates({ lat: 90, lon: 180 })).toBe(true);
    expect(isValidCoordinates({ lat: -90, lon: -180 })).toBe(true);
    expect(isValidCoordinates({ lat: 90.1, lon: 0 })).toBe(false);
    expect(isValidCoordinates({ lat: 0, lon: 180.1 })).toBe(false);
    expect(isValidCoordinates({ lat: NaN, lon: 0 })).toBe(false);
    expect(isValidCoordinates(undefined)).toBe(false);
  });
});
