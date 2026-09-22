/**
 * Restore from backup.
 *
 * THE GOVERNING RULE these tests defend: a restore never leaves the logbook in
 * a state that is neither the old one nor the new one. Every rejection case
 * below asserts not only that the file was refused, but that the logbook still
 * holds exactly what it held before — a refusal that quietly wiped half the
 * data would pass a weaker test and fail the user.
 *
 * The reader is pure, so its cases need no database. The writer's atomicity is
 * asserted through the storage layer, because that is the boundary the
 * guarantee actually lives on.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBackup } from './restore';
import {
  addFlight,
  getFlight,
  listFlights,
  getAllAircraft,
  upsertAircraft,
  getSettings,
  updateSettings,
  restoreBackup,
  type Flight,
  type NewFlightInput,
} from '../storage';
import { db } from '../storage/db';
import { serializeJson } from '../export/json';
import { EXPORT_FORMAT_ID, EXPORT_FORMAT_VERSION } from '../export/types';
import { CURRENT_SCHEMA_VERSION } from '../domain/flight';
import { SAMPLE_AIRCRAFT, SAMPLE_FLIGHTS } from '../export/fixtures/sample-logbook';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const V1_BACKUP = readFileSync(path.join(FIXTURE_DIR, 'v1-backup.json'), 'utf8');

const OPTIONS = { appVersion: '0.1.0', exportedAt: '2026-08-06T09:14:00.000Z' };

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
});

/** A real export string, produced by the real serializer. */
function backupText(
  flights: readonly Flight[] = SAMPLE_FLIGHTS,
  aircraft = SAMPLE_AIRCRAFT,
): string {
  return serializeJson({ flights, aircraft }, OPTIONS);
}

/** An envelope with one key tampered with, as a hand-edited file would be. */
function tampered(mutate: (envelope: Record<string, unknown>) => void): string {
  const envelope = JSON.parse(backupText()) as Record<string, unknown>;
  mutate(envelope);
  return JSON.stringify(envelope, null, 2);
}

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
    ...overrides,
  } as NewFlightInput;
}

/** Put something in the logbook that a bad restore would be caught destroying. */
async function seedExistingLogbook(): Promise<{ flights: number; aircraft: number }> {
  await addFlight(flightInput());
  await addFlight(flightInput({ date: '2026-08-02', offBlock: '14:00', onBlock: '15:00' }));
  await upsertAircraft({ registration: 'LN-ABC', type: 'C172', class: 'SE', multiPilot: false });
  return { flights: 2, aircraft: 1 };
}

async function currentCounts() {
  const [flights, aircraft] = await Promise.all([listFlights(), getAllAircraft()]);
  return { flights: flights.length, aircraft: aircraft.length };
}

/** Read a file, then restore it. The whole flow, as the panel runs it. */
async function readAndRestore(text: string) {
  const result = readBackup(text);
  if (!result.ok) throw new Error(`expected an acceptable backup: ${result.rejection.message}`);
  return restoreBackup({ flights: result.flights, aircraft: result.aircraft });
}

describe('readBackup — accepting a real backup', () => {
  it('accepts a file this app exported and reports its contents', () => {
    const result = readBackup(backupText());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.flightCount).toBe(SAMPLE_FLIGHTS.length);
    expect(result.summary.aircraftCount).toBe(SAMPLE_AIRCRAFT.length);
    expect(result.summary.exportedAt).toBe(OPTIONS.exportedAt);
    expect(result.summary.appVersion).toBe(OPTIONS.appVersion);
    expect(result.summary.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(result.summary.schemaVersions).toEqual([CURRENT_SCHEMA_VERSION]);
    expect(result.flights).toHaveLength(SAMPLE_FLIGHTS.length);
  });

  it('accepts an envelope with zero flights, and restoring it empties the logbook', async () => {
    // Alarming, but real: the confirmation box is what makes sure it was meant.
    await seedExistingLogbook();

    const result = readBackup(backupText([], []));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.flightCount).toBe(0);

    const outcome = await restoreBackup({ flights: result.flights, aircraft: result.aircraft });
    expect(outcome.ok).toBe(true);
    expect(await currentCounts()).toEqual({ flights: 0, aircraft: 0 });
  });

  it('accepts an envelope with no aircraft key at all', () => {
    const result = readBackup(tampered((e) => delete e.aircraft));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aircraft).toEqual([]);
    expect(result.summary.aircraftCount).toBe(0);
  });
});

