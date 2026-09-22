/**
 * Delete everything.
 *
 * The only operation whose whole purpose is destruction, with no undo and no
 * cloud copy behind it. These tests pin down exactly what it takes and exactly
 * what it leaves — because "delete all data" is a phrase, and the phrase is not
 * the contract.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  addFlight,
  deleteAllData,
  getAllAircraft,
  getSettings,
  listFlights,
  updateSettings,
  upsertAircraft,
} from './index';
import { db } from './db';

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
});

async function seed() {
  await addFlight({
    date: '2024-01-01',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '08:00',
    onBlock: '09:00',
    aircraftType: 'C172',
    registration: 'LN-ABC',
    picName: 'SELF',
    totalMinutes: 60,
  });
  await addFlight({
    date: '2024-01-02',
    depAerodrome: 'ENBR',
    arrAerodrome: 'ENGM',
    offBlock: '10:00',
    onBlock: '11:00',
    aircraftType: 'C172',
    registration: 'LN-ABC',
    picName: 'SELF',
    totalMinutes: 60,
  });
  await upsertAircraft({ registration: 'LN-ABC', type: 'C172', class: 'SE', multiPilot: false });
}

describe('what it deletes', () => {
  it('removes every flight and every aircraft', async () => {
    await seed();
    const outcome = await deleteAllData();

    expect(outcome.ok).toBe(true);
    expect(await listFlights()).toEqual([]);
    expect(await getAllAircraft()).toEqual([]);
  });

  it('reports what it destroyed, counted inside the transaction', async () => {
    // Counted as it deletes rather than beforehand, so the number is what
    // actually went — not what happened to be there when a dialog opened.
    await seed();
    const outcome = await deleteAllData();
    expect(outcome).toEqual({ ok: true, flightCount: 2, aircraftCount: 1 });
  });
});

describe('what it keeps', () => {
  it('leaves the display preferences alone', async () => {
    // They are not logbook data, losing them helps nobody, and setting them up
    // again after a deliberate reset would be a small insult on top of a large
    // action.
    await seed();
    await updateSettings({
      durationDisplay: 'hhmm',
      defaultAircraftClass: 'SE',
      spreadsheetFormat: 'european',
      showSimulatorEntries: false,
    });

    await deleteAllData();

    const after = await getSettings();
    expect(after.durationDisplay).toBe('hhmm');
    expect(after.defaultAircraftClass).toBe('SE');
    expect(after.spreadsheetFormat).toBe('european');
    expect(after.showSimulatorEntries).toBe(false);
  });
});

describe('what it resets', () => {
  it('clears the backup stamp, because an empty logbook was never backed up', async () => {
    // Keeping it would leave the app claiming a backup that covers data which
    // no longer exists — so the next flight entered would read "backed up 3
    // days ago" about something no backup contains.
    await seed();
    await updateSettings({ lastBackupAt: '2026-01-01T00:00:00.000Z', lastBackupFormat: 'json' });

    await deleteAllData();

    const after = await getSettings();
    expect(after.lastBackupAt).toBeNull();
    expect(after.lastBackupFormat).toBeNull();
  });

  it('does not create a settings row where there was none', async () => {
    await seed();
    await deleteAllData();
    // Defaults still apply; nothing was invented.
    expect((await getSettings()).durationDisplay).toBe('decimal');
  });
});

describe('edge cases', () => {
  it('succeeds on an already-empty logbook', async () => {
    const outcome = await deleteAllData();
    expect(outcome).toEqual({ ok: true, flightCount: 0, aircraftCount: 0 });
  });

  it('is idempotent', async () => {
    await seed();
    await deleteAllData();
    const second = await deleteAllData();
    expect(second).toEqual({ ok: true, flightCount: 0, aircraftCount: 0 });
  });

  it('reports a failure rather than throwing', async () => {
    await expect(deleteAllData()).resolves.toMatchObject({ ok: true });
  });

  it('leaves nothing behind for a later read to resurrect', async () => {
    await seed();
    await deleteAllData();
    expect(await db.flights.count()).toBe(0);
    expect(await db.aircraft.count()).toBe(0);
  });
});
