import { describe, it, expect, beforeEach } from 'vitest';
import {
  addFlight,
  updateFlight,
  getFlight,
  getAircraft,
  upsertAircraft,
  getAllAircraft,
  deleteAircraft,
  getSettings,
  updateSettings,
} from './index';
import { deriveAircraftTimes } from '../domain/derive';
import type { NewFlightInput } from '../domain/flight';
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

/**
 * Mirrors what the entry form does on save: resolve the aircraft, read the
 * fallback class FROM SETTINGS AT THIS MOMENT, derive, then write. Everything
 * downstream sees a flight with concrete values and no idea which path they
 * came from — which is the whole point of "derived, but stored".
 */
async function enterFlight(base: NewFlightInput = input(), touched: string[] = []) {
  const settings = await getSettings();
  const aircraft = await getAircraft(base.registration);
  const derived = deriveAircraftTimes(
    {
      totalMinutes: base.totalMinutes,
      singlePilotSeMinutes: base.singlePilotSeMinutes ?? 0,
      singlePilotMeMinutes: base.singlePilotMeMinutes ?? 0,
      multiPilotMinutes: base.multiPilotMinutes ?? 0,
    },
    aircraft,
    settings.defaultAircraftClass,
    touched,
  );
  return addFlight({ ...base, ...derived });
}

beforeEach(async () => {
  await db.flights.clear();
  await db.settings.clear();
  await db.aircraft.clear();
});

describe('aircraft store CRUD', () => {
  it('round-trips a record', async () => {
    await upsertAircraft({ registration: 'LN-ABC', type: 'C172', class: 'SE', multiPilot: false });
    expect(await getAircraft('LN-ABC')).toEqual({
      registration: 'LN-ABC',
      type: 'C172',
      class: 'SE',
      multiPilot: false,
    });
  });

  it('returns undefined for an unknown or blank registration', async () => {
    expect(await getAircraft('LN-XYZ')).toBeUndefined();
    expect(await getAircraft('   ')).toBeUndefined();
  });

  it('replaces rather than duplicating on a second upsert', async () => {
    await upsertAircraft({ registration: 'LN-ABC', type: 'C172', class: 'SE', multiPilot: false });
    await upsertAircraft({ registration: 'LN-ABC', type: 'PA34', class: 'ME', multiPilot: true });

    const all = await getAllAircraft();
    expect(all).toHaveLength(1);
    expect(all[0].class).toBe('ME');
    expect(all[0].multiPilot).toBe(true);
  });

  it('lists every aircraft ordered by registration', async () => {
    await upsertAircraft({ registration: 'LN-DEF', type: 'PA28', class: 'SE', multiPilot: false });
    await upsertAircraft({ registration: 'LN-ABC', type: 'C172', class: 'SE', multiPilot: false });
    expect((await getAllAircraft()).map((a) => a.registration)).toEqual(['LN-ABC', 'LN-DEF']);
  });

  it('deletes a record', async () => {
    await upsertAircraft({ registration: 'LN-ABC', type: 'C172', class: 'SE', multiPilot: false });
    await deleteAircraft('ln-abc');
    expect(await getAircraft('LN-ABC')).toBeUndefined();
  });

  it('rejects a blank registration', async () => {
    await expect(
      upsertAircraft({ registration: '  ', type: 'C172', class: 'SE', multiPilot: false }),
    ).rejects.toThrow(/registration/i);
  });
});

