/**
 * Bulk adjust — the write.
 *
 * Two guarantees, and they are the whole reason this file exists separately
 * from the plan's tests:
 *
 *  - **ALL-OR-NOTHING.** A run that landed on some records and not others would
 *    leave a logbook with nothing to reconcile it against — no file, no undo.
 *  - **IT GOES THROUGH THE SAME GATE A TYPED FLIGHT DOES.** This rewrites
 *    history, so `applyEntryTypeInvariants` and `validateFlight` run on every
 *    record before the transaction opens.
 *
 * And above both: total FLIGHT time must be exactly where it was. Reclassifying
 * time between columns is not the same as creating any.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addFlight, applyBulkAdjust, getAllFlights, getTotals } from './index';
import { db } from './db';
import { planBulkAdjust, type BulkAdjustSpec } from '../domain/bulkAdjust';
import { EMPTY_SPEC } from '../domain/bulkAdjust';
import type { NewFlightInput } from '../domain/flight';

function input(overrides: Partial<NewFlightInput> = {}): NewFlightInput {
  return {
    date: '2026-07-18',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '10:00',
    onBlock: '11:30',
    aircraftType: 'A320',
    registration: 'LN-ABC',
    picName: '',
    totalMinutes: 90,
    ...overrides,
  } as NewFlightInput;
}

function spec(overrides: Partial<BulkAdjustSpec> = {}): BulkAdjustSpec {
  return {
    ...EMPTY_SPEC,
    fieldKey: 'multiPilotMinutes',
    target: 'aircraftType',
    value: 'A320',
    ...overrides,
  };
}

/** Read, plan, write — the exact sequence the toolbox screen performs. */
async function run(s: BulkAdjustSpec) {
  const plan = planBulkAdjust(await getAllFlights(), s);
  return applyBulkAdjust(plan);
}

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
});

describe('the ordinary case: a column that was never recorded', () => {
  it('files every matching flight time into the column', async () => {
    await addFlight(input({ registration: 'LN-AAA', totalMinutes: 90 }));
    await addFlight(input({ registration: 'LN-BBB', totalMinutes: 120 }));
    await addFlight(input({ aircraftType: 'C172', registration: 'LN-CCC', totalMinutes: 60 }));

    const result = await run(spec());
    expect(result.ok).toBe(true);
    expect(result.changedCount).toBe(2);

    const flights = await getAllFlights();
    const byReg = Object.fromEntries(flights.map((f) => [f.registration, f]));
    expect(byReg['LN-AAA'].multiPilotMinutes).toBe(90);
    expect(byReg['LN-BBB'].multiPilotMinutes).toBe(120);
    // Untouched: it is not the type that was named.
    expect(byReg['LN-CCC'].multiPilotMinutes).toBe(0);
  });

  it('does not create or destroy flight time', async () => {
    await addFlight(input({ totalMinutes: 90 }));
    await addFlight(input({ registration: 'LN-BBB', totalMinutes: 120 }));
    const before = (await getTotals()).totalMinutes;

    await run(spec());

    expect((await getTotals()).totalMinutes).toBe(before);
  });

  it('empties the column again on remove, leaving the totals alone', async () => {
    await addFlight(input({ totalMinutes: 90 }));
    await run(spec());
    expect((await getAllFlights())[0].multiPilotMinutes).toBe(90);

    const result = await run(spec({ operation: 'remove' }));
    expect(result.ok).toBe(true);

    const [flight] = await getAllFlights();
    expect(flight.multiPilotMinutes).toBe(0);
    expect(flight.totalMinutes).toBe(90);
  });

  it('preserves everything else on the record, including extra and id', async () => {
    const saved = await addFlight(
      input({ remarks: 'ILS 19R', extra: { legacyId: 7 } } as Partial<NewFlightInput>),
    );
    expect(saved.ok).toBe(true);

    await run(spec());

    const [flight] = await getAllFlights();
    expect(flight.remarks).toBe('ILS 19R');
    expect(flight.extra).toEqual({ legacyId: 7 });
    expect(flight.id).toBe(saved.ok ? saved.flight.id : '');
    expect(flight.schemaVersion).toBe(3);
  });
});

describe('the date range', () => {
  it('changes only what falls inside it', async () => {
    await addFlight(input({ date: '2025-06-01' }));
    await addFlight(input({ date: '2026-06-01' }));
    await addFlight(input({ date: '2027-06-01' }));

    const result = await run(spec({ from: '2026-01-01', to: '2026-12-31' }));
    expect(result.changedCount).toBe(1);

    const flights = await getAllFlights();
    const adjusted = flights.filter((f) => f.multiPilotMinutes > 0);
    expect(adjusted.map((f) => f.date)).toEqual(['2026-06-01']);
  });
});

