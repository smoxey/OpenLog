/**
 * The opening balance's round trip: settings → JSON backup → restore.
 *
 * This exists because of the hole that was found while planning Phase 4. The
 * backup envelope carried flights and aircraft and nothing else, so a balance
 * living only in settings would have vanished on a restore to a new device and
 * left every all-time total quietly wrong — in the exact scenario the backup
 * exists to protect.
 *
 * The load-bearing assertion is the first one: a logbook with NO balance must
 * still export byte-identical output, or the permanent export fixtures have
 * been changed by a step that promised not to touch them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildEnvelope, serializeJson } from './json';
import { EXPORT_FORMAT_VERSION } from './types';
import {
  SAMPLE_FLIGHTS,
  SAMPLE_AIRCRAFT,
  SAMPLE_EXPORTED_AT,
  SAMPLE_APP_VERSION,
} from './fixtures/sample-logbook';
import { readBackup } from '../import/restore';
import { db } from '../storage/db';
import { addFlight, getSettings, restoreBackup, updateSettings } from '../storage';

const OPTIONS = { appVersion: SAMPLE_APP_VERSION, exportedAt: SAMPLE_EXPORTED_AT };
const BUNDLE = { flights: SAMPLE_FLIGHTS, aircraft: SAMPLE_AIRCRAFT };

const FIXTURE = readFileSync(
  path.resolve('src/lib/export/fixtures/sample-export.json'),
  'utf8',
);

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
});

describe('a logbook with nothing carried forward', () => {
  it('exports byte-identical output to the permanent fixture', () => {
    expect(serializeJson(BUNDLE, OPTIONS)).toBe(FIXTURE);
  });

  it('omits the key entirely rather than writing an empty object', () => {
    const envelope = buildEnvelope(BUNDLE, OPTIONS);
    expect('openingBalance' in envelope).toBe(false);
  });

  it('omits it for an all-zero balance too', () => {
    const envelope = buildEnvelope({ ...BUNDLE, openingBalance: { totalMinutes: 0 } }, OPTIONS);
    expect('openingBalance' in envelope).toBe(false);
  });

  it('keeps the envelope at format version 1 — an absent key is not a new format', () => {
    expect(buildEnvelope(BUNDLE, OPTIONS).formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(EXPORT_FORMAT_VERSION).toBe(1);
  });
});

describe('a logbook with a balance', () => {
  it('writes it into the envelope', () => {
    const envelope = buildEnvelope(
      { ...BUNDLE, openingBalance: { totalMinutes: 60000, landingsDay: 412 } },
      OPTIONS,
    );
    expect(envelope.openingBalance).toEqual({ totalMinutes: 60000, landingsDay: 412 });
  });

  it('sanitizes on the way out, so a bad figure never reaches a file', () => {
    const envelope = buildEnvelope(
      { ...BUNDLE, openingBalance: { totalMinutes: 600, madeUp: 5 } },
      OPTIONS,
    );
    expect(envelope.openingBalance).toEqual({ totalMinutes: 600 });
  });

  it('round-trips through readBackup', () => {
    const text = serializeJson({ ...BUNDLE, openingBalance: { totalMinutes: 600 } }, OPTIONS);
    const result = readBackup(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.openingBalance).toEqual({ totalMinutes: 600 });
  });
});

describe('reading a backup', () => {
  it('reports null for a file that never mentioned a balance', () => {
    const result = readBackup(FIXTURE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.openingBalance).toBeNull();
  });

  it('refuses a file whose balance is damaged, all or nothing', () => {
    const envelope = JSON.parse(FIXTURE);
    envelope.openingBalance = { totalMinutes: 'lots' };
    const result = readBackup(JSON.stringify(envelope));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe('invalid-opening-balance');
  });

  it('refuses a file carrying a column that is not a real one', () => {
    const envelope = JSON.parse(FIXTURE);
    envelope.openingBalance = { inventedColumn: 60 };
    const result = readBackup(JSON.stringify(envelope));
    expect(result.ok).toBe(false);
  });
});

describe('restoring', () => {
  async function seedOneFlight() {
    await addFlight({
      date: '2024-01-01',
      depAerodrome: 'ENGM',
      arrAerodrome: 'ENBR',
      offBlock: '08:00',
      onBlock: '09:00',
      aircraftType: 'C172',
      registration: 'LN-ABC',
      picName: '',
      totalMinutes: 60,
    });
  }

  it('applies the balance the file carried', async () => {
    await seedOneFlight();
    const outcome = await restoreBackup({
      flights: [],
      aircraft: [],
      openingBalance: { totalMinutes: 600 },
    });
    expect(outcome.ok).toBe(true);
    expect((await getSettings()).openingBalance).toEqual({ totalMinutes: 600 });
  });

  it('leaves an existing balance alone when the file said nothing about it', async () => {
    // NULL IS NOT ZERO. Restoring an older backup must not silently wipe hours
    // the pilot entered on this device.
    await updateSettings({ openingBalance: { totalMinutes: 600 } });
    await restoreBackup({ flights: [], aircraft: [], openingBalance: null });
    expect((await getSettings()).openingBalance).toEqual({ totalMinutes: 600 });
  });

  it('leaves it alone when the field is omitted entirely', async () => {
    await updateSettings({ openingBalance: { totalMinutes: 600 } });
    await restoreBackup({ flights: [], aircraft: [] });
    expect((await getSettings()).openingBalance).toEqual({ totalMinutes: 600 });
  });

  it('replaces an existing balance with the file’s', async () => {
    await updateSettings({ openingBalance: { totalMinutes: 600 } });
    await restoreBackup({
      flights: [],
      aircraft: [],
      openingBalance: { totalMinutes: 1200 },
    });
    expect((await getSettings()).openingBalance).toEqual({ totalMinutes: 1200 });
  });

  it('keeps the other display settings untouched', async () => {
    await updateSettings({ durationDisplay: 'hhmm', showSimulatorEntries: false });
    await restoreBackup({
      flights: [],
      aircraft: [],
      openingBalance: { totalMinutes: 600 },
    });
    const settings = await getSettings();
    expect(settings.durationDisplay).toBe('hhmm');
    expect(settings.showSimulatorEntries).toBe(false);
  });
});

describe('storing a balance', () => {
  it('drops a bad figure before it reaches disk', async () => {
    await updateSettings({
      openingBalance: { totalMinutes: 600, picMinutes: -5, madeUp: 10 } as Record<string, number>,
    });
    expect((await getSettings()).openingBalance).toEqual({ totalMinutes: 600 });
  });

  it('defaults to nothing carried forward', async () => {
    expect((await getSettings()).openingBalance).toEqual({});
  });
});

describe('settings that do NOT travel in a backup', () => {
  it('leaves the night-time preference out of the envelope', async () => {
    // The opening balance is the ONE setting a backup carries, and it earns
    // that because a logbook restored without it is silently wrong. `autoNight`
    // is a preference about how this device's form behaves; carrying it would
    // mean a restore reaching across and changing how the new phone works.
    await updateSettings({ autoNight: false });

    const envelope = buildEnvelope(BUNDLE, OPTIONS);
    expect(envelope).not.toHaveProperty('autoNight');
    expect(serializeJson(BUNDLE, OPTIONS)).not.toContain('autoNight');
  });
});