describe('registration normalisation', () => {
  it('resolves ln-abc, "LN-ABC  " and LN-ABC to one aircraft record', async () => {
    await upsertAircraft({ registration: 'ln-abc', type: 'C172', class: 'SE', multiPilot: false });
    await upsertAircraft({ registration: 'LN-ABC  ', type: 'C172', class: 'ME', multiPilot: false });
    await upsertAircraft({ registration: 'LN-ABC', type: 'C172', class: 'ME', multiPilot: true });

    const all = await getAllAircraft();
    expect(all).toHaveLength(1);
    expect(all[0].registration).toBe('LN-ABC');

    // All three spellings find the same record.
    for (const spelling of ['ln-abc', 'LN-ABC  ', 'LN-ABC', '  Ln-AbC ']) {
      const found = await getAircraft(spelling);
      expect(found?.registration).toBe('LN-ABC');
      expect(found?.multiPilot).toBe(true);
    }
  });

  it('stores the normalised form, not what was typed', async () => {
    const saved = await upsertAircraft({
      registration: '  ln-abc ',
      type: '  C172 ',
      class: 'SE',
      multiPilot: false,
    });
    expect(saved.registration).toBe('LN-ABC');
    expect(saved.type).toBe('C172');
  });

  it('derives the same column however the registration was typed', async () => {
    await upsertAircraft({ registration: 'LN-ABC', type: 'PA34', class: 'ME', multiPilot: false });

    for (const spelling of ['ln-abc', 'LN-ABC  ', 'LN-ABC']) {
      const result = await enterFlight(input({ registration: spelling }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.flight.singlePilotMeMinutes).toBe(90);
      expect(result.flight.singlePilotSeMinutes).toBe(0);
    }
  });
});

describe('defaultAircraftClass setting', () => {
  it('defaults to ME on a fresh install with nothing persisted', async () => {
    expect((await getSettings()).defaultAircraftClass).toBe('ME');
  });

  it('persists a change', async () => {
    await updateSettings({ defaultAircraftClass: 'SE' });
    expect((await getSettings()).defaultAircraftClass).toBe('SE');
  });

  it('does not disturb the duration display setting', async () => {
    await updateSettings({ defaultAircraftClass: 'SE' });
    expect((await getSettings()).durationDisplay).toBe('decimal');
  });
});

describe('entry — known aircraft', () => {
  it('derives SE for a single-engine aircraft', async () => {
    await upsertAircraft({ registration: 'LN-ABC', type: 'C172', class: 'SE', multiPilot: false });
    const result = await enterFlight();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flight.singlePilotSeMinutes).toBe(90);
    expect(result.flight.singlePilotMeMinutes).toBe(0);
    expect(result.flight.multiPilotMinutes).toBe(0);
  });

  it('derives ME for a multi-engine aircraft', async () => {
    await upsertAircraft({ registration: 'LN-ABC', type: 'PA34', class: 'ME', multiPilot: false });
    const result = await enterFlight();
    if (!result.ok) return;
    expect(result.flight.singlePilotMeMinutes).toBe(90);
    expect(result.flight.singlePilotSeMinutes).toBe(0);
  });

  it('routes a multi-pilot aircraft to multiPilotMinutes only', async () => {
    await upsertAircraft({ registration: 'LN-ABC', type: 'B738', class: 'ME', multiPilot: true });
    const result = await enterFlight();
    if (!result.ok) return;
    expect(result.flight.multiPilotMinutes).toBe(90);
    expect(result.flight.singlePilotSeMinutes).toBe(0);
    expect(result.flight.singlePilotMeMinutes).toBe(0);
  });
});

describe('entry — unknown aircraft with the prompt skipped', () => {
  it('saves successfully and files the time under the fallback class', async () => {
    await updateSettings({ defaultAircraftClass: 'ME' });
    const result = await enterFlight();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flight.singlePilotMeMinutes).toBe(90);
    expect(result.flight.singlePilotSeMinutes).toBe(0);
    // No aircraft record was created by skipping.
    expect(await getAllAircraft()).toHaveLength(0);
  });

  it('the same flight files differently under SE than under ME', async () => {
    await updateSettings({ defaultAircraftClass: 'SE' });
    const asSe = await enterFlight();

    await db.flights.clear();
    await updateSettings({ defaultAircraftClass: 'ME' });
    const asMe = await enterFlight();

    if (!asSe.ok || !asMe.ok) return;
    expect(asSe.flight.singlePilotSeMinutes).toBe(90);
    expect(asSe.flight.singlePilotMeMinutes).toBe(0);
    expect(asMe.flight.singlePilotSeMinutes).toBe(0);
    expect(asMe.flight.singlePilotMeMinutes).toBe(90);
  });
});

