import { describe, it, expect } from 'vitest';
import { validateFlight, type ValidationError } from './validate';
import { CURRENT_SCHEMA_VERSION, type Flight } from '../domain/flight';

function baseFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: 'id-1',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    entryType: 'flight',
    date: '2026-07-18',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '10:00',
    onBlock: '11:30',
    aircraftType: 'C172',
    registration: 'LN-ABC',
    picName: 'SELF',
    totalMinutes: 90,
    picMinutes: 90,
    coPilotMinutes: 0,
    dualMinutes: 0,
    instructorMinutes: 0,
    singlePilotSeMinutes: 90,
    singlePilotMeMinutes: 0,
    multiPilotMinutes: 0,
    nightMinutes: 0,
    ifrMinutes: 0,
    landingsDay: 1,
    landingsNight: 0,
    simulatorMinutes: 0,
    simulatorRegistration: '',
    remarks: '',
    extra: {},
    ...overrides,
  };
}

function keys(errors: ValidationError[]): string[] {
  return errors.map((e) => e.key);
}

describe('validateFlight — required fields', () => {
  it('passes a complete valid record', () => {
    expect(validateFlight(baseFlight()).errors).toEqual([]);
  });

  it('flags a missing required field', () => {
    const { errors } = validateFlight(baseFlight({ depAerodrome: '   ' }));
    expect(keys(errors)).toContain('depAerodrome');
  });
});

describe('validateFlight — ICAO normalization', () => {
  it('uppercases and trims rather than rejecting', () => {
    const { normalized, errors } = validateFlight(baseFlight({ depAerodrome: ' engm ' }));
    expect(errors).toEqual([]);
    expect(normalized.depAerodrome).toBe('ENGM');
  });
});

describe('validateFlight — durations', () => {
  it('accepts non-negative integers', () => {
    expect(validateFlight(baseFlight({ nightMinutes: 0 })).errors).toEqual([]);
  });

  it('rejects negative or non-integer durations', () => {
    expect(keys(validateFlight(baseFlight({ nightMinutes: -5 })).errors)).toContain('nightMinutes');
    expect(keys(validateFlight(baseFlight({ picMinutes: 12.5 })).errors)).toContain('picMinutes');
  });

  it('rejects component durations exceeding total', () => {
    const { errors } = validateFlight(baseFlight({ totalMinutes: 60, picMinutes: 90 }));
    expect(keys(errors)).toContain('picMinutes');
  });

  it('allows a component duration equal to total', () => {
    expect(validateFlight(baseFlight({ totalMinutes: 90, picMinutes: 90 })).errors).toEqual([]);
  });
});

describe('validateFlight — counts', () => {
  it('rejects negative or fractional landings', () => {
    expect(keys(validateFlight(baseFlight({ landingsDay: -1 })).errors)).toContain('landingsDay');
    expect(keys(validateFlight(baseFlight({ landingsNight: 1.5 })).errors)).toContain('landingsNight');
  });
});

describe('validateFlight — time of day', () => {
  it('accepts valid HH:MM', () => {
    expect(validateFlight(baseFlight({ offBlock: '00:00', onBlock: '23:59' })).errors).toEqual([]);
  });

  it('rejects out-of-range or malformed times', () => {
    expect(keys(validateFlight(baseFlight({ offBlock: '24:00' })).errors)).toContain('offBlock');
    expect(keys(validateFlight(baseFlight({ onBlock: '1:5' })).errors)).toContain('onBlock');
  });
});

describe('validateFlight — dates', () => {
  it('rejects malformed or impossible dates', () => {
    expect(keys(validateFlight(baseFlight({ date: '2026-13-40' })).errors)).toContain('date');
    expect(keys(validateFlight(baseFlight({ date: '18-07-2026' })).errors)).toContain('date');
  });
});