describe('all-or-nothing', () => {
  it('refuses the whole run when one record will not validate', async () => {
    // A fill writes the entry's own total into a column, so under today's rules
    // a planned adjustment cannot itself produce an over-total component — the
    // validation gate is defence in depth, not a reachable path from the UI.
    // Reaching it therefore means putting a record into the table that never
    // went through `addFlight`: PIC of 90 against a total of 60. Whatever put
    // it there, the rule is that the run refuses ALL of it rather than fixing
    // some records and leaving the pilot to find the one it choked on.
    const good = await addFlight(input({ registration: 'LN-AAA', totalMinutes: 90 }));
    expect(good.ok).toBe(true);

    await db.flights.put({
      ...(good.ok ? good.flight : ({} as never)),
      id: 'broken-1',
      registration: 'LN-BBB',
      totalMinutes: 60,
      picMinutes: 90,
    });

    const result = await run(spec({ fieldKey: 'ifrMinutes' }));
    expect(result.ok).toBe(false);
    expect(result.changedCount).toBe(0);
    expect(result.error).toMatch(/would become invalid/);
    expect(result.error).toMatch(/Nothing was changed/);

    // Neither record moved — not even the one that was perfectly fine.
    for (const flight of await getAllFlights()) {
      expect(flight.ifrMinutes).toBe(0);
    }
  });

  it('refuses a bad field key outright', async () => {
    await addFlight(input());
    const bad = await applyBulkAdjust(
      planBulkAdjust(await getAllFlights(), spec({ fieldKey: 'totalMinutes' })),
    );
    expect(bad.ok).toBe(false);
    expect(bad.changedCount).toBe(0);
    expect(bad.error).toMatch(/Nothing was changed/);
    expect((await getAllFlights())[0].totalMinutes).toBe(90);
  });

  it('refuses a plan that reported a problem, rather than writing part of it', async () => {
    await addFlight(input());
    const result = await applyBulkAdjust(
      planBulkAdjust(await getAllFlights(), spec({ value: 'B738' })),
    );
    expect(result.ok).toBe(false);
    expect(result.changedCount).toBe(0);
    expect(result.error).toMatch(/Nothing was changed/);
    expect((await getAllFlights())[0].multiPilotMinutes).toBe(0);
  });

  it('refuses a run with nothing to change', async () => {
    await addFlight(input({ multiPilotMinutes: 90 } as Partial<NewFlightInput>));
    const result = await run(spec());
    expect(result.ok).toBe(false);
    expect(result.changedCount).toBe(0);
  });
});

describe('simulator sessions', () => {
  it('files session time into a column a session actually has', async () => {
    await addFlight({
      entryType: 'fstd',
      date: '2026-07-18',
      depAerodrome: 'SIM',
      arrAerodrome: 'SIM',
      offBlock: '',
      onBlock: '',
      aircraftType: 'A320',
      registration: '',
      picName: '',
      totalMinutes: 0,
      simulatorMinutes: 120,
      simulatorRegistration: 'EU-DK187',
    } as NewFlightInput);

    const result = await run(spec({ fieldKey: 'ifrMinutes' }));
    expect(result.ok).toBe(true);

    const [session] = await getAllFlights();
    expect(session.ifrMinutes).toBe(120);
    // The rule the whole entry-type design exists for.
    expect(session.totalMinutes).toBe(0);
    expect((await getTotals()).totalMinutes).toBe(0);
  });

  it('leaves sessions out of a flight-only column entirely', async () => {
    await addFlight({
      entryType: 'fstd',
      date: '2026-07-18',
      depAerodrome: 'SIM',
      arrAerodrome: 'SIM',
      offBlock: '',
      onBlock: '',
      aircraftType: 'A320',
      registration: '',
      picName: '',
      totalMinutes: 0,
      simulatorMinutes: 120,
      simulatorRegistration: 'EU-DK187',
    } as NewFlightInput);

    const result = await run(spec());
    expect(result.ok).toBe(false);

    const [session] = await getAllFlights();
    expect(session.multiPilotMinutes).toBe(0);
  });
});

describe('the pilot who imported a jet logbook with no multi-pilot time', () => {
  it('fills multi-pilot and then multi-engine without the second undoing the first', async () => {
    await addFlight(input({ registration: 'LN-AAA', totalMinutes: 95 }));
    await addFlight(input({ registration: 'LN-BBB', totalMinutes: 145 }));

    expect((await run(spec({ fieldKey: 'multiPilotMinutes' }))).ok).toBe(true);
    expect((await run(spec({ fieldKey: 'singlePilotMeMinutes' }))).ok).toBe(true);

    for (const flight of await getAllFlights()) {
      expect(flight.multiPilotMinutes).toBe(flight.totalMinutes);
      expect(flight.singlePilotMeMinutes).toBe(flight.totalMinutes);
    }

    const totals = await getTotals();
    expect(totals.totalMinutes).toBe(240);
    expect(totals.multiPilotMinutes).toBe(240);
    expect(totals.singlePilotMeMinutes).toBe(240);
  });
});