describe('derived, but stored — history never changes', () => {
  it('flipping defaultAircraftClass leaves an already-saved flight untouched', async () => {
    await updateSettings({ defaultAircraftClass: 'SE' });
    const saved = await enterFlight();
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const before = await getFlight(saved.flight.id);

    await updateSettings({ defaultAircraftClass: 'ME' });

    const after = await getFlight(saved.flight.id);
    expect(after).toEqual(before);
    expect(after?.singlePilotSeMinutes).toBe(90);
    expect(after?.singlePilotMeMinutes).toBe(0);
  });

  it('correcting an aircraft class does not alter a flight written before the change', async () => {
    await upsertAircraft({ registration: 'LN-ABC', type: 'C172', class: 'SE', multiPilot: false });
    const saved = await enterFlight();
    if (!saved.ok) return;
    const before = await getFlight(saved.flight.id);
    expect(before?.singlePilotSeMinutes).toBe(90);

    // Years later, the aircraft record is corrected.
    await upsertAircraft({ registration: 'LN-ABC', type: 'PA34', class: 'ME', multiPilot: true });

    const after = await getFlight(saved.flight.id);
    expect(after).toEqual(before);
    expect(after?.singlePilotSeMinutes).toBe(90);
    expect(after?.singlePilotMeMinutes).toBe(0);
    expect(after?.multiPilotMinutes).toBe(0);
  });

  it('a flight saved via the fallback is indistinguishable from one from a known aircraft', async () => {
    await updateSettings({ defaultAircraftClass: 'ME' });
    const viaFallback = await enterFlight();

    await db.flights.clear();
    await upsertAircraft({ registration: 'LN-ABC', type: 'PA34', class: 'ME', multiPilot: false });
    const viaAircraft = await enterFlight();

    if (!viaFallback.ok || !viaAircraft.ok) return;
    const strip = (f: Record<string, unknown>) => {
      const { id, ...rest } = f;
      return rest;
    };
    expect(strip(viaFallback.flight as unknown as Record<string, unknown>)).toEqual(
      strip(viaAircraft.flight as unknown as Record<string, unknown>),
    );
  });
});

describe('manual overrides', () => {
  it('survives save and reload', async () => {
    await upsertAircraft({ registration: 'LN-ABC', type: 'C172', class: 'SE', multiPilot: false });
    const saved = await enterFlight(
      input({ singlePilotSeMinutes: 30, singlePilotMeMinutes: 60 }),
      ['singlePilotSeMinutes', 'singlePilotMeMinutes'],
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const reloaded = await getFlight(saved.flight.id);
    expect(reloaded?.singlePilotSeMinutes).toBe(30);
    expect(reloaded?.singlePilotMeMinutes).toBe(60);
  });

  it('is not re-derived by an edit that touches an unrelated field', async () => {
    await upsertAircraft({ registration: 'LN-ABC', type: 'C172', class: 'SE', multiPilot: false });
    const saved = await enterFlight(input({ singlePilotSeMinutes: 30 }), ['singlePilotSeMinutes']);
    if (!saved.ok) return;

    const edited = await updateFlight(saved.flight.id, { remarks: 'checked' });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.flight.singlePilotSeMinutes).toBe(30);
    expect(edited.flight.remarks).toBe('checked');
  });

  it('a round trip through update with no changes is byte-identical', async () => {
    await updateSettings({ defaultAircraftClass: 'SE' });
    const saved = await enterFlight();
    if (!saved.ok) return;
    const before = await getFlight(saved.flight.id);

    // The setting changes between writing and re-opening the flight.
    await updateSettings({ defaultAircraftClass: 'ME' });

    // Re-save exactly what was loaded, as the edit form does when nothing changed.
    const roundTripped = await updateFlight(saved.flight.id, before!);
    expect(roundTripped.ok).toBe(true);
    if (!roundTripped.ok) return;
    expect(roundTripped.flight).toEqual(before);
  });
});
