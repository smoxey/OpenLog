import { describe, it, expect } from 'vitest';
import { computeNightTime, isNightAt, suggestNightMinutes, type NightDetail } from './night';
import { interpolateGreatCircle } from './greatCircle';
import type { Coordinates } from './solar';

const ENGM: Coordinates = { lat: 60.1939, lon: 11.1004 }; // Oslo
const EGLL: Coordinates = { lat: 51.4775, lon: -0.4614 }; // London Heathrow
const ENTC: Coordinates = { lat: 69.6833, lon: 18.9189 }; // Tromsø — inside the Arctic Circle
const EQUATOR: Coordinates = { lat: 0, lon: 0 };
const EGKK: Coordinates = { lat: 51.1481, lon: -0.1903 }; // London Gatwick

/** Unwrap a result that is expected to have worked. */
function night(input: Parameters<typeof computeNightTime>[0]): NightDetail {
  const result = computeNightTime(input);
  if (!result.ok) throw new Error(`expected a result, got ${result.reason}`);
  return result;
}

describe('a flight that is entirely one thing', () => {
  it('logs no night for a summer midday sector', () => {
    const result = night({
      date: '2026-06-21',
      offBlock: '10:00',
      onBlock: '12:00',
      departure: ENGM,
      arrival: EGLL,
    });

    expect(result.allDay).toBe(true);
    expect(result.nightMinutes).toBe(0);
    expect(result.segments).toEqual([]);
    expect(result.departureIsNight).toBe(false);
    expect(result.arrivalIsNight).toBe(false);
  });

  it('logs the whole block time for a midwinter sector across midnight', () => {
    const result = night({
      date: '2026-12-21',
      offBlock: '23:00',
      onBlock: '01:00',
      departure: ENGM,
      arrival: EGLL,
    });

    expect(result.allNight).toBe(true);
    expect(result.elapsedMinutes).toBe(120); // the flight landed on the 22nd
    expect(result.nightMinutes).toBe(120);
    expect(result.departureIsNight).toBe(true);
    expect(result.arrivalIsNight).toBe(true);
  });

  it('answers differently for the same route and times in a different season', () => {
    // A local detail out of Oslo, same clock times, six months apart. At 60°N
    // the midsummer sun dips only just past civil twilight around midnight,
    // and at midwinter it is four hours of darkness.
    const input = {
      offBlock: '22:00',
      onBlock: '02:00',
      departure: ENGM,
      arrival: ENGM,
    };
    const june = night({ ...input, date: '2026-06-21' });
    const december = night({ ...input, date: '2026-12-21' });

    expect(december.allNight).toBe(true);
    expect(december.nightMinutes).toBe(240);
    expect(june.nightMinutes).toBeGreaterThan(0);
    expect(june.nightMinutes).toBeLessThan(120);
  });
});

describe('a flight that crosses the terminator', () => {
  it('takes off in daylight and lands in night', () => {
    const result = night({
      date: '2026-12-21',
      offBlock: '15:00',
      onBlock: '17:00',
      departure: ENGM,
      arrival: EGLL,
    });

    expect(result.departureIsNight).toBe(false);
    expect(result.arrivalIsNight).toBe(true);
    expect(result.segments).toHaveLength(1);
    // One stretch of night, running from the crossing to the end of the flight.
    expect(result.segments[0].end).toBe(result.elapsedMinutes);
    expect(result.segments[0].start).toBeGreaterThan(0);
    expect(result.nightMinutes).toBeGreaterThan(60);
    expect(result.nightMinutes).toBeLessThan(100);
  });

  it('places the crossing where a second-by-second scan places it', () => {
    // The independent check on all the segment bookkeeping and the bisection:
    // walk the flight one second at a time asking `isNightAt` directly, and
    // count. Same physics, completely different arithmetic.
    const input = {
      date: '2026-12-21',
      offBlock: '15:00',
      onBlock: '17:00',
      departure: ENGM,
      arrival: EGLL,
    };
    const result = night(input);

    const startMs = Date.UTC(2026, 11, 21, 15, 0, 0);
    let nightSeconds = 0;
    for (let second = 0; second < result.elapsedMinutes * 60; second++) {
      const fraction = second / 60 / result.elapsedMinutes;
      const where = interpolateGreatCircle(input.departure, input.arrival, fraction);
      // The half-second midpoint of each one-second slice, so the count is not
      // biased by which end of the slice is sampled.
      if (isNightAt(new Date(startMs + second * 1000 + 500), where)) nightSeconds++;
    }

    expect(result.nightMinutes).toBeCloseTo(nightSeconds / 60, 1);
  });

  it('depends on which way the aircraft is going', () => {
    // Two flights leaving the same place at the same moment, one east and one
    // west, the same distance. The westbound one chases the sunset and stays
    // in daylight; the eastbound one flies into the dark.
    //
    // If the calculation ignored the route and used the departure aerodrome
    // throughout, these two would be identical. That is what this test is for.
    const common = { date: '2026-03-20', offBlock: '17:45', onBlock: '19:45' };
    const eastbound = night({ ...common, departure: EQUATOR, arrival: { lat: 0, lon: 30 } });
    const westbound = night({ ...common, departure: EQUATOR, arrival: { lat: 0, lon: -30 } });

    expect(eastbound.nightMinutes).toBeGreaterThan(60);
    expect(westbound.allDay).toBe(true);
  });

  it('starts night 24 minutes after sunset on the equator', () => {
    // A "flight" that stays put on the equator at an equinox, straddling
    // sunset. The sun goes down vertically at 15° an hour there, so civil
    // twilight lasts 24 minutes — the same figure the solar tests pin down,
    // now arrived at through the whole night pipeline instead.
    const result = night({
      date: '2026-03-20',
      offBlock: '18:00',
      onBlock: '19:00',
      departure: EQUATOR,
      arrival: EQUATOR,
    });

    const startMs = Date.UTC(2026, 2, 20, 18, 0, 0);
    let sunsetMinute = -1;
    for (let second = 0; second < 3600 && sunsetMinute < 0; second++) {
      const altitudeIsNegative =
        interpolateGreatCircle(EQUATOR, EQUATOR, 0) && // stationary
        isNightAt(new Date(startMs + second * 1000), EQUATOR);
      if (altitudeIsNegative) sunsetMinute = second / 60;
    }

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].start).toBeCloseTo(sunsetMinute, 1);
    expect(result.nightMinutes).toBeCloseTo(60 - result.segments[0].start, 6);
  });
});

