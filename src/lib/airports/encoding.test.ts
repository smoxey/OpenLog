import { describe, it, expect } from 'vitest';
import { decodeAirports, encodeAirport, encodeAirports } from './encoding';
import type { Airport } from './types';

const ENGM: Airport = { code: 'ENGM', lat: 60.1939, lon: 11.1004 };
const YSSY: Airport = { code: 'YSSY', lat: -33.9461, lon: 151.1772 };
const PANC: Airport = { code: 'PANC', lat: 61.1744, lon: -149.9963 };
const NULL_ISLAND: Airport = { code: 'ZZZZ', lat: 0, lon: 0 };

describe('the packed airport format', () => {
  it('round-trips a coordinate to within a metre or so', () => {
    // The format stores ten-thousandths of a degree — about 11 m. Far finer
    // than the night calculation can notice, and four decimal places is what a
    // source file typically carries anyway.
    const decoded = decodeAirports(encodeAirports([ENGM, YSSY, PANC, NULL_ISLAND]));

    for (const original of [ENGM, YSSY, PANC, NULL_ISLAND]) {
      const found = decoded.find((a) => a.code === original.code);
      expect(found, original.code).toBeDefined();
      expect(found!.lat).toBeCloseTo(original.lat, 4);
      expect(found!.lon).toBeCloseTo(original.lon, 4);
    }
  });

  it('keeps southern latitudes and western longitudes on the right side of zero', () => {
    // The offsets that make the packed integers positive are exactly where a
    // sign error would hide, and a hemisphere error produces a night
    // calculation that is confidently and completely wrong.
    const [sydney] = decodeAirports(encodeAirport(YSSY));
    expect(sydney.lat).toBeLessThan(0);
    expect(sydney.lon).toBeGreaterThan(0);

    const [anchorage] = decodeAirports(encodeAirport(PANC));
    expect(anchorage.lat).toBeGreaterThan(0);
    expect(anchorage.lon).toBeLessThan(0);
  });

  it('survives the extremes of both axes', () => {
    const extremes: Airport[] = [
      { code: 'NP', lat: 90, lon: 180 },
      { code: 'SP', lat: -90, lon: -180 },
    ];
    const decoded = decodeAirports(encodeAirports(extremes));
    expect(decoded).toHaveLength(2);
    expect(decoded.find((a) => a.code === 'NP')).toEqual({ code: 'NP', lat: 90, lon: 180 });
    expect(decoded.find((a) => a.code === 'SP')).toEqual({ code: 'SP', lat: -90, lon: -180 });
  });

  it('sorts by code, so a regenerated file is a reviewable diff', () => {
    const lines = encodeAirports([YSSY, ENGM, PANC]).split('\n');
    expect(lines.map((l) => l.slice(0, 4))).toEqual(['ENGM', 'PANC', 'YSSY']);
  });

  it('drops a damaged line instead of throwing', () => {
    // One corrupt line costs one aerodrome — which surfaces as "not in the
    // airport list" and no suggestion. An exception here would cost the whole
    // entry form.
    const good = encodeAirport(ENGM);
    const decoded = decodeAirports(`${good}\nrubbish\n\n,,\nEGLL,zzzz\n`);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].code).toBe('ENGM');
  });

  it('reads an empty list as an empty list', () => {
    expect(decodeAirports('')).toEqual([]);
    expect(encodeAirports([])).toBe('');
  });
});
