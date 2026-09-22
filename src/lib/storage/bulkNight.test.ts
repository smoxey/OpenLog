/**
 * Bulk night time — the write.
 *
 * Two guarantees, and they are why this file exists separately from the plan's
 * tests:
 *
 *  - **ALL-OR-NOTHING.** A run that landed on some flights and not others would
 *    leave a logbook with nothing to reconcile it against — no file, no undo.
 *  - **IT GOES THROUGH THE SAME GATE A TYPED FLIGHT DOES.** This rewrites
 *    history, so `applyEntryTypeInvariants` and `validateFlight` run on every
 *    record before the transaction opens.
 *
 * And above both: nothing but the night column may move. Total time, the
 * landing columns and every other figure the pilot logged must read exactly
 * what they read before.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addFlight, applyBulkNight, getAllFlights, getTotals } from './index';
import { db } from './db';
import { EMPTY_NIGHT_SPEC, planBulkNight, type BulkNightSpec } from '../domain/bulkNight';
import type { Airport } from '../airports/types';
import type { NewFlightInput } from '../domain/flight';

const AIRPORTS: Record<string, Airport> = {
  ENGM: { code: 'ENGM', lat: 60.1939, lon: 11.1004 },
  ENBR: { code: 'ENBR', lat: 60.2934, lon: 5.2181 },
};
const lookup = (code: string): Airport | undefined => AIRPORTS[code.toUpperCase()];

function input(overrides: Partial<NewFlightInput> = {}): NewFlightInput {
  return {
    date: '2026-01-15',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    // Dark from off-block to on-block in a Norwegian January.
    offBlock: '20:00',
    onBlock: '21:00',
    aircraftType: 'A320',
    registration: 'LN-ABC',
    picName: '',
    totalMinutes: 60,
    ...overrides,
  } as NewFlightInput;
}

const spec = (overrides: Partial<BulkNightSpec> = {}): BulkNightSpec => ({
  ...EMPTY_NIGHT_SPEC,
  ...overrides,
});

/** Read, plan, write — the exact sequence the toolbox screen performs. */
async function run(s: BulkNightSpec = spec()) {
  const plan = planBulkNight(await getAllFlights(), s, lookup);
  return applyBulkNight(plan);
}

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
});

describe('the ordinary case: flights with no night figure', () => {
  it('writes the worked-out night to every flight it selected', async () => {
    await addFlight(input());
    await addFlight(input({ date: '2026-01-16' }));

    const result = await run();

    expect(result.ok).toBe(true);
    expect(result.changedCount).toBe(2);
    for (const flight of await getAllFlights()) {
      expect(flight.nightMinutes).toBe(60);
    }
  });

  it('leaves total time exactly where it was', async () => {
    await addFlight(input());
    const before = await getTotals();

    await run();

    const after = await getTotals();
    expect(after.totalMinutes).toBe(before.totalMinutes);
  });

  it('does not touch the landing columns', async () => {
    await addFlight(input({ landingsDay: 1, landingsNight: 0 }));

    await run();

    const [flight] = await getAllFlights();
    // The arrival IS at night, and the entry form would move the landing. The
    // bulk tool deliberately does not: that is a second claim about the flight.
    expect(flight.landingsDay).toBe(1);
    expect(flight.landingsNight).toBe(0);
  });

  it('leaves every other logged figure alone', async () => {
    await addFlight(input({ ifrMinutes: 55, picMinutes: 60, remarks: 'line check' }));

    await run();

    const [flight] = await getAllFlights();
    expect(flight.ifrMinutes).toBe(55);
    expect(flight.picMinutes).toBe(60);
    expect(flight.remarks).toBe('line check');
  });

  it('preserves the id and the schema version, so nothing is re-created', async () => {
    await addFlight(input());
    const [before] = await getAllFlights();

    await run();

    const [after] = await getAllFlights();
    expect(after.id).toBe(before.id);
    expect(after.schemaVersion).toBe(before.schemaVersion);
  });
});

describe('what it refuses to do', () => {
  it('writes nothing when the plan cannot run', async () => {
    await addFlight(input({ arrAerodrome: 'ZZZZ' }));

    const result = await run();

    expect(result.ok).toBe(false);
    expect(result.changedCount).toBe(0);
    expect(result.error).toContain('Nothing was changed.');
    const [flight] = await getAllFlights();
    expect(flight.nightMinutes).toBe(0);
  });

  it('leaves a flight it cannot work out untouched while changing the others', async () => {
    await addFlight(input());
    await addFlight(input({ date: '2026-01-16', arrAerodrome: 'ZZZZ' }));

    const result = await run();

    expect(result.ok).toBe(true);
    expect(result.changedCount).toBe(1);
    const flights = await getAllFlights();
    expect(flights.find((f) => f.arrAerodrome === 'ZZZZ')?.nightMinutes).toBe(0);
    expect(flights.find((f) => f.arrAerodrome === 'ENBR')?.nightMinutes).toBe(60);
  });

  it('never touches a simulator session', async () => {
    await addFlight(input());
    await addFlight({
      ...input(),
      entryType: 'fstd',
      depAerodrome: '',
      arrAerodrome: '',
      totalMinutes: 0,
      simulatorMinutes: 120,
      simulatorRegistration: 'SIM-1',
    } as NewFlightInput);

    await run();

    const sim = (await getAllFlights()).find((f) => f.entryType === 'fstd');
    expect(sim?.nightMinutes).toBe(0);
    expect(sim?.simulatorMinutes).toBe(120);
  });
});

describe('keeping what was logged', () => {
  it('only overwrites an existing night figure under the "all" scope', async () => {
    await addFlight(input({ nightMinutes: 42 }));

    const missingOnly = await run(spec({ scope: 'missing' }));
    expect(missingOnly.ok).toBe(false);
    expect((await getAllFlights())[0].nightMinutes).toBe(42);

    const all = await run(spec({ scope: 'all' }));
    expect(all.ok).toBe(true);
    expect((await getAllFlights())[0].nightMinutes).toBe(60);
  });

  it('honours a date range, leaving everything outside it as it was', async () => {
    await addFlight(input({ date: '2026-01-15' }));
    await addFlight(input({ date: '2026-02-15' }));

    const result = await run(spec({ from: '2026-02-01', to: '2026-02-28' }));

    expect(result.changedCount).toBe(1);
    const flights = await getAllFlights();
    expect(flights.find((f) => f.date === '2026-01-15')?.nightMinutes).toBe(0);
    expect(flights.find((f) => f.date === '2026-02-15')?.nightMinutes).toBeGreaterThan(0);
  });
});
