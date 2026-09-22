import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { serializeJson, buildEnvelope } from './json';
import { EXPORT_FORMAT_ID, EXPORT_FORMAT_VERSION } from './types';
import {
  SAMPLE_FLIGHTS,
  SAMPLE_AIRCRAFT,
  SAMPLE_EXPORTED_AT,
  SAMPLE_APP_VERSION,
} from './fixtures/sample-logbook';
import { addFlight, upsertAircraft, listFlights, getAllAircraft } from '../storage';
import { CURRENT_SCHEMA_VERSION, type NewFlightInput } from '../domain/flight';
import { db } from '../storage/db';

const OPTIONS = { appVersion: SAMPLE_APP_VERSION, exportedAt: SAMPLE_EXPORTED_AT };
const BUNDLE = { flights: SAMPLE_FLIGHTS, aircraft: SAMPLE_AIRCRAFT };

/**
 * Fixtures are read from the repo root rather than via `import.meta.url` —
 * under vitest on Windows that URL loses the drive prefix and resolves to C:\.
 */
const FIXTURE_DIR = path.resolve(process.cwd(), 'src/lib/export/fixtures');

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
});

describe('JSON envelope', () => {
  it('carries the format identity and both version numbers', () => {
    const envelope = buildEnvelope(BUNDLE, OPTIONS);
    expect(envelope.format).toBe(EXPORT_FORMAT_ID);
    expect(envelope.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    // The envelope version and the record schema version are independent.
    expect(envelope.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(envelope.formatVersion).not.toBe(envelope.schemaVersion);
  });

  it('reports the flight count and the caller-supplied metadata', () => {
    const envelope = buildEnvelope(BUNDLE, OPTIONS);
    expect(envelope.flightCount).toBe(SAMPLE_FLIGHTS.length);
    expect(envelope.appVersion).toBe(SAMPLE_APP_VERSION);
    expect(envelope.exportedAt).toBe(SAMPLE_EXPORTED_AT);
  });

  it('includes the whole aircraft table, sorted by registration', () => {
    const envelope = buildEnvelope(BUNDLE, OPTIONS);
    expect(envelope.aircraft.map((a) => (a as { registration: string }).registration)).toEqual([
      'LN-ABC',
      'LN-XYZ',
      'N0123',
    ]);
  });

  it('keeps durations as integer minutes — never decimal hours', () => {
    const parsed = JSON.parse(serializeJson(BUNDLE, OPTIONS));
    const flight = parsed.flights.find((f: { id: string }) => f.id.startsWith('aaaa'));
    expect(flight.totalMinutes).toBe(138);
    expect(typeof flight.totalMinutes).toBe('number');
  });
});

describe('deterministic output', () => {
  it('two exports of the same bundle are byte-identical', () => {
    expect(serializeJson(BUNDLE, OPTIONS)).toBe(serializeJson(BUNDLE, OPTIONS));
  });

  it('input order does not change the bytes', () => {
    const shuffled = {
      flights: [...SAMPLE_FLIGHTS].reverse(),
      aircraft: [...SAMPLE_AIRCRAFT].reverse(),
    };
    expect(serializeJson(shuffled, OPTIONS)).toBe(serializeJson(BUNDLE, OPTIONS));
  });

  it('sorts flights by date, then id', () => {
    const parsed = JSON.parse(serializeJson(BUNDLE, OPTIONS));
    expect(parsed.flights.map((f: { date: string; id: string }) => `${f.date} ${f.id[0]}`)).toEqual([
      '2026-07-18 a',
      '2026-07-18 b',
      '2026-08-02 c',
      // The FSTD session sorts by date like any other record — it is one table.
      '2026-08-04 e',
      '2026-08-05 d',
    ]);
  });

  it('emits extra keys alphabetically regardless of insertion order', () => {
    const one = { ...SAMPLE_FLIGHTS[1], extra: { zulu: 1, alpha: 2, mike: 3 } };
    const other = { ...SAMPLE_FLIGHTS[1], extra: { mike: 3, zulu: 1, alpha: 2 } };
    const a = serializeJson({ flights: [one], aircraft: [] }, OPTIONS);
    const b = serializeJson({ flights: [other], aircraft: [] }, OPTIONS);
    expect(a).toBe(b);
    expect(a.indexOf('"alpha"')).toBeLessThan(a.indexOf('"mike"'));
    expect(a.indexOf('"mike"')).toBeLessThan(a.indexOf('"zulu"'));
  });

  it('matches the committed sample fixture byte for byte', () => {
    expect(serializeJson(BUNDLE, OPTIONS)).toBe(fixture('sample-export.json'));
  });
});

describe('extra preservation', () => {
  it('survives nested objects and arrays intact', () => {
    const parsed = JSON.parse(serializeJson(BUNDLE, OPTIONS));
    const night = parsed.flights.find((f: { id: string }) => f.id.startsWith('cccc'));
    expect(night.extra.crew).toEqual({ pic: 'SELF', student: 'A. Nordmann' });
    expect(night.extra.waypoints).toEqual(['ENBR', 'KVERN', 'ENGM']);
  });

  it('keeps array order — position is data', () => {
    const flight = {
      ...SAMPLE_FLIGHTS[1],
      extra: { legs: ['C', 'A', 'B'] },
    };
    const parsed = JSON.parse(serializeJson({ flights: [flight], aircraft: [] }, OPTIONS));
    expect(parsed.flights[0].extra.legs).toEqual(['C', 'A', 'B']);
  });

  it('preserves null and false rather than dropping them', () => {
    const parsed = JSON.parse(serializeJson(BUNDLE, OPTIONS));
    const night = parsed.flights.find((f: { id: string }) => f.id.startsWith('cccc'));
    expect(night.extra.instructor).toBeNull();
    expect('instructor' in night.extra).toBe(true);
  });
});

describe('round-trip identity against a real database', () => {
  it('export -> parse deep-equals the stored records, extra and aircraft included', async () => {
    for (const flight of SAMPLE_FLIGHTS) {
      const { id, schemaVersion, ...rest } = flight;
      const result = await addFlight(rest as unknown as NewFlightInput);
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
    for (const aircraft of SAMPLE_AIRCRAFT) await upsertAircraft(aircraft);

    const storedFlights = await listFlights();
    const storedAircraft = await getAllAircraft();

    const parsed = JSON.parse(
      serializeJson({ flights: storedFlights, aircraft: storedAircraft }, OPTIONS),
    );

    // Deep-equal, order-independent: the exporter reorders keys and records on
    // purpose, so compare as sets keyed by id.
    const byId = (list: { id: string }[]) =>
      Object.fromEntries(list.map((f) => [f.id, f]));

    expect(byId(parsed.flights)).toEqual(byId(storedFlights as unknown as { id: string }[]));
    expect(parsed.aircraft).toEqual(storedAircraft);
    expect(parsed.flightCount).toBe(storedFlights.length);
  });

  it('an empty logbook exports a valid envelope and does not throw', () => {
    const json = serializeJson({ flights: [], aircraft: [] }, OPTIONS);
    const parsed = JSON.parse(json);
    expect(parsed.flightCount).toBe(0);
    expect(parsed.flights).toEqual([]);
    expect(parsed.aircraft).toEqual([]);
    expect(parsed.format).toBe(EXPORT_FORMAT_ID);
  });
});