describe('inside the Arctic Circle', () => {
  it('does not call the polar night "night" when it is only twilight', () => {
    // Tromsø on the December solstice: the sun never rises, peaking at −3.1°.
    // It is dusk all day, and dusk is not night — the sun has to be 6° down.
    // This is the case that separates "the sun is below the horizon" from the
    // definition the logbook actually uses, and getting it wrong would hand a
    // Nordic pilot several hours of night time they did not fly.
    const result = night({
      date: '2026-12-21',
      offBlock: '10:30',
      onBlock: '12:30',
      departure: ENTC,
      arrival: ENTC,
    });

    expect(result.allDay).toBe(true);
    expect(result.nightMinutes).toBe(0);
  });

  it('logs no night under the midnight sun', () => {
    const result = night({
      date: '2026-06-21',
      offBlock: '22:00',
      onBlock: '02:00',
      departure: ENTC,
      arrival: ENTC,
    });

    expect(result.allDay).toBe(true);
    expect(result.elapsedMinutes).toBe(240);
  });

  it('still finds night either side of the polar twilight', () => {
    const result = night({
      date: '2026-12-21',
      offBlock: '10:00',
      onBlock: '16:00',
      departure: ENTC,
      arrival: ENTC,
    });

    expect(result.allDay).toBe(false);
    expect(result.nightMinutes).toBeGreaterThan(0);
    expect(result.arrivalIsNight).toBe(true);
  });
});

describe('when the answer is too close to call', () => {
  it('flags a Nordic summer night, where the sun sits just under the threshold', () => {
    // Oslo at midsummer: the sun dips barely past −6° around midnight. An hour
    // either side of the answer is a matter of a few tenths of a degree, and
    // the pilot's own logbook may legitimately disagree.
    const result = night({
      date: '2026-06-21',
      offBlock: '22:00',
      onBlock: '02:00',
      departure: ENGM,
      arrival: ENGM,
    });

    expect(result.nightMinutes).toBeGreaterThan(0);
    expect(result.grazing).toBe(true);
  });

  it('does not flag an ordinary crossing, where the sun keeps going down', () => {
    const result = night({
      date: '2026-12-21',
      offBlock: '15:00',
      onBlock: '17:00',
      departure: ENGM,
      arrival: EGLL,
    });

    expect(result.grazing).toBe(false);
  });

  it('does not flag a flight in broad daylight', () => {
    const result = night({
      date: '2026-06-21',
      offBlock: '10:00',
      onBlock: '12:00',
      departure: ENGM,
      arrival: EGLL,
    });

    expect(result.grazing).toBe(false);
  });
});

/**
 * Which column the LANDING goes in, as opposed to how much night was flown.
 *
 * The two are separate questions with separate uncertainties. Night minutes are
 * measured between two times the logbook actually records; the landing happened
 * at a time it does not — somewhere in the taxi before block-in. Civil twilight
 * at Heathrow on 21 September 2027 ends at about 18:37 UTC, which is what every
 * on-block time below is placed around.
 */
