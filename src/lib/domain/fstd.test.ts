/**
 * FSTD (simulator) entries — schema v3.
 *
 * THE GOVERNING RULE these tests exist to defend: simulator time is never
 * flight time. A pilot's total flight time must be identical before and after
 * logging a simulator session, and no simulator session may ever contribute to
 * a flight total.
 *
 * The invariants are asserted through the STORAGE LAYER wherever possible,
 * because that is the boundary every write crosses — including a future
 * importer's. Asserting them only against a hand-built object would prove the
 * object, not the guarantee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  addFlight,
  updateFlight,
  getFlight,
  listFlights,
  getTotals,
  getAllAircraft,
  type NewFlightInput,
} from '../storage';
import { db } from '../storage/db';
import { validateFlight } from '../validation/validate';
import { migrateFlight } from './migrate';
import { CURRENT_SCHEMA_VERSION, SIMULATOR_AERODROME, type Flight } from './flight';
import { makeV1Flight, V1_FLIGHT_FIXTURE } from './fixtures/v1-flight';
import {
  appliesTo,
  copySourceKey,
  isRequiredFor,
  getField,
  quickFieldsFor,
} from '../registry/fields';

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
});

/** A perfectly ordinary flight. */
function flightInput(overrides: Partial<NewFlightInput> = {}): NewFlightInput {
  return {
    date: '2026-08-01',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '10:00',
    onBlock: '11:30',
    aircraftType: 'C172',
    registration: 'LN-ABC',
    picName: 'SELF',
    totalMinutes: 90,
    picMinutes: 90,
    ...overrides,
  } as NewFlightInput;
}

/** A simulator session. Note what it does NOT supply: times, registration. */
function fstdInput(overrides: Partial<NewFlightInput> = {}): NewFlightInput {
  return {
    entryType: 'fstd',
    date: '2026-08-02',
    depAerodrome: SIMULATOR_AERODROME,
    arrAerodrome: SIMULATOR_AERODROME,
    offBlock: '',
    onBlock: '',
    aircraftType: 'A320-200-SIM',
    registration: '',
    picName: '',
    totalMinutes: 0,
    simulatorMinutes: 240,
    simulatorRegistration: 'EU-DK187',
    ...overrides,
  } as NewFlightInput;
}

