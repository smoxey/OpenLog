import { describe, it, expect } from 'vitest';
import {
  minutesToDecimal,
  decimalToMinutes,
  minutesToHhmm,
  hhmmToMinutes,
} from './duration';

describe('minutesToDecimal', () => {
  it('formats with exactly one decimal place', () => {
    expect(minutesToDecimal(138)).toBe('2.3');
    expect(minutesToDecimal(84)).toBe('1.4');
    expect(minutesToDecimal(6)).toBe('0.1');
    expect(minutesToDecimal(0)).toBe('0.0');
    expect(minutesToDecimal(60)).toBe('1.0');
  });
});

describe('decimalToMinutes', () => {
  it('converts decimal hours to integer minutes losslessly at tenths', () => {
    expect(decimalToMinutes(2.3)).toBe(138);
    expect(decimalToMinutes(1.4)).toBe(84);
    expect(decimalToMinutes(0.1)).toBe(6);
    expect(decimalToMinutes(0)).toBe(0);
  });
});

describe('decimal round-trips', () => {
  it('round-trips every tenth of an hour', () => {
    for (let minutes = 0; minutes <= 6000; minutes += 6) {
      const decimal = Number(minutesToDecimal(minutes));
      expect(decimalToMinutes(decimal)).toBe(minutes);
    }
  });
});

describe('minutesToHhmm', () => {
  it('formats hours without padding and minutes padded', () => {
    expect(minutesToHhmm(138)).toBe('2:18');
    expect(minutesToHhmm(6)).toBe('0:06');
    expect(minutesToHhmm(0)).toBe('0:00');
    expect(minutesToHhmm(1234)).toBe('20:34');
  });
});

describe('hhmmToMinutes', () => {
  it('parses valid hh:mm strings', () => {
    expect(hhmmToMinutes('2:18')).toBe(138);
    expect(hhmmToMinutes('0:06')).toBe(6);
    expect(hhmmToMinutes('20:34')).toBe(1234);
  });

  it('round-trips with minutesToHhmm', () => {
    for (const minutes of [0, 6, 84, 138, 599, 1234]) {
      expect(hhmmToMinutes(minutesToHhmm(minutes))).toBe(minutes);
    }
  });

  it('returns NaN for malformed input', () => {
    expect(hhmmToMinutes('2:60')).toBeNaN();
    expect(hhmmToMinutes('nonsense')).toBeNaN();
  });
});
