/**
 * Import — the write.
 *
 * Two guarantees, and the tests exist to hold them apart from each other:
 *
 *  - **MERGE.** Existing flights survive. That is the difference from restore,
 *    and confusing the two would silently destroy a logbook.
 *  - **ALL-OR-NOTHING ANYWAY.** Merging is not a licence to land half a file.
 *    A partly-imported logbook is one the pilot must reconcile by hand against
 *    a CSV with no way to tell which rows made it.
 *
 * And above both, the rule the whole feature exists to protect: importing the
 * simulator rows must leave total FLIGHT time exactly where it was.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addFlight,
  getAllAircraft,
  getTotals,
  importFlights,
  listFlights,
  upsertAircraft,
  type Flight,
} from './index';
import { db } from './db';
import { parseCsv } from '../import/csv';
import { buildMapping } from '../import/mapping';
import { detectPreset } from '../import/presets';
import { buildImportPlan } from '../import/plan';
import { normalizeRegistration, type Aircraft } from '../domain/aircraft';

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'import',
  'fixtures',
);
const RB = readFileSync(path.join(FIXTURE_DIR, 'rb-logbook.csv'), 'utf8');

const AIRCRAFT: Aircraft[] = [
  { registration: 'OY-XXA', type: 'A320', class: 'ME', multiPilot: true },
  { registration: 'OY-XXC', type: 'A319', class: 'ME', multiPilot: true },
  { registration: 'OY-XXE', type: 'A320', class: 'ME', multiPilot: true },
  { registration: 'LN-XXB', type: 'PA28', class: 'SE', multiPilot: false },
  { registration: 'LN-XXD', type: 'C172', class: 'SE', multiPilot: false },
  // The registration the file gives no type for; the aircraft step supplies one.
  { registration: 'LN-XXZ', type: 'PA28', class: 'SE', multiPilot: false },
];

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
});

/** Plan the fixture with every aircraft confirmed. */
function planFixture(existing: Flight[] = [], idPrefix = 'id') {
  const result = parseCsv(RB);
  if (!result.ok) throw new Error(result.rejection.message);
  const file = result.file;
  const mapping = buildMapping(file.headers, detectPreset(file.headers), {
    unit: 'minutes',
    decimal: '.',
  });
  let n = 0;
  return buildImportPlan(
    file,
    mapping,
    {
      aircraft: new Map(AIRCRAFT.map((a) => [normalizeRegistration(a.registration), a])),
      fallbackClass: 'ME',
      makeId: () => `${idPrefix}-${++n}`,
    },
    existing,
    AIRCRAFT,
  );
}

async function seedOneFlight(): Promise<Flight> {
  const result = await addFlight({
    date: '2020-01-01',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '06:00',
    onBlock: '07:00',
    aircraftType: 'C172',
    registration: 'LN-OLD',
    picName: 'SELF',
    totalMinutes: 60,
    picMinutes: 60,
  });
  if (!result.ok) throw new Error('seed failed');
  return result.flight;
}

describe('THE GOVERNING RULE, through storage', () => {
  it('leaves total FLIGHT time unchanged by the simulator rows', async () => {
    // The end-to-end proof. The fixture's simulator rows carry 360 minutes of
    // Total Block between them. If any of it reached totalMinutes, this
    // assertion fails by exactly that much.
    const plan = planFixture();
    const sims = plan.rows.filter((r) => r.record.entryType === 'fstd');
    expect(sims).toHaveLength(2);

    const before = (await getTotals()).totalMinutes;
    await importFlights({
      flights: sims.map((r) => r.record),
      aircraft: [],
    });
    const after = (await getTotals()).totalMinutes;

    expect(after).toBe(before);
    expect(after).toBe(0);
  });

  it('stores the simulator session time, so it is not simply thrown away', async () => {
    const plan = planFixture();
    const sims = plan.rows.filter((r) => r.record.entryType === 'fstd');
    await importFlights({ flights: sims.map((r) => r.record), aircraft: [] });

    const stored = await listFlights();
    expect(stored).toHaveLength(2);
    expect(stored.reduce((sum, f) => sum + f.simulatorMinutes, 0)).toBe(315);
  });

  it('keeps the parked block time on the record without counting it', async () => {
    const plan = planFixture();
    const sims = plan.rows.filter((r) => r.record.entryType === 'fstd');
    await importFlights({ flights: sims.map((r) => r.record), aircraft: [] });

    const stored = await listFlights();
    const parked = stored.map((f) => f.extra['Total Block']).sort();
    expect(parked).toEqual(['120', '240']);
    // And it is nowhere near any total.
    expect((await getTotals()).totalMinutes).toBe(0);
  });
});

describe('merge, not replace', () => {
  it('leaves flights that were already there completely alone', async () => {
    const seeded = await seedOneFlight();
    const plan = planFixture();

    const outcome = await importFlights({
      flights: plan.rows.map((r) => r.record),
      aircraft: AIRCRAFT,
    });

    expect(outcome.ok).toBe(true);
    const stored = await listFlights();
    expect(stored).toHaveLength(1 + plan.rows.length);
    expect(stored.find((f) => f.id === seeded.id)).toEqual(seeded);
  });

  it('never clears a table', async () => {
    await seedOneFlight();
    await upsertAircraft({ registration: 'LN-OLD', type: 'C172', class: 'SE', multiPilot: false });

    await importFlights({ flights: [], aircraft: [] });

    expect(await listFlights()).toHaveLength(1);
    expect(await getAllAircraft()).toHaveLength(1);
  });

  it('adds the whole fixture and reports what it wrote', async () => {
    const plan = planFixture();
    const outcome = await importFlights({
      flights: plan.rows.map((r) => r.record),
      aircraft: AIRCRAFT,
    });

    expect(outcome).toEqual({
      ok: true,
      flightCount: plan.rows.length,
      aircraftCount: AIRCRAFT.length,
    });
    expect(await listFlights()).toHaveLength(13);
  });
});

