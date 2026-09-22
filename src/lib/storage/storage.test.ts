import { describe, it, expect, beforeEach } from 'vitest';
import {
  addFlight,
  updateFlight,
  deleteFlight,
  getFlight,
  listFlights,
  getTotals,
  clearAll,
  getSettings,
  updateSettings,
} from './index';
import { CURRENT_SCHEMA_VERSION, type Flight, type NewFlightInput } from '../domain/flight';
import { makeV1Flight } from '../domain/fixtures/v1-flight';
import { db } from './db';

function input(overrides: Partial<NewFlightInput> = {}): NewFlightInput {
  return {
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
    landingsDay: 1,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.flights.clear();
  await db.settings.clear();
});

describe('addFlight / getFlight', () => {
  it('assigns id + schemaVersion and stores the record', async () => {
    const result = await addFlight(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.flight.id).toMatch(/[0-9a-f-]{36}/);
    expect(result.flight.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    const fetched = await getFlight(result.flight.id);
    expect(fetched?.registration).toBe('LN-ABC');
  });

  it('defaults optional numeric fields to 0', async () => {
    const result = await addFlight(input({ picMinutes: undefined, landingsDay: undefined }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flight.nightMinutes).toBe(0);
    expect(result.flight.landingsDay).toBe(0);
  });

  it('returns structured errors instead of storing invalid records', async () => {
    const result = await addFlight(input({ registration: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.key)).toContain('registration');
    expect(await db.flights.count()).toBe(0);
  });

  it('normalizes ICAO fields on write', async () => {
    const result = await addFlight(input({ depAerodrome: ' engm ' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flight.depAerodrome).toBe('ENGM');
  });
});

describe('extra preservation', () => {
  it('survives add -> get -> update unchanged', async () => {
    const added = await addFlight(input({ extra: { ifrMinutes: 30, customTag: 'x-country' } }));
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const fetched = await getFlight(added.flight.id);
    expect(fetched?.extra).toEqual({ ifrMinutes: 30, customTag: 'x-country' });

    // Update an unrelated field; extra must remain intact.
    const updated = await updateFlight(added.flight.id, { remarks: 'night xc' });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.flight.extra).toEqual({ ifrMinutes: 30, customTag: 'x-country' });
    expect(updated.flight.remarks).toBe('night xc');
  });

  it('merges new extra keys without dropping existing ones', async () => {
    const added = await addFlight(input({ extra: { a: 1 } }));
    if (!added.ok) return;
    const updated = await updateFlight(added.flight.id, { extra: { b: 2 } });
    if (!updated.ok) return;
    expect(updated.flight.extra).toEqual({ a: 1, b: 2 });
  });
});

describe('schema migration on read', () => {
  it('returns a current-version record for a v1 record written straight to IndexedDB', async () => {
    // Bypass the storage API deliberately: this is what a database written by
    // an older build of the app actually contains.
    const v1 = makeV1Flight();
    await db.flights.add(v1 as unknown as Flight);

    const fetched = await getFlight(v1.id as string);
    expect(fetched).toBeDefined();
    expect(fetched?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(fetched?.ifrMinutes).toBe(0);
    expect(fetched?.singlePilotSeMinutes).toBe(0);
    // v1 data is intact.
    expect(fetched?.registration).toBe('LN-ABC');
    expect(fetched?.nightMinutes).toBe(42);
    expect(fetched?.extra).toEqual({
      importedFrom: 'paper-logbook',
      approaches: 2,
      customTag: 'x-country',
    });
  });

  it('migrates v1 records read through listFlights', async () => {
    await db.flights.add(makeV1Flight() as unknown as Flight);
    const list = await listFlights();
    expect(list).toHaveLength(1);
    expect(list[0].schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(list[0].dualMinutes).toBe(0);
  });

  it('counts migrated v1 records in totals for the new columns', async () => {
    const v1 = makeV1Flight();
    (v1.extra as Record<string, unknown>).ifrMinutes = 30;
    await db.flights.add(v1 as unknown as Flight);

    const totals = await getTotals();
    expect(totals.ifrMinutes).toBe(30);
    expect(totals.totalMinutes).toBe(42);
  });

  it('persists the upgrade once a migrated record is updated', async () => {
    const v1 = makeV1Flight();
    await db.flights.add(v1 as unknown as Flight);

    const updated = await updateFlight(v1.id as string, { remarks: 'checked' });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.flight.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    const raw = await db.flights.get(v1.id as string);
    expect(raw?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(raw?.ifrMinutes).toBe(0);
  });
});

describe('updateFlight', () => {
  it('re-validates the merged record', async () => {
    const added = await addFlight(input({ totalMinutes: 90, picMinutes: 90 }));
    if (!added.ok) return;
    const bad = await updateFlight(added.flight.id, { picMinutes: 200 });
    expect(bad.ok).toBe(false);
  });

  it('errors on a missing id', async () => {
    const result = await updateFlight('does-not-exist', { remarks: 'x' });
    expect(result.ok).toBe(false);
  });
});

describe('deleteFlight', () => {
  it('removes a record', async () => {
    const added = await addFlight(input());
    if (!added.ok) return;
    await deleteFlight(added.flight.id);
    expect(await getFlight(added.flight.id)).toBeUndefined();
  });
});

describe('listFlights', () => {
  it('sorts by date descending, then offBlock descending by default', async () => {
    await addFlight(input({ date: '2026-07-10', offBlock: '08:00' }));
    await addFlight(input({ date: '2026-07-18', offBlock: '09:00' }));
    await addFlight(input({ date: '2026-07-18', offBlock: '14:00' }));

    const list = await listFlights();
    expect(list.map((f) => `${f.date} ${f.offBlock}`)).toEqual([
      '2026-07-18 14:00',
      '2026-07-18 09:00',
      '2026-07-10 08:00',
    ]);
  });

  it('supports ascending direction', async () => {
    await addFlight(input({ date: '2026-07-10' }));
    await addFlight(input({ date: '2026-07-18' }));
    const list = await listFlights({ sortBy: 'date', direction: 'asc' });
    expect(list.map((f) => f.date)).toEqual(['2026-07-10', '2026-07-18']);
  });
});

describe('getTotals', () => {
  it('sums summable fields across flights', async () => {
    await addFlight(input({ totalMinutes: 90, picMinutes: 90, landingsDay: 1 }));
    await addFlight(input({ totalMinutes: 120, picMinutes: 60, nightMinutes: 30, landingsDay: 2, landingsNight: 1 }));

    const totals = await getTotals();
    expect(totals.totalMinutes).toBe(210);
    expect(totals.picMinutes).toBe(150);
    expect(totals.nightMinutes).toBe(30);
    expect(totals.landingsDay).toBe(3);
    expect(totals.landingsNight).toBe(1);
  });

  it('returns zeros with no flights', async () => {
    const totals = await getTotals();
    expect(totals.totalMinutes).toBe(0);
    expect(totals.landingsNight).toBe(0);
  });
});

describe('clearAll', () => {
  it('removes every flight', async () => {
    await addFlight(input());
    await addFlight(input());
    await clearAll();
    expect(await listFlights()).toHaveLength(0);
  });
});

describe('settings', () => {
  it('defaults durationDisplay to decimal', async () => {
    expect((await getSettings()).durationDisplay).toBe('decimal');
  });

  it('persists an updated setting', async () => {
    await updateSettings({ durationDisplay: 'hhmm' });
    expect((await getSettings()).durationDisplay).toBe('hhmm');
  });
});