describe('restore — round trips', () => {
  it('export -> restore -> export is byte-identical', async () => {
    for (const flight of SAMPLE_FLIGHTS) await db.flights.add(flight);
    for (const aircraft of SAMPLE_AIRCRAFT) await db.aircraft.add(aircraft);

    const first = serializeJson(
      { flights: await listFlights(), aircraft: await getAllAircraft() },
      OPTIONS,
    );

    await readAndRestore(first);

    const second = serializeJson(
      { flights: await listFlights(), aircraft: await getAllAircraft() },
      OPTIONS,
    );
    expect(second).toBe(first);
  });

  it('every restored flight deep-equals the original, extra included', async () => {
    await readAndRestore(backupText());

    for (const original of SAMPLE_FLIGHTS) {
      const restored = await getFlight(original.id);
      expect(restored).toEqual(original);
    }
  });

  it('restores nested objects and arrays inside extra intact', async () => {
    const nested: Flight = {
      ...SAMPLE_FLIGHTS[0],
      id: 'nested-extra-flight',
      extra: {
        approaches: [{ type: 'ILS', runway: '01L' }, { type: 'RNP', runway: '19R' }],
        crew: { captain: 'A', relief: null },
        tags: ['training', 'night'],
      },
    };

    await readAndRestore(backupText([nested], []));

    const restored = await getFlight('nested-extra-flight');
    expect(restored?.extra).toEqual(nested.extra);
  });

  it('restores the aircraft table in full', async () => {
    await readAndRestore(backupText());

    expect(await getAllAircraft()).toEqual([...SAMPLE_AIRCRAFT].sort((a, b) =>
      a.registration < b.registration ? -1 : a.registration > b.registration ? 1 : 0,
    ));
  });

  it('migrates a v1 backup to the current schema in one pass', async () => {
    // The permanent fixture. If this test fails, the change is wrong, not the
    // fixture — that is the whole point of schemaVersion.
    const result = readBackup(V1_BACKUP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.schemaVersions).toEqual([1]);

    await restoreBackup({ flights: result.flights, aircraft: result.aircraft });

    const restored = await getFlight('11111111-2222-4333-8444-555555555555');
    expect(restored?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    // v2 fields filled, v3 discriminator set, and nothing invented.
    expect(restored?.entryType).toBe('flight');
    expect(restored?.simulatorMinutes).toBe(0);
    expect(restored?.simulatorRegistration).toBe('');
    expect(restored?.ifrMinutes).toBe(0);
    expect(restored?.totalMinutes).toBe(42);
    expect(restored?.remarks).toBe('Night x-country, "quoted" text; commas, and åøæ');
    // Unknown keys survive untouched.
    expect(restored?.extra).toEqual({
      approaches: 2,
      customTag: 'x-country',
      importedFrom: 'paper-logbook',
    });
  });
});

describe('readBackup — refusing a file, without touching the logbook', () => {
  /** Every rejection must leave the existing logbook exactly as it was. */
  async function expectRejectedAndUntouched(text: string, code: string) {
    const before = await seedExistingLogbook();
    const result = readBackup(text);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe(code);
    expect(result.rejection.message).not.toBe('');
    expect(await currentCounts()).toEqual(before);
  }

  it('refuses a formatVersion newer than this build reads', async () => {
    const text = tampered((e) => (e.formatVersion = EXPORT_FORMAT_VERSION + 1));
    await expectRejectedAndUntouched(text, 'future-format');

    const result = readBackup(text);
    if (result.ok) throw new Error('expected a rejection');
    // The message must name the version problem, not just "cannot read file".
    expect(result.rejection.message).toContain(String(EXPORT_FORMAT_VERSION + 1));
    expect(result.rejection.message.toLowerCase()).toContain('newer version');
  });

  it('refuses the whole file when any record cannot be migrated', async () => {
    const text = tampered((e) => {
      const flights = e.flights as Record<string, unknown>[];
      flights[1].schemaVersion = 99; // from the future
    });
    await expectRejectedAndUntouched(text, 'migration-failed');

    const result = readBackup(text);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.rejection.details[0]).toContain('Flight 2');
  });

  it('refuses the whole file when any record is invalid', async () => {
    const text = tampered((e) => {
      const flights = e.flights as Record<string, unknown>[];
      flights[0].date = 'not-a-date';
    });
    await expectRejectedAndUntouched(text, 'invalid-records');

    const result = readBackup(text);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.rejection.details[0]).toContain('Flight 1');
  });

  it('refuses a file whose flightCount disagrees with its flight list', async () => {
    // Truncation. A truncated backup that restores "successfully" is the worst
    // outcome available.
    await expectRejectedAndUntouched(
      tampered((e) => (e.flightCount = (e.flightCount as number) + 3)),
      'count-mismatch',
    );
  });

  it('refuses a file containing repeated flight ids', async () => {
    await expectRejectedAndUntouched(
      tampered((e) => {
        const flights = e.flights as Record<string, unknown>[];
        flights[1].id = flights[0].id;
      }),
      'duplicate-ids',
    );
  });

  it('refuses a damaged aircraft list', async () => {
    await expectRejectedAndUntouched(
      tampered((e) => (e.aircraft = [{ type: 'C172' }])),
      'invalid-aircraft',
    );
  });

  it('gives unparseable text, foreign JSON and a CSV their own distinct messages', () => {
    const notJson = readBackup('this is not json at all');
    const foreign = readBackup(JSON.stringify({ hello: 'world' }));
    const csv = readBackup('Date,Departure Place,Arrival Place\n2026-08-01,ENGM,ENBR\n');

    expect(notJson.ok).toBe(false);
    expect(foreign.ok).toBe(false);
    expect(csv.ok).toBe(false);
    if (notJson.ok || foreign.ok || csv.ok) return;

    expect(notJson.rejection.code).toBe('not-json');
    expect(foreign.rejection.code).toBe('not-a-backup');
    expect(csv.rejection.code).toBe('looks-like-csv');
    // The CSV case must say what it actually is, not emit a parser error.
    expect(csv.rejection.message.toLowerCase()).toContain('spreadsheet');

    const messages = [notJson, foreign, csv].map((r) => (r.ok ? '' : r.rejection.message));
    expect(new Set(messages).size).toBe(3);
  });

  it('never throws, whatever it is handed', () => {
    const nasty: unknown[] = [
      '',
      '   ',
      '{',
      '[]',
      'null',
      '"a string"',
      '42',
      JSON.stringify({ format: EXPORT_FORMAT_ID }),
      JSON.stringify({ format: EXPORT_FORMAT_ID, formatVersion: 1 }),
      JSON.stringify({ format: EXPORT_FORMAT_ID, formatVersion: 1, flights: 'nope' }),
      undefined,
      null,
      123,
      {},
    ];

    for (const input of nasty) {
      expect(() => readBackup(input)).not.toThrow();
      expect(readBackup(input).ok).toBe(false);
    }
  });
});

