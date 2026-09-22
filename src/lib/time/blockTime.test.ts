import { describe, it, expect } from 'vitest';
import {
  addDays,
  dayNumberToIsoDate,
  elapsedMinutes,
  isoDateToDayNumber,
  localIsoDate,
  suggestTotalMinutes,
} from './blockTime';

describe('elapsedMinutes', () => {
  it('computes a normal same-day interval', () => {
    expect(elapsedMinutes('10:00', '11:30')).toBe(90);
  });

  it('handles crossing midnight', () => {
    expect(elapsedMinutes('23:30', '01:10')).toBe(100);
    expect(elapsedMinutes('23:30', '01:12')).toBe(102);
  });

  it('returns NaN for malformed times', () => {
    expect(elapsedMinutes('25:00', '01:00')).toBeNaN();
    expect(elapsedMinutes('10:00', 'bad')).toBeNaN();
  });
});

describe('isoDateToDayNumber', () => {
  it('counts whole days from the epoch', () => {
    expect(isoDateToDayNumber('1970-01-01')).toBe(0);
    expect(isoDateToDayNumber('1970-01-02')).toBe(1);
  });

  it('gives consecutive dates consecutive numbers across month and year ends', () => {
    expect(isoDateToDayNumber('2026-03-01') - isoDateToDayNumber('2026-02-28')).toBe(1);
    expect(isoDateToDayNumber('2027-01-01') - isoDateToDayNumber('2026-12-31')).toBe(1);
    // 2024 is a leap year: 29 February exists and sits between the two.
    expect(isoDateToDayNumber('2024-03-01') - isoDateToDayNumber('2024-02-28')).toBe(2);
  });

  it('returns NaN for a malformed or impossible date', () => {
    expect(isoDateToDayNumber('')).toBeNaN();
    expect(isoDateToDayNumber('2026-8-1')).toBeNaN();
    expect(isoDateToDayNumber('18/08/2026')).toBeNaN();
    expect(isoDateToDayNumber('2026-02-31')).toBeNaN();
    expect(isoDateToDayNumber('2026-13-01')).toBeNaN();
  });
});

describe('suggestTotalMinutes', () => {
  it('leaves an exact tenth of an hour unchanged', () => {
    expect(suggestTotalMinutes('10:00', '11:30')).toBe(90);
  });

  it('rounds to the nearest tenth of an hour (6 minutes)', () => {
    // raw 100 -> nearest multiple of 6 is 102
    expect(suggestTotalMinutes('23:30', '01:10')).toBe(102);
    // raw 3 -> rounds up to 6
    expect(suggestTotalMinutes('00:00', '00:03')).toBe(6);
    // raw 2 -> rounds down to 0
    expect(suggestTotalMinutes('00:00', '00:02')).toBe(0);
  });

  it('handles midnight crossing then rounding together', () => {
    // 23:00 -> 00:35 raw 95 -> nearest 6 is 96
    expect(suggestTotalMinutes('23:00', '00:35')).toBe(96);
  });

  it('returns NaN for malformed input', () => {
    expect(suggestTotalMinutes('24:00', '01:00')).toBeNaN();
  });
});

describe('dayNumberToIsoDate', () => {
  it('is the inverse of isoDateToDayNumber', () => {
    for (const date of ['1970-01-01', '2026-07-18', '2024-02-29', '1998-12-31']) {
      expect(dayNumberToIsoDate(isoDateToDayNumber(date))).toBe(date);
    }
  });

  it('returns an empty string rather than "Invalid Date"', () => {
    expect(dayNumberToIsoDate(NaN)).toBe('');
  });
});

describe('addDays', () => {
  it('steps backwards across a month boundary', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('steps forwards onto a leap day', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('steps across a year boundary', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('reaches back exactly 90 days', () => {
    // 90 days before 18 July 2026 is 19 April 2026.
    expect(addDays('2026-07-18', -90)).toBe('2026-04-19');
  });

  it('returns an empty string for a malformed date', () => {
    expect(addDays('2026-02-31', -1)).toBe('');
    expect(addDays('nonsense', 1)).toBe('');
  });
});

describe('localIsoDate', () => {
  it('reads the LOCAL calendar date, not the UTC one', () => {
    // Late evening local. In a timezone ahead of UTC this is already tomorrow
    // in UTC, and a pilot filing a flight now is filing it today.
    const now = new Date(2026, 6, 18, 23, 30, 0);
    expect(localIsoDate(now)).toBe('2026-07-18');
  });

  it('pads single-digit months and days', () => {
    expect(localIsoDate(new Date(2026, 0, 5, 12, 0, 0))).toBe('2026-01-05');
  });
});
