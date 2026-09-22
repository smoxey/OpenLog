import { describe, it, expect } from 'vitest';
import { airportsIfLoaded, findAirport, loadAirports } from './lookup';

/**
 * These run against the real generated list, whatever it currently holds —
 * the committed seed today, a full world list once one is supplied. So they
 * assert the BEHAVIOUR of the lookup and only the handful of aerodromes the
 * seed guarantees, never the size of the file.
 */

describe('loading the list', () => {
  it('is not loaded until something asks', async () => {
    // First test in the file on purpose: the module caches for the life of the
    // process, so this is only observable before anything else has run.
    expect(airportsIfLoaded()).toBeNull();

    await loadAirports();
    expect(airportsIfLoaded()).not.toBeNull();
  });

  it('loads once and hands the same index to everyone', async () => {
    const [first, second] = await Promise.all([loadAirports(), loadAirports()]);
    expect(first).toBe(second);
    expect(first.size).toBeGreaterThan(0);
  });
});

describe('finding an aerodrome', () => {
  it('finds one by its ICAO code', async () => {
    const engm = await findAirport('ENGM');
    expect(engm).toBeDefined();
    expect(engm!.lat).toBeCloseTo(60.1939, 3);
    expect(engm!.lon).toBeCloseTo(11.1004, 3);
  });

  it('does not care how the pilot typed it', async () => {
    const messy = await findAirport('  engm  ');
    expect(messy?.code).toBe('ENGM');
  });

  it('finds one by its IATA code, when the list carries them', async () => {
    const oslo = await findAirport('OSL');
    expect(oslo?.lat).toBeCloseTo(60.1939, 3);
  });

  it('keeps the southern hemisphere south', async () => {
    // The one thing a packed coordinate format can get catastrophically wrong.
    const sydney = await findAirport('YSSY');
    expect(sydney!.lat).toBeCloseTo(-33.9461, 3);
    expect(sydney!.lon).toBeCloseTo(151.1772, 3);
  });

  it('never resolves the simulator sentinel', async () => {
    // "SIM" is stored in both aerodrome fields of every FSTD entry, and is
    // also a real IATA code. Resolving it would offer a night calculation for
    // a session that never left the building.
    expect(await findAirport('SIM')).toBeUndefined();
    expect(await findAirport(' sim ')).toBeUndefined();
  });

  it('answers nothing for an aerodrome it does not have', async () => {
    expect(await findAirport('ZZZZ')).toBeUndefined();
    expect(await findAirport('')).toBeUndefined();
    expect(await findAirport(null)).toBeUndefined();
    expect(await findAirport(undefined)).toBeUndefined();
  });

  it('is synchronous once the list is in memory', async () => {
    await loadAirports();
    const index = airportsIfLoaded();
    expect(index).not.toBeNull();
    expect(index!.get('EGLL')?.lat).toBeCloseTo(51.4707, 3);
  });
});
