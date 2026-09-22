import { describe, it, expect } from 'vitest';
import { buildIataIndex, loadIataIndex } from './iata';
import type { Airport } from './types';

/**
 * The pairing rule is tested on a hand-made list, because it is a rule about
 * coincident coordinates rather than about any particular aerodrome. The last
 * block then checks the real generated list, which is what actually ships.
 */

const at = (code: string, lat: number, lon: number): Airport => ({ code, lat, lon });

describe('pairing an IATA code with its ICAO code', () => {
  it('pairs two entries that sit on exactly the same point', () => {
    // This is how the generated list stores an alias: the same coordinates,
    // written by the same row of the same source file.
    const index = buildIataIndex([at('ENGM', 60.1939, 11.1004), at('OSL', 60.1939, 11.1004)]);
    expect(index.toIcao('OSL')).toBe('ENGM');
    expect(index.size).toBe(1);
  });

  it('does not care how the code was typed', () => {
    const index = buildIataIndex([at('ENGM', 60.1939, 11.1004), at('OSL', 60.1939, 11.1004)]);
    expect(index.toIcao('  osl ')).toBe('ENGM');
  });

  it('hands a four-letter code straight back', () => {
    // So a caller may pass a mixed file through without sorting it first.
    const index = buildIataIndex([]);
    expect(index.toIcao('ENGM')).toBe('ENGM');
    expect(index.toIcao('engm')).toBe('ENGM');
  });

  it('says nothing about a three-letter code with no ICAO code beside it', () => {
    // 519 entries in the real list are like this. Refusing to answer is what
    // lets the importer keep the code as written and say which ones they were.
    const index = buildIataIndex([at('FEA', 60.6417, -0.9464)]);
    expect(index.toIcao('FEA')).toBeUndefined();
  });

  it('says nothing when two ICAO codes claim one point', () => {
    // Ambiguity is not something to pick a winner from: the answer would be
    // right half the time and wrong silently the other half.
    const index = buildIataIndex([
      at('AAAA', 1, 1),
      at('BBBB', 1, 1),
      at('XYZ', 1, 1),
    ]);
    expect(index.toIcao('XYZ')).toBeUndefined();
    expect(index.size).toBe(0);
  });

  it('does not pair entries that merely sit close together', () => {
    // The match is on the stored integers, which are ten-thousandths of a
    // degree. Two aerodromes eleven metres apart are still two aerodromes.
    const index = buildIataIndex([at('ENGM', 60.1939, 11.1004), at('OSL', 60.194, 11.1004)]);
    expect(index.toIcao('OSL')).toBeUndefined();
  });

  it('ignores codes that are not three or four letters', () => {
    const index = buildIataIndex([
      at('K1F0', 40, -80),
      at('00AA', 40, -80),
      at('AHD', 40, -80),
    ]);
    // `K1F0` and `00AA` contain digits, so neither is an ICAO location
    // indicator and there is nothing for `AHD` to pair with.
    expect(index.toIcao('AHD')).toBeUndefined();
  });

  it('says nothing about an empty or unreadable code', () => {
    const index = buildIataIndex([at('ENGM', 60.1939, 11.1004), at('OSL', 60.1939, 11.1004)]);
    expect(index.toIcao('')).toBeUndefined();
    expect(index.toIcao(null)).toBeUndefined();
    expect(index.toIcao(undefined)).toBeUndefined();
  });
});

describe('the real generated list', () => {
  it('loads once and hands the same index to everyone', async () => {
    const [first, second] = await Promise.all([loadIataIndex(), loadIataIndex()]);
    expect(first).toBe(second);
  });

  it('knows the aerodromes the committed seed guarantees', async () => {
    // Asserted by behaviour and by a handful of codes the seed carries, never
    // by the size of the file — the same rule `lookup.test.ts` follows, so a
    // regenerated list does not have to come with a test edit.
    const index = await loadIataIndex();
    expect(index.toIcao('OSL')).toBe('ENGM');
    expect(index.toIcao('BGO')).toBe('ENBR');
    expect(index.toIcao('CPH')).toBe('EKCH');
    expect(index.toIcao('LHR')).toBe('EGLL');
    expect(index.size).toBeGreaterThan(0);
  });
});
