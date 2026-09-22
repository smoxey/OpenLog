import { describe, it, expect } from 'vitest';
import { assumedLines, exactlyResolvedCount, resolveZoneOffsets, type ZoneRow } from './zones';

/**
 * A row, written the way the file writes one: local times at each end, and a
 * total that is the TRUE elapsed time. `onMinutes` is what a clock at the
 * arrival aerodrome read, so the gap between the naive interval and the total
 * is the difference between the two zones — which is the whole mechanism.
 */
function row(
  line: number,
  departure: string,
  arrival: string,
  date: string,
  off: string,
  on: string,
  total: number,
  arrivalDate = date,
): ZoneRow {
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  return {
    line,
    departure,
    arrival,
    date,
    offMinutes: minutes(off),
    arrivalDate,
    onMinutes: minutes(on),
    totalMinutes: total,
  };
}

const OSLO = new Map([['OSL', 'Europe/Oslo']]);

describe('an anchored departure', () => {
  it('reads the offset straight off the zone', () => {
    // 15 January is winter: Oslo is CET, UTC+01:00.
    const rows = [row(2, 'OSL', 'BGO', '2024-01-15', '08:00', '08:55', 55)];
    const resolution = resolveZoneOffsets(rows, OSLO, 'OSL');
    expect(resolution.byLine.get(2)).toEqual({
      offsetMinutes: 60,
      source: 'anchor',
      gapMinutes: 0,
    });
  });

  it('follows the zone across a daylight-saving change', () => {
    // The same aerodrome, six months apart, from one answer.
    const rows = [
      row(2, 'OSL', 'BGO', '2024-01-15', '08:00', '08:55', 55),
      row(3, 'OSL', 'BGO', '2024-07-15', '08:00', '08:55', 55),
    ];
    const resolution = resolveZoneOffsets(rows, OSLO, 'OSL');
    expect(resolution.byLine.get(2)?.offsetMinutes).toBe(60);
    expect(resolution.byLine.get(3)?.offsetMinutes).toBe(120);
  });
});

describe('an anchored arrival', () => {
  it('works the departure out from the row´s own numbers', () => {
    // London to Oslo in February: 17:05 UTC+0 to 20:20 UTC+1 is 195 minutes on
    // the clock and 135 in the air, so the gap is +60 and London is UTC+0.
    const rows = [row(2, 'LHR', 'OSL', '2024-02-10', '17:05', '20:20', 135)];
    const resolution = resolveZoneOffsets(rows, OSLO, 'OSL');
    expect(resolution.byLine.get(2)).toEqual({
      offsetMinutes: 0,
      source: 'route',
      gapMinutes: 60,
    });
  });

  it('handles a sector that lands on the following day', () => {
    const rows = [row(2, 'LPA', 'OSL', '2024-07-15', '22:40', '05:00', 320, '2024-07-16')];
    const resolution = resolveZoneOffsets(rows, OSLO, 'OSL');
    // Oslo is UTC+2 in July and the gap is +60, so Gran Canaria is UTC+1.
    expect(resolution.byLine.get(2)?.offsetMinutes).toBe(60);
    expect(resolution.byLine.get(2)?.source).toBe('route');
  });
});

describe('spreading one answer across a file', () => {
  it('carries an offset to another row on the same day', () => {
    const rows = [
      // Solves London for 10 February…
      row(2, 'LHR', 'OSL', '2024-02-10', '17:05', '20:20', 135),
      // …which is what this row was waiting for.
      row(3, 'LHR', 'CDG', '2024-02-10', '09:00', '11:15', 75),
    ];
    const resolution = resolveZoneOffsets(rows, OSLO, 'OSL');
    expect(resolution.byLine.get(3)?.source).toBe('propagated');
    expect(resolution.byLine.get(3)?.offsetMinutes).toBe(0);
    expect(exactlyResolvedCount(resolution)).toBe(2);
  });

  it('does not carry an offset to a DIFFERENT day', () => {
    // A zone's offset is not a constant, and the one day it changes is the day
    // this shortcut would be wrong on. Nothing brackets it either, because a
    // single observation on one side proves nothing about the other.
    const rows = [
      row(2, 'LHR', 'OSL', '2024-02-10', '17:05', '20:20', 135),
      row(3, 'LHR', 'CDG', '2024-08-10', '09:00', '11:15', 75),
    ];
    const resolution = resolveZoneOffsets(rows, OSLO, 'OSL');
    expect(resolution.byLine.get(3)?.source).toBe('assumed');
  });

  it('bridges a date that two matching observations surround', () => {
    const rows = [
      row(2, 'LHR', 'OSL', '2024-02-01', '17:05', '20:20', 135),
      row(3, 'LHR', 'OSL', '2024-02-20', '17:05', '20:20', 135),
      // Nothing anchors this one and nothing else flew that day, but London
      // read UTC+0 on either side of it, so it read UTC+0 in between.
      row(4, 'LHR', 'CDG', '2024-02-10', '09:00', '11:15', 75),
    ];
    const resolution = resolveZoneOffsets(rows, OSLO, 'OSL');
    expect(resolution.byLine.get(4)?.source).toBe('bracketed');
    expect(resolution.byLine.get(4)?.offsetMinutes).toBe(0);
  });

  it('refuses to bridge a date the observations disagree across', () => {
    // London in February and London in August are not the same offset, so the
    // date between them is exactly the one nothing can be said about.
    const rows = [
      row(2, 'LHR', 'OSL', '2024-02-01', '17:05', '20:20', 135),
      row(3, 'LHR', 'OSL', '2024-08-01', '17:05', '20:20', 135),
      row(4, 'LHR', 'CDG', '2024-05-01', '09:00', '11:15', 75),
    ];
    const resolution = resolveZoneOffsets(rows, OSLO, 'OSL');
    expect(resolution.byLine.get(4)?.source).toBe('assumed');
  });
});