describe('FSTD — the entry-type invariants', () => {
  it('a flight carries no simulator time and no device id', async () => {
    const saved = await addFlight(flightInput());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(saved.flight.entryType).toBe('flight');
    expect(saved.flight.simulatorMinutes).toBe(0);
    expect(saved.flight.simulatorRegistration).toBe('');
  });

  it('a simulator session carries no flight time, no registration, and SIM aerodromes', async () => {
    const saved = await addFlight(fstdInput());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(saved.flight.entryType).toBe('fstd');
    expect(saved.flight.totalMinutes).toBe(0);
    expect(saved.flight.registration).toBe('');
    expect(saved.flight.depAerodrome).toBe(SIMULATOR_AERODROME);
    expect(saved.flight.arrAerodrome).toBe(SIMULATOR_AERODROME);
    expect(saved.flight.simulatorMinutes).toBe(240);
  });

  it('the storage layer forces the invariants even when the caller gets them wrong', async () => {
    // A caller — a future importer, say — that hands us a simulator session
    // still carrying block time, a registration and 240 minutes of flight time.
    const saved = await addFlight(
      fstdInput({
        totalMinutes: 240,
        registration: 'LN-ABC',
        depAerodrome: 'ENGM',
        arrAerodrome: 'ENBR',
        offBlock: '09:00',
        onBlock: '13:00',
      }),
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(saved.flight.totalMinutes).toBe(0);
    expect(saved.flight.registration).toBe('');
    expect(saved.flight.depAerodrome).toBe(SIMULATOR_AERODROME);
    expect(saved.flight.offBlock).toBe('');
  });

  it('a flight that claimed simulator time has it stripped', async () => {
    const saved = await addFlight(
      flightInput({ simulatorMinutes: 120, simulatorRegistration: 'EU-DK187' }),
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(saved.flight.simulatorMinutes).toBe(0);
    expect(saved.flight.simulatorRegistration).toBe('');
  });

  it('validation rejects a hand-built record that breaks an invariant', () => {
    const bad = {
      ...(fstdInput() as unknown as Flight),
      id: 'x',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      totalMinutes: 240,
      landingsDay: 0,
      landingsNight: 0,
      picMinutes: 0,
      coPilotMinutes: 0,
      dualMinutes: 0,
      instructorMinutes: 0,
      singlePilotSeMinutes: 0,
      singlePilotMeMinutes: 0,
      multiPilotMinutes: 0,
      nightMinutes: 0,
      ifrMinutes: 0,
      remarks: '',
      extra: {},
    } as Flight;

    const { errors } = validateFlight(bad);
    expect(errors.map((e) => e.key)).toContain('totalMinutes');
  });
});

describe('FSTD — simulator time is never flight time', () => {
  it('a simulator session contributes zero to flight totals', async () => {
    await addFlight(flightInput());
    const before = await getTotals();

    await addFlight(fstdInput());
    const after = await getTotals();

    // The whole point: adding four hours of simulator changed nothing.
    expect(after.totalMinutes).toBe(before.totalMinutes);
    expect(after.picMinutes).toBe(before.picMinutes);
  });

  it('simulator time is not summable, so no registry-driven total can pick it up', async () => {
    await addFlight(fstdInput());
    const totals = await getTotals();
    expect(totals.simulatorMinutes).toBeUndefined();
    expect(getField('simulatorMinutes')?.summable).toBe(false);
  });

  it('strips flight-only fields a caller smuggles onto a simulator session', async () => {
    // Landings, night and PIC time do not apply to an FSTD entry. If they were
    // merely ignored rather than zeroed they would still be stored — and still
    // summed into flight totals, since they are summable registry fields.
    const saved = await addFlight(
      fstdInput({ landingsDay: 3, landingsNight: 2, nightMinutes: 60, picMinutes: 240 }),
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(saved.flight.landingsDay).toBe(0);
    expect(saved.flight.landingsNight).toBe(0);
    expect(saved.flight.nightMinutes).toBe(0);
    expect(saved.flight.picMinutes).toBe(0);

    const totals = await getTotals();
    expect(totals.landingsDay ?? 0).toBe(0);
    expect(totals.picMinutes ?? 0).toBe(0);
  });

  it('a logbook of nothing but simulator sessions totals zero flight time', async () => {
    await addFlight(fstdInput({ date: '2026-08-02' }));
    await addFlight(fstdInput({ date: '2026-08-03', simulatorMinutes: 180 }));

    const totals = await getTotals();
    expect(totals.totalMinutes ?? 0).toBe(0);
    expect((await listFlights()).length).toBe(2);
  });
});

describe('FSTD — the aircraft store never sees a simulator', () => {
  it('saving a simulator session creates no aircraft record for the device', async () => {
    await addFlight(fstdInput());
    expect(await getAllAircraft()).toEqual([]);
  });

  it('the device id lives in simulatorRegistration, not registration', async () => {
    const saved = await addFlight(fstdInput());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(saved.flight.simulatorRegistration).toBe('EU-DK187');
    expect(saved.flight.registration).toBe('');
    // The aircraft-lookup role is attached to `registration`; a device id must
    // never reach it, or the aircraft list fills with things that cannot fly.
    expect(getField('registration')?.aircraftRole).toBe('registration');
    expect(getField('simulatorRegistration')?.aircraftRole).toBeUndefined();
  });
});

describe('FSTD — conditional requiredness', () => {
  it('a simulator session saves with no registration and no block times', async () => {
    const saved = await addFlight(fstdInput());
    expect(saved.ok).toBe(true);
  });

  it('a flight still fails validation without a registration or block times', async () => {
    const missing = await addFlight(flightInput({ registration: '', offBlock: '', onBlock: '' }));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;

    const keys = missing.errors.map((e) => e.key);
    expect(keys).toContain('registration');
    expect(keys).toContain('offBlock');
    expect(keys).toContain('onBlock');
  });

  it('resolves requiredness per entry type from the registry', () => {
    const registration = getField('registration')!;
    expect(isRequiredFor(registration, 'flight')).toBe(true);
    expect(isRequiredFor(registration, 'fstd')).toBe(false);

    const simulator = getField('simulatorMinutes')!;
    expect(isRequiredFor(simulator, 'fstd')).toBe(true);
    expect(isRequiredFor(simulator, 'flight')).toBe(false);
  });

  it('block times do not apply to a simulator session at all', () => {
    expect(appliesTo(getField('offBlock')!, 'fstd')).toBe(false);
    expect(appliesTo(getField('offBlock')!, 'flight')).toBe(true);
  });

  it('picName is optional and is never given a placeholder', async () => {
    const saved = await addFlight(flightInput({ picName: '' }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    // Empty is CORRECT, not an error, and must not become "SELF".
    expect(saved.flight.picName).toBe('');
    expect(isRequiredFor(getField('picName')!, 'flight')).toBe(false);
  });
});

describe('FSTD — "SIM" must stay a valid aerodrome', () => {
  /**
   * ICAO validation is deliberately lenient today (trim + uppercase, no
   * four-letter rule). Every FSTD entry depends on that. This test exists so
   * that tightening ICAO strictness later fails HERE, loudly, instead of
   * silently making every simulator session unsaveable.
   */
  it('SIM passes aerodrome validation', async () => {
    const saved = await addFlight(fstdInput());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.flight.depAerodrome).toBe('SIM');
  });

  it('SIM survives ICAO normalisation from any casing', async () => {
    const saved = await addFlight(fstdInput({ depAerodrome: ' sim ', arrAerodrome: 'Sim' }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.flight.depAerodrome).toBe(SIMULATOR_AERODROME);
    expect(saved.flight.arrAerodrome).toBe(SIMULATOR_AERODROME);
  });
});

describe('FSTD — cross-field validation uses the right yardstick', () => {
  it('measures components against simulatorMinutes on a simulator session', async () => {
    // 300 minutes of instrument time in a 240-minute session is impossible.
    const tooMuch = await addFlight(fstdInput({ ifrMinutes: 300 }));
    expect(tooMuch.ok).toBe(false);
    if (tooMuch.ok) return;
    expect(tooMuch.errors.map((e) => e.key)).toContain('ifrMinutes');
    expect(tooMuch.errors[0].message).toMatch(/Simulator/);
  });

  it('does not measure them against totalMinutes, which is zero by invariant', async () => {
    // The naive rule would reject this: 240 > totalMinutes (0).
    const fine = await addFlight(fstdInput({ ifrMinutes: 240, dualMinutes: 240 }));
    expect(fine.ok).toBe(true);
  });

  it('still measures a flight against its total time', async () => {
    const bad = await addFlight(flightInput({ picMinutes: 200 }));
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.map((e) => e.key)).toContain('picMinutes');
  });
});

describe('FSTD — the wand', () => {
  it('copies from session time on a simulator entry and total time on a flight', () => {
    expect(copySourceKey('fstd')).toBe('simulatorMinutes');
    expect(copySourceKey('flight')).toBe('totalMinutes');
  });

  it('offers the wand on instrument, instructor and dual time', () => {
    for (const key of ['ifrMinutes', 'instructorMinutes', 'dualMinutes']) {
      expect(getField(key)?.copyTotalAction, `${key} needs a wand`).toBe(true);
    }
  });

  it('leaves instrument, instructor and dual empty on a new simulator session', async () => {
    // Nothing is pre-filled: the wand is the ONLY thing that fills them.
    const saved = await addFlight(fstdInput());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(saved.flight.ifrMinutes).toBe(0);
    expect(saved.flight.instructorMinutes).toBe(0);
    expect(saved.flight.dualMinutes).toBe(0);
  });
});

describe('FSTD — form shape', () => {
  it('promotes the simulator fields inline and drops the flight-only ones', () => {
    const quick = quickFieldsFor('fstd').map((f) => f.key);
    expect(quick).toContain('simulatorMinutes');
    expect(quick).toContain('simulatorRegistration');
    expect(quick).not.toContain('depAerodrome');
    expect(quick).not.toContain('offBlock');
    expect(quick).not.toContain('registration');
    expect(quick).not.toContain('nightMinutes');
  });

  it('keeps the flight form unchanged apart from picName moving to detail', () => {
    const quick = quickFieldsFor('flight').map((f) => f.key);
    expect(quick).toContain('depAerodrome');
    expect(quick).toContain('totalMinutes');
    expect(quick).not.toContain('picName');
    expect(quick).not.toContain('simulatorMinutes');
  });
});

describe('FSTD — v2 to v3 migration', () => {
  it('migrates the permanent v1 fixture straight to v3 in one pass', () => {
    const result = migrateFlight(makeV1Flight());

    expect(result.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(3);

    // v3 fields arrive with flight defaults — the record's meaning is unchanged.
    expect(result.entryType).toBe('flight');
    expect(result.simulatorMinutes).toBe(0);
    expect(result.simulatorRegistration).toBe('');

    // And the v1 data is still intact after crossing two versions.
    expect(result.totalMinutes).toBe(V1_FLIGHT_FIXTURE.totalMinutes);
    expect(result.remarks).toBe(V1_FLIGHT_FIXTURE.remarks);
    expect(result.extra).toEqual({
      importedFrom: 'paper-logbook',
      approaches: 2,
      customTag: 'x-country',
    });
  });

  it('is idempotent — migrating the result again changes nothing', () => {
    const once = migrateFlight(makeV1Flight());
    const twice = migrateFlight(structuredClone(once));
    expect(twice).toEqual(once);
  });

  it('hoists a v3 key out of extra rather than overwriting it with the default', () => {
    const record = makeV1Flight();
    (record.extra as Record<string, unknown>).simulatorMinutes = 120;
    (record.extra as Record<string, unknown>).entryType = 'fstd';

    const result = migrateFlight(record);

    expect(result.simulatorMinutes).toBe(120);
    expect(result.entryType).toBe('fstd');
    // Never in both places.
    expect('simulatorMinutes' in result.extra).toBe(false);
    expect('entryType' in result.extra).toBe(false);
    // Unrelated unknown keys still survive.
    expect(result.extra.customTag).toBe('x-country');
  });

  it('does not mutate the record it was given', () => {
    const record = makeV1Flight();
    migrateFlight(record);
    expect(record.schemaVersion).toBe(1);
    expect('entryType' in record).toBe(false);
  });

  it('migrates a stored v2 record on read', async () => {
    // Written straight to IndexedDB in the old shape, bypassing addFlight.
    const v2 = {
      ...(flightInput() as unknown as Record<string, unknown>),
      id: 'v2-record',
      schemaVersion: 2,
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
      remarks: '',
      extra: {},
    };
    await db.flights.add(v2 as unknown as Flight);

    const read = await getFlight('v2-record');
    expect(read?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(read?.entryType).toBe('flight');
    expect(read?.simulatorMinutes).toBe(0);
  });
});

describe('FSTD — switching an entry between modes', () => {
  it('turning a flight into a simulator session clears the flight-only fields', async () => {
    const saved = await addFlight(flightInput());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const updated = await updateFlight(saved.flight.id, {
      entryType: 'fstd',
      simulatorMinutes: 120,
      simulatorRegistration: 'EU-DK187',
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    expect(updated.flight.totalMinutes).toBe(0);
    expect(updated.flight.registration).toBe('');
    expect(updated.flight.depAerodrome).toBe(SIMULATOR_AERODROME);
    expect(updated.flight.simulatorMinutes).toBe(120);
  });

  it('turning a simulator session back into a flight clears the simulator fields', async () => {
    const saved = await addFlight(fstdInput());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const updated = await updateFlight(saved.flight.id, {
      entryType: 'flight',
      depAerodrome: 'ENGM',
      arrAerodrome: 'ENBR',
      offBlock: '10:00',
      onBlock: '11:30',
      registration: 'LN-ABC',
      totalMinutes: 90,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    expect(updated.flight.simulatorMinutes).toBe(0);
    expect(updated.flight.simulatorRegistration).toBe('');
    expect(updated.flight.totalMinutes).toBe(90);
  });
});
