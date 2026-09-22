import { describe, expect, it } from 'vitest';
import {
  UTC_OFFSETS,
  entryLocalToUtc,
  entryUtcToLocal,
  formatOffset,
  formatTimeOfDay,
  isKnownOffset,
  localToUtc,
  minutesToTimeOfDay,
  parseTimeOfDayInput,
  utcToLocal,
} from './timeOfDay';

describe('minutesToTimeOfDay', () => {
  it('writes the canonical zero-padded shape', () => {
    expect(minutesToTimeOfDay(0)).toBe('00:00');
    expect(minutesToTimeOfDay(9 * 60 + 5)).toBe('09:05');
    expect(minutesToTimeOfDay(23 * 60 + 36)).toBe('23:36');
  });

  it('wraps values outside the day so callers need no modulo of their own', () => {
    expect(minutesToTimeOfDay(1440)).toBe('00:00');
    expect(minutesToTimeOfDay(1500)).toBe('01:00');
    expect(minutesToTimeOfDay(-30)).toBe('23:30');
  });

  it('returns empty rather than "NaN:NaN"', () => {
    expect(minutesToTimeOfDay(NaN)).toBe('');
    expect(minutesToTimeOfDay(Infinity)).toBe('');
  });
});

describe('formatTimeOfDay', () => {
  it('leaves a 24-hour time as it is stored', () => {
    expect(formatTimeOfDay('23:36', '24h')).toBe('23:36');
    expect(formatTimeOfDay('00:05', '24h')).toBe('00:05');
  });

  it('shows am/pm when asked, with 12 rather than 0', () => {
    expect(formatTimeOfDay('23:36', '12h')).toBe('11:36 PM');
    expect(formatTimeOfDay('11:36', '12h')).toBe('11:36 AM');
    expect(formatTimeOfDay('00:05', '12h')).toBe('12:05 AM');
    expect(formatTimeOfDay('12:00', '12h')).toBe('12:00 PM');
    expect(formatTimeOfDay('12:59', '12h')).toBe('12:59 PM');
    expect(formatTimeOfDay('13:00', '12h')).toBe('1:00 PM');
  });

  it('passes anything unreadable straight through rather than blanking it', () => {
    expect(formatTimeOfDay('', '12h')).toBe('');
    expect(formatTimeOfDay('not a time', '24h')).toBe('not a time');
    expect(formatTimeOfDay('25:00', '12h')).toBe('25:00');
  });
});

describe('parseTimeOfDayInput', () => {
  it('reads the shapes a pilot types', () => {
    expect(parseTimeOfDayInput('23:36')).toBe('23:36');
    expect(parseTimeOfDayInput('2336')).toBe('23:36');
    expect(parseTimeOfDayInput('936')).toBe('09:36');
    expect(parseTimeOfDayInput('9:36')).toBe('09:36');
    expect(parseTimeOfDayInput('23')).toBe('23:00');
    expect(parseTimeOfDayInput(' 07:05 ')).toBe('07:05');
  });

  it('drops seconds a foreign file may carry', () => {
    expect(parseTimeOfDayInput('23:36:00')).toBe('23:36');
  });

  it('reads am/pm in every spelling', () => {
    expect(parseTimeOfDayInput('11:36 PM')).toBe('23:36');
    expect(parseTimeOfDayInput('11:36pm')).toBe('23:36');
    expect(parseTimeOfDayInput('11:36 p.m.')).toBe('23:36');
    expect(parseTimeOfDayInput('1136p')).toBe('23:36');
    expect(parseTimeOfDayInput('11:36 AM')).toBe('11:36');
  });

  it('puts midnight and noon in the right place', () => {
    expect(parseTimeOfDayInput('12:00 AM')).toBe('00:00');
    expect(parseTimeOfDayInput('12:30 AM')).toBe('00:30');
    expect(parseTimeOfDayInput('12:00 PM')).toBe('12:00');
    expect(parseTimeOfDayInput('12:30 PM')).toBe('12:30');
  });

  it('treats empty as a real answer, not a failure', () => {
    expect(parseTimeOfDayInput('')).toBe('');
    expect(parseTimeOfDayInput('   ')).toBe('');
  });

  it('refuses what it cannot read', () => {
    expect(parseTimeOfDayInput('24:00')).toBeNull();
    expect(parseTimeOfDayInput('23:60')).toBeNull();
    expect(parseTimeOfDayInput('13:00 PM')).toBeNull();
    expect(parseTimeOfDayInput('00:30 AM')).toBeNull();
    expect(parseTimeOfDayInput('abc')).toBeNull();
    expect(parseTimeOfDayInput('12345')).toBeNull();
    expect(parseTimeOfDayInput('-1:00')).toBeNull();
  });

  it('round-trips everything it produces back through the formatter', () => {
    for (let minutes = 0; minutes < 1440; minutes++) {
      const canonical = minutesToTimeOfDay(minutes);
      expect(parseTimeOfDayInput(canonical)).toBe(canonical);
      expect(parseTimeOfDayInput(formatTimeOfDay(canonical, '12h'))).toBe(canonical);
    }
  });
});