describe('which column the landing belongs in', () => {
  const sector = (offBlock: string, onBlock: string): NightDetail =>
    night({ date: '2027-09-21', offBlock, onBlock, departure: ENGM, arrival: EGLL });

  it('flags the landing when twilight fell inside the taxi window', () => {
    // Blocks in eight minutes after dark, so the wheels may well have touched
    // down before it. The app still picks a column — it just says it guessed.
    const result = sector('16:55', '18:45');

    expect(result.arrivalIsNight).toBe(true);
    expect(result.arrivalUncertain).toBe(true);
  });

  it('flags it on the other side of the crossing too', () => {
    // Blocks in two minutes BEFORE dark, and the landing was earlier still —
    // so this one is a day landing, and equally a guess.
    const result = sector('16:35', '18:35');

    expect(result.arrivalIsNight).toBe(false);
    expect(result.arrivalUncertain).toBe(true);
  });

  it('does not flag a landing well clear of twilight', () => {
    // Half an hour into the dark. No taxi puts this one in daylight.
    const nightLanding = sector('17:10', '19:10');
    expect(nightLanding.arrivalIsNight).toBe(true);
    expect(nightLanding.arrivalUncertain).toBe(false);

    // …and the middle of the afternoon is not a close call either.
    const dayLanding = sector('13:00', '15:00');
    expect(dayLanding.arrivalIsNight).toBe(false);
    expect(dayLanding.arrivalUncertain).toBe(false);
  });

  it('never winds the clock back further than off-block', () => {
    // The same block-in time, once on a short hop and once on a long one. On a
    // ten-minute sector the landing was inside those ten minutes, whatever a
    // long taxi at a large aerodrome usually costs — so the answer is safe.
    const short = night({
      date: '2027-09-21',
      offBlock: '18:40',
      onBlock: '18:50',
      departure: EGKK,
      arrival: EGLL,
    });
    const long = night({
      date: '2027-09-21',
      offBlock: '18:20',
      onBlock: '18:50',
      departure: EGKK,
      arrival: EGLL,
    });

    expect(short.arrivalIsNight).toBe(true);
    expect(short.arrivalUncertain).toBe(false);
    expect(long.arrivalUncertain).toBe(true);
  });

  it('is a different question from grazing', () => {
    // A midwinter sector into Heathrow: an hour and a quarter of unambiguous
    // night in it, and a block-in nowhere near the boundary.
    const result = night({
      date: '2026-12-21',
      offBlock: '15:00',
      onBlock: '17:00',
      departure: ENGM,
      arrival: EGLL,
    });

    expect(result.nightMinutes).toBeGreaterThan(60);
    expect(result.grazing).toBe(false);
    expect(result.arrivalUncertain).toBe(false);
  });
});