describe('atomicity', () => {
  it('leaves the logbook exactly as it was when an import fails part-way', async () => {
    const seeded = await seedOneFlight();
    const plan = planFixture();
    const before = await listFlights();

    // A record IndexedDB cannot store: no value at the `id` key path. It comes
    // AFTER several good records, so the failure lands mid-write — precisely
    // the window the transaction exists to close.
    const broken = { ...plan.rows[0].record, id: undefined } as unknown as Flight;
    const outcome = await importFlights({
      flights: [plan.rows[1].record, plan.rows[2].record, broken],
      aircraft: AIRCRAFT,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/nothing was added/i);
    // Not one record landed, including the two good ones that preceded it.
    expect(await listFlights()).toEqual(before);
    expect(await listFlights()).toHaveLength(1);
    expect((await listFlights())[0].id).toBe(seeded.id);
  });

  it('rolls the aircraft back too, not just the flights', async () => {
    const broken = { id: undefined } as unknown as Flight;
    await importFlights({ flights: [broken], aircraft: AIRCRAFT });
    expect(await getAllAircraft()).toEqual([]);
  });

  it('aborts rather than collapsing two records that share an id', async () => {
    // Every imported record gets a fresh id, so a collision means the caller
    // handed us the same record twice. Silently merging them would lose a
    // flight; `bulkAdd` refuses.
    const plan = planFixture();
    const duplicated = [plan.rows[0].record, plan.rows[0].record];
    const outcome = await importFlights({ flights: duplicated, aircraft: [] });

    expect(outcome.ok).toBe(false);
    expect(await listFlights()).toEqual([]);
  });

  it('reports a failure rather than throwing', async () => {
    const broken = { id: undefined } as unknown as Flight;
    await expect(importFlights({ flights: [broken], aircraft: [] })).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe('aircraft', () => {
  it('remembers the aircraft the pilot confirmed, for next time', async () => {
    const plan = planFixture();
    await importFlights({ flights: plan.rows.map((r) => r.record), aircraft: AIRCRAFT });

    const stored = await getAllAircraft();
    expect(stored.map((a) => a.registration)).toEqual([
      'LN-XXB',
      'LN-XXD',
      'LN-XXZ',
      'OY-XXA',
      'OY-XXC',
      'OY-XXE',
    ]);
    expect(stored.find((a) => a.registration === 'OY-XXA')?.multiPilot).toBe(true);
  });

  it('updates what is already known rather than colliding with it', async () => {
    // Confirming an aircraft during an import is the pilot answering a
    // question, not a key collision.
    await upsertAircraft({ registration: 'OY-XXA', type: 'A320', class: 'SE', multiPilot: false });

    const outcome = await importFlights({ flights: [], aircraft: AIRCRAFT });
    expect(outcome.ok).toBe(true);

    const stored = await getAllAircraft();
    expect(stored.find((a) => a.registration === 'OY-XXA')).toEqual({
      registration: 'OY-XXA',
      type: 'A320',
      class: 'ME',
      multiPilot: true,
    });
  });

  it('writes a record identical to one the entry form would have saved', async () => {
    // Both paths go through the same `normalizeAircraft`, so an import cannot
    // create a second, subtly different copy of a known aircraft.
    await importFlights({
      flights: [],
      aircraft: [{ registration: '  oy-xxa ', type: ' A320 ', class: 'ME', multiPilot: true }],
    });
    const viaImport = (await getAllAircraft())[0];

    await db.aircraft.clear();
    const viaForm = await upsertAircraft({
      registration: '  oy-xxa ',
      type: ' A320 ',
      class: 'ME',
      multiPilot: true,
    });

    expect(viaImport).toEqual(viaForm);
  });

  it('drops an aircraft with no registration rather than aborting the import', async () => {
    // It has no primary key. Failing the whole import over a row the pilot
    // never meant to create would be a poor trade.
    const plan = planFixture();
    const outcome = await importFlights({
      flights: plan.rows.map((r) => r.record),
      aircraft: [...AIRCRAFT, { registration: '   ', type: '', class: 'SE', multiPilot: false }],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.aircraftCount).toBe(AIRCRAFT.length);
    expect(await listFlights()).toHaveLength(13);
  });
});

describe('re-importing the same file', () => {
  it('is caught by the plan as a conflict rather than by storage', async () => {
    // Storage merges what it is told to merge. Noticing that a file is already
    // in the logbook is the PLAN's job, and it does it through the same
    // `findConflicts` the entry form uses.
    const first = planFixture();
    await importFlights({ flights: first.rows.map((r) => r.record), aircraft: AIRCRAFT });

    const stored = await listFlights();
    const second = planFixture(stored, 'second');

    expect(second.conflicts.length).toBeGreaterThan(0);
    expect(second.counts.conflicting).toBe(11);
  });

  it('still merges if the pilot insists, because they were warned', async () => {
    const first = planFixture();
    await importFlights({ flights: first.rows.map((r) => r.record), aircraft: AIRCRAFT });

    const stored = await listFlights();
    const second = planFixture(stored, 'second');
    const outcome = await importFlights({
      flights: second.rows.map((r) => r.record),
      aircraft: AIRCRAFT,
    });

    expect(outcome.ok).toBe(true);
    expect(await listFlights()).toHaveLength(26);
  });
});

describe('an empty import', () => {
  it('is a no-op that succeeds', async () => {
    const outcome = await importFlights({ flights: [], aircraft: [] });
    expect(outcome).toEqual({ ok: true, flightCount: 0, aircraftCount: 0 });
    expect(await listFlights()).toEqual([]);
  });
});