describe('what it cannot work out', () => {
  it('falls back to the primary anchor and says so', () => {
    const rows = [row(2, 'ARN', 'TLL', '2024-02-20', '06:15', '08:25', 70)];
    const resolution = resolveZoneOffsets(rows, OSLO, 'OSL');
    expect(resolution.byLine.get(2)?.source).toBe('assumed');
    expect(assumedLines(resolution)).toEqual([2]);
    expect(exactlyResolvedCount(resolution)).toBe(0);
  });

  it('reports rather than guesses when there is no anchor at all', () => {
    const rows = [row(2, 'ARN', 'TLL', '2024-02-20', '06:15', '08:25', 70)];
    const resolution = resolveZoneOffsets(rows, new Map(), null);
    expect(resolution.byLine.get(2)).toEqual({
      offsetMinutes: 0,
      source: 'none',
      gapMinutes: 60,
    });
  });

  it('names a row whose numbers no pair of zones could explain', () => {
    // 83 minutes on the clock against a 60-minute total is a 23-minute gap, and
    // no two places on earth are 23 minutes apart.
    const rows = [row(2, 'OSL', 'CPH', '2024-03-12', '10:00', '11:23', 60)];
    const resolution = resolveZoneOffsets(rows, OSLO, 'OSL');
    expect(resolution.oddGapLines).toEqual([2]);
    // Still resolved, because the DEPARTURE is anchored and needs no gap.
    expect(resolution.byLine.get(2)?.source).toBe('anchor');
    expect(resolution.byLine.get(2)?.gapMinutes).toBeNull();
  });

  it('never reasons about other rows from an impossible gap', () => {
    const rows = [
      // An anchored departure with a gap that cannot be true. Its arrival must
      // NOT be published as an observation, or the error spreads.
      row(2, 'OSL', 'CPH', '2024-03-12', '10:00', '11:23', 60),
      row(3, 'CPH', 'ARN', '2024-03-12', '13:00', '14:10', 70),
    ];
    const resolution = resolveZoneOffsets(rows, OSLO, 'OSL');
    expect(resolution.byLine.get(3)?.source).toBe('assumed');
  });

  it('reports an aerodrome the file gives two offsets for on one day', () => {
    const rows = [
      row(2, 'OSL', 'ZZZ', '2024-02-10', '08:00', '09:00', 60),
      // The same aerodrome, the same day, an hour out.
      row(3, 'OSL', 'ZZZ', '2024-02-10', '14:00', '16:00', 60),
    ];
    const resolution = resolveZoneOffsets(rows, OSLO, 'OSL');
    expect(resolution.contradictions).toEqual(['ZZZ']);
  });
});

describe('counting', () => {
  it('adds up to the number of rows, whatever happened to them', () => {
    const rows = [
      row(2, 'OSL', 'BGO', '2024-01-15', '08:00', '08:55', 55),
      row(3, 'LHR', 'OSL', '2024-02-10', '17:05', '20:20', 135),
      row(4, 'ARN', 'TLL', '2024-02-20', '06:15', '08:25', 70),
    ];
    const resolution = resolveZoneOffsets(rows, OSLO, 'OSL');
    const total = Object.values(resolution.counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(3);
    expect(resolution.byLine.size).toBe(3);
  });
});
