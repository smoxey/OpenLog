import { describe, it, expect } from 'vitest';
import { migrateFlight, MigrationError } from './migrate';
import { CURRENT_SCHEMA_VERSION, V2_ADDED_FIELDS, type Flight } from './flight';
import { makeV1Flight, V1_FLIGHT_FIXTURE } from './fixtures/v1-flight';

/** A record already at the current schema version. */
function sampleFlight(): Flight {
  return {
    id: 'abc',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    entryType: 'flight',
    date: '2026-07-18',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '10:00',
    onBlock: '11:00',
    aircraftType: 'C172',
    registration: 'LN-ABC',
    picName: 'SELF',
    totalMinutes: 60,
    picMinutes: 60,
    singlePilotSeMinutes: 60,
    singlePilotMeMinutes: 0,
    multiPilotMinutes: 0,
    coPilotMinutes: 0,
    dualMinutes: 0,
    instructorMinutes: 0,
    nightMinutes: 0,
    ifrMinutes: 0,
    landingsDay: 1,
    landingsNight: 0,
    simulatorMinutes: 0,
    simulatorRegistration: '',
    remarks: '',
    extra: { source: 'test' },
  };
}

describe('migrateFlight — current version', () => {
  it('passes a current-version record through unchanged', () => {
    const record = sampleFlight();
    const result = migrateFlight(record);
    expect(result).toEqual(record);
  });

  it('preserves extra through migration', () => {
    const result = migrateFlight(sampleFlight());
    expect(result.extra).toEqual({ source: 'test' });
  });

  it('is idempotent — migrating a current-version record twice changes nothing', () => {
    const once = migrateFlight(sampleFlight());
    const twice = migrateFlight(structuredClone(once));
    expect(twice).toEqual(once);
  });
});

describe('migrateFlight — v1 forward', () => {
  it('upgrades the permanent v1 fixture correctly', () => {
    const result = migrateFlight(makeV1Flight());

    expect(result.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    // The six new columns arrive at zero.
    for (const key of V2_ADDED_FIELDS) {
      expect(result[key]).toBe(0);
    }

    // Every pre-existing field is untouched.
    expect(result.id).toBe(V1_FLIGHT_FIXTURE.id);
    expect(result.date).toBe(V1_FLIGHT_FIXTURE.date);
    expect(result.depAerodrome).toBe(V1_FLIGHT_FIXTURE.depAerodrome);
    expect(result.arrAerodrome).toBe(V1_FLIGHT_FIXTURE.arrAerodrome);
    expect(result.offBlock).toBe(V1_FLIGHT_FIXTURE.offBlock);
    expect(result.onBlock).toBe(V1_FLIGHT_FIXTURE.onBlock);
    expect(result.aircraftType).toBe(V1_FLIGHT_FIXTURE.aircraftType);
    expect(result.registration).toBe(V1_FLIGHT_FIXTURE.registration);
    expect(result.picName).toBe(V1_FLIGHT_FIXTURE.picName);
    expect(result.totalMinutes).toBe(V1_FLIGHT_FIXTURE.totalMinutes);
    expect(result.picMinutes).toBe(V1_FLIGHT_FIXTURE.picMinutes);
    expect(result.multiPilotMinutes).toBe(V1_FLIGHT_FIXTURE.multiPilotMinutes);
    expect(result.nightMinutes).toBe(V1_FLIGHT_FIXTURE.nightMinutes);
    expect(result.landingsDay).toBe(V1_FLIGHT_FIXTURE.landingsDay);
    expect(result.landingsNight).toBe(V1_FLIGHT_FIXTURE.landingsNight);
    expect(result.remarks).toBe(V1_FLIGHT_FIXTURE.remarks);
  });

  it('keeps every unrelated unknown key in extra', () => {
    const result = migrateFlight(makeV1Flight());
    expect(result.extra).toEqual({
      importedFrom: 'paper-logbook',
      approaches: 2,
      customTag: 'x-country',
    });
  });

  it('hoists a same-named key out of extra onto the core field', () => {
    const record = makeV1Flight();
    (record.extra as Record<string, unknown>).ifrMinutes = 30;

    const result = migrateFlight(record);

    expect(result.ifrMinutes).toBe(30);
    // Not duplicated: gone from extra entirely.
    expect('ifrMinutes' in result.extra).toBe(false);
    // The other unknown keys survive the hoist.
    expect(result.extra.customTag).toBe('x-country');
  });

  it('hoists every one of the six new fields when all are present in extra', () => {
    const record = makeV1Flight();
    const extra = record.extra as Record<string, unknown>;
    V2_ADDED_FIELDS.forEach((key, i) => {
      extra[key] = (i + 1) * 6;
    });

    const result = migrateFlight(record);

    V2_ADDED_FIELDS.forEach((key, i) => {
      expect(result[key]).toBe((i + 1) * 6);
      expect(key in result.extra).toBe(false);
    });
    expect(result.extra).toEqual({
      importedFrom: 'paper-logbook',
      approaches: 2,
      customTag: 'x-country',
    });
  });

  it('hoisting wins over the zero default even for a zero-ish stored value', () => {
    const record = makeV1Flight();
    (record.extra as Record<string, unknown>).dualMinutes = 0;

    const result = migrateFlight(record);

    expect(result.dualMinutes).toBe(0);
    expect('dualMinutes' in result.extra).toBe(false);
  });

  it('does not mutate the record it was given', () => {
    const record = makeV1Flight();
    (record.extra as Record<string, unknown>).ifrMinutes = 30;

    migrateFlight(record);

    expect(record.schemaVersion).toBe(1);
    expect((record.extra as Record<string, unknown>).ifrMinutes).toBe(30);
  });

  it('is idempotent across the version bump — migrating the result again is a no-op', () => {
    const once = migrateFlight(makeV1Flight());
    const twice = migrateFlight(structuredClone(once));
    expect(twice).toEqual(once);
  });
});

describe('migrateFlight — rejections', () => {
  it('throws a clear error for a newer, unknown version', () => {
    const future = { ...sampleFlight(), schemaVersion: 99 };
    expect(() => migrateFlight(future)).toThrow(MigrationError);
    expect(() => migrateFlight(future)).toThrow(/newer than this build/);
  });

  it('throws for a below-minimum version', () => {
    const old = { ...sampleFlight(), schemaVersion: 0 };
    expect(() => migrateFlight(old)).toThrow(/below the minimum/);
  });

  it('throws when schemaVersion is missing or invalid', () => {
    expect(() => migrateFlight({ id: 'x' })).toThrow(/schemaVersion/);
    expect(() => migrateFlight(null)).toThrow(MigrationError);
  });
});