describe('the segments themselves', () => {
  it('are ordered, disjoint, inside the flight, and add up to the total', () => {
    const result = night({
      date: '2026-01-15',
      offBlock: '10:00',
      onBlock: '04:00', // an eighteen-hour sector to Sydney
      departure: ENGM,
      arrival: { lat: -33.9461, lon: 151.1772 },
    });

    expect(result.segments.length).toBeGreaterThan(0);
    let previousEnd = 0;
    let sum = 0;
    for (const segment of result.segments) {
      expect(segment.start).toBeGreaterThanOrEqual(previousEnd);
      expect(segment.end).toBeGreaterThan(segment.start);
      expect(segment.end).toBeLessThanOrEqual(result.elapsedMinutes);
      sum += segment.end - segment.start;
      previousEnd = segment.end;
    }
    expect(sum).toBeCloseTo(result.nightMinutes, 9);
  });

  it('costs little enough to run on a form', () => {
    // One sun evaluation per minute of block time. The budget here is loose on
    // purpose — it is guarding against an accidental O(n²), not measuring a
    // machine. In practice an eighteen-hour sector takes about two
    // milliseconds.
    const started = performance.now();
    for (let i = 0; i < 20; i++) {
      night({
        date: '2026-01-15',
        offBlock: '10:00',
        onBlock: '04:00',
        departure: ENGM,
        arrival: { lat: -33.9461, lon: 151.1772 },
      });
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('what it refuses to answer', () => {
  const good = {
    date: '2026-12-21',
    offBlock: '15:00',
    onBlock: '17:00',
    departure: ENGM,
    arrival: EGLL,
  };

  it('rejects a date that is not one', () => {
    expect(computeNightTime({ ...good, date: '' })).toEqual({ ok: false, reason: 'badDate' });
    expect(computeNightTime({ ...good, date: '2026-02-31' })).toEqual({
      ok: false,
      reason: 'badDate',
    });
  });

  it('rejects half-typed times rather than guessing at them', () => {
    // This runs on a form the pilot is still filling in, so a partial time is
    // an ordinary state, not an error to shout about.
    expect(computeNightTime({ ...good, offBlock: '1' })).toEqual({ ok: false, reason: 'badTimes' });
    expect(computeNightTime({ ...good, onBlock: '25:00' })).toEqual({
      ok: false,
      reason: 'badTimes',
    });
  });

  it('rejects an aerodrome it has no coordinates for', () => {
    expect(computeNightTime({ ...good, departure: { lat: NaN, lon: NaN } })).toEqual({
      ok: false,
      reason: 'badCoordinates',
    });
    expect(computeNightTime({ ...good, arrival: { lat: 91, lon: 0 } })).toEqual({
      ok: false,
      reason: 'badCoordinates',
    });
  });

  it('never throws, whatever it is handed', () => {
    const rubbish = {
      date: 'yesterday',
      offBlock: 'noon',
      onBlock: '???',
      departure: { lat: 999, lon: -999 },
      arrival: { lat: NaN, lon: NaN },
    };
    expect(() => computeNightTime(rubbish)).not.toThrow();
    expect(computeNightTime(rubbish).ok).toBe(false);
  });
});

describe('a zero-duration entry', () => {
  it('has no night time but still knows whether it was dark', () => {
    // The aborted-before-taxi case, which exists in the sample logbook.
    const result = night({
      date: '2026-12-21',
      offBlock: '23:00',
      onBlock: '23:00',
      departure: ENGM,
      arrival: ENGM,
    });

    expect(result.elapsedMinutes).toBe(0);
    expect(result.nightMinutes).toBe(0);
    expect(result.segments).toEqual([]);
    expect(result.departureIsNight).toBe(true);
    expect(result.arrivalIsNight).toBe(true);
    expect(result.allNight).toBe(false); // there was no time for it to be night IN
    // No block time means no taxi to be uncertain about: the only thing that
    // could make this landing a close call is the sun sitting on the threshold.
    expect(result.arrivalUncertain).toBe(false);
  });
});

describe('turning night flown into night logged', () => {
  const detail = (over: Partial<NightDetail>): NightDetail => ({
    nightMinutes: 0,
    elapsedMinutes: 120,
    segments: [],
    departureIsNight: false,
    arrivalIsNight: false,
    allNight: false,
    allDay: true,
    grazing: false,
    arrivalUncertain: false,
    ...over,
  });

  it('rounds to the nearest tenth of an hour, like every other duration', () => {
    expect(suggestNightMinutes(detail({ nightMinutes: 28.65 }), 120)).toBe(30);
    expect(suggestNightMinutes(detail({ nightMinutes: 61 }), 120)).toBe(60);
    expect(suggestNightMinutes(detail({ nightMinutes: 64 }), 120)).toBe(66);
  });

  it('gives the total exactly when the whole flight was night', () => {
    // Not a computed 118.4 against a logged 120: if every moment of it was
    // night then the night time IS the total, whatever the block times
    // happened to round to.
    const wholeFlight = detail({ nightMinutes: 118.4, allNight: true, allDay: false });
    expect(suggestNightMinutes(wholeFlight, 120)).toBe(120);
    expect(suggestNightMinutes(wholeFlight, 114)).toBe(114);
  });

  it('never suggests more night than there was flight', () => {
    // `validateFlight` has rejected night above the total since Phase 1, so a
    // suggestion that broke the rule would be a suggestion that cannot be saved.
    expect(suggestNightMinutes(detail({ nightMinutes: 119.6 }), 114)).toBe(114);
  });

  it('falls back to the block time when no total has been entered yet', () => {
    expect(suggestNightMinutes(detail({ nightMinutes: 200, elapsedMinutes: 120 }), 0)).toBe(120);
  });

  it('suggests nothing when there is nothing to suggest', () => {
    expect(suggestNightMinutes(detail({ nightMinutes: 0 }), 120)).toBe(0);
    expect(suggestNightMinutes(detail({ nightMinutes: 2 }), 120)).toBe(0); // under a tenth
    expect(suggestNightMinutes(detail({ elapsedMinutes: 0 }), 0)).toBe(0);
  });
});

describe('the definition of night', () => {
  it('is the one function everything else asks', () => {
    // Six degrees below the horizon, and not the horizon itself. At Tromsø at
    // midwinter noon the sun is below the horizon and it is NOT night.
    const midwinterNoon = new Date(Date.UTC(2026, 11, 21, 11, 30));
    expect(isNightAt(midwinterNoon, ENTC)).toBe(false);

    const midwinterMidnight = new Date(Date.UTC(2026, 11, 21, 23, 30));
    expect(isNightAt(midwinterMidnight, ENTC)).toBe(true);
  });
});