describe('localToUtc / utcToLocal', () => {
  it('subtracts the offset to reach UTC', () => {
    expect(localToUtc('23:36', 120)).toEqual({ time: '21:36', dayShift: 0 });
    expect(utcToLocal('21:36', 120)).toEqual({ time: '23:36', dayShift: 0 });
  });

  it('reports the day it fell onto when it crosses midnight', () => {
    expect(localToUtc('01:30', 120)).toEqual({ time: '23:30', dayShift: -1 });
    expect(localToUtc('23:30', -120)).toEqual({ time: '01:30', dayShift: 1 });
    expect(utcToLocal('23:30', 120)).toEqual({ time: '01:30', dayShift: 1 });
  });

  it('handles the three-quarter-hour zones', () => {
    expect(localToUtc('12:00', 345)).toEqual({ time: '06:15', dayShift: 0 });
    expect(localToUtc('06:00', 765)).toEqual({ time: '17:15', dayShift: -1 });
  });

  it('leaves a blank or malformed time exactly as it is', () => {
    expect(localToUtc('', 120)).toEqual({ time: '', dayShift: 0 });
    expect(localToUtc('nonsense', 120)).toEqual({ time: 'nonsense', dayShift: 0 });
  });

  it('is its own inverse at every offset and every minute', () => {
    for (const offset of UTC_OFFSETS) {
      for (let minutes = 0; minutes < 1440; minutes += 7) {
        const utc = minutesToTimeOfDay(minutes);
        expect(localToUtc(utcToLocal(utc, offset).time, offset).time).toBe(utc);
      }
    }
  });
});

describe('entryLocalToUtc / entryUtcToLocal', () => {
  const local = { date: '2026-08-29', offBlock: '23:36', onBlock: '01:10' };

  it('is a no-op at UTC, without even copying the strings around', () => {
    expect(entryLocalToUtc(local, 0)).toEqual(local);
    expect(entryUtcToLocal(local, 0)).toEqual(local);
  });

  it('converts both block times and leaves the date where it belongs', () => {
    expect(entryLocalToUtc({ date: '2026-08-29', offBlock: '10:00', onBlock: '11:30' }, 120)).toEqual({
      date: '2026-08-29',
      offBlock: '08:00',
      onBlock: '09:30',
    });
  });

  it('moves the date back when the off-block crosses midnight into UTC', () => {
    expect(entryLocalToUtc({ date: '2026-03-01', offBlock: '01:30', onBlock: '03:00' }, 120)).toEqual({
      date: '2026-02-28',
      offBlock: '23:30',
      onBlock: '01:00',
    });
  });

  it('moves the date forward the other way', () => {
    expect(entryLocalToUtc({ date: '2026-02-28', offBlock: '23:30', onBlock: '01:00' }, -120)).toEqual({
      date: '2026-03-01',
      offBlock: '01:30',
      onBlock: '03:00',
    });
  });

  it('never moves the date for the ON-block alone — one record, one date', () => {
    // On-block crosses midnight in UTC; the off-block does not. The stored date
    // is the departure date, so it must not move.
    expect(entryLocalToUtc({ date: '2026-08-29', offBlock: '20:00', onBlock: '23:00' }, -120)).toEqual({
      date: '2026-08-29',
      offBlock: '22:00',
      onBlock: '01:00',
    });
  });

  it('keeps a date it cannot read rather than wiping it', () => {
    expect(entryLocalToUtc({ date: '', offBlock: '01:30', onBlock: '03:00' }, 120)).toEqual({
      date: '',
      offBlock: '23:30',
      onBlock: '01:00',
    });
  });

  it('round-trips through every offered offset', () => {
    for (const offset of UTC_OFFSETS) {
      const utc = entryLocalToUtc(local, offset);
      expect(entryUtcToLocal(utc, offset)).toEqual(local);
    }
  });
});

describe('formatOffset', () => {
  it('calls zero what it is', () => {
    expect(formatOffset(0)).toBe('UTC');
  });

  it('signs and pads the rest', () => {
    expect(formatOffset(120)).toBe('UTC+02:00');
    expect(formatOffset(-210)).toBe('UTC-03:30');
    expect(formatOffset(345)).toBe('UTC+05:45');
    expect(formatOffset(840)).toBe('UTC+14:00');
  });
});

describe('UTC_OFFSETS', () => {
  it('is sorted, unique, and holds UTC itself', () => {
    expect([...UTC_OFFSETS].sort((a, b) => a - b)).toEqual([...UTC_OFFSETS]);
    expect(new Set(UTC_OFFSETS).size).toBe(UTC_OFFSETS.length);
    expect(UTC_OFFSETS).toContain(0);
  });

  it('spans the real range and no further', () => {
    expect(Math.min(...UTC_OFFSETS)).toBe(-720);
    expect(Math.max(...UTC_OFFSETS)).toBe(840);
  });

  it('recognises its own members and nothing else', () => {
    expect(isKnownOffset(0)).toBe(true);
    expect(isKnownOffset(345)).toBe(true);
    expect(isKnownOffset(37)).toBe(false);
    expect(isKnownOffset('120')).toBe(false);
    expect(isKnownOffset(undefined)).toBe(false);
  });
});