describe('restoreBackup — atomicity', () => {
  it('leaves the logbook exactly as it was when a restore fails part-way', async () => {
    const before = await seedExistingLogbook();
    const beforeFlights = await listFlights();
    const beforeAircraft = await getAllAircraft();

    // A record IndexedDB cannot store: no value at the `id` key path. The write
    // fails after `clear()` has already run, which is precisely the window the
    // transaction exists to close.
    const broken = { ...SAMPLE_FLIGHTS[0], id: undefined } as unknown as Flight;
    const outcome = await restoreBackup({
      flights: [SAMPLE_FLIGHTS[1], broken],
      aircraft: SAMPLE_AIRCRAFT,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
    // Not a single record moved.
    expect(await currentCounts()).toEqual(before);
    expect(await listFlights()).toEqual(beforeFlights);
    expect(await getAllAircraft()).toEqual(beforeAircraft);
  });
});

describe('restore — what it must not touch', () => {
  it('does not write lastBackupAt and does not alter any setting', async () => {
    // Restoring is not backing up. The file may be two years old, and the
    // restored data has never been exported FROM THIS DEVICE — a new phone
    // showing "never backed up" is correct, and is the prompt the user needs.
    await updateSettings({ durationDisplay: 'hhmm', defaultAircraftClass: 'SE' });
    const before = await getSettings();
    expect(before.lastBackupAt).toBeNull();

    await readAndRestore(backupText());

    expect(await getSettings()).toEqual(before);
  });

  it('leaves an existing lastBackupAt alone rather than refreshing it', async () => {
    await updateSettings({ lastBackupAt: '2026-01-01T00:00:00.000Z', lastBackupFormat: 'json' });

    await readAndRestore(backupText());

    const after = await getSettings();
    expect(after.lastBackupAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('changes nothing when the restore is never confirmed', async () => {
    // Cancelling the dialog means restoreBackup is simply never called; reading
    // the file must have had no effect of its own.
    const before = await seedExistingLogbook();
    const beforeFlights = await listFlights();

    const result = readBackup(backupText());
    expect(result.ok).toBe(true);

    expect(await currentCounts()).toEqual(before);
    expect(await listFlights()).toEqual(beforeFlights);
  });
});

describe('readBackup — purity', () => {
  it('is pure: no clock, no mutation, same input same output', () => {
    const text = backupText();
    const first = readBackup(text);
    const second = readBackup(text);

    expect(second).toEqual(first);
    // Nothing in the result may carry a "now" — the summary is a function of
    // the file alone, which is what lets the dialog be rendered from it.
    if (!first.ok) throw new Error('expected an acceptable backup');
    expect(first.summary.exportedAt).toBe(OPTIONS.exportedAt);

    // The caller's string is unchanged, and each call parses fresh records
    // rather than handing back references into anything shared.
    expect(text).toBe(backupText());
    const untouched = first.flights[0].remarks;
    first.flights[0].remarks = 'mutated by the caller';
    const third = readBackup(text);
    if (!third.ok) throw new Error('expected an acceptable backup');
    expect(third.flights[0].remarks).toBe(untouched);
  });
});
