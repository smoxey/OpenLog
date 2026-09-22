import { describe, it, expect } from 'vitest';
import { parseAirportSource, parseCoordinate } from './parseSource';

describe('reading a coordinate somebody typed', () => {
  it('reads plain decimal degrees', () => {
    expect(parseCoordinate('60.1939', 'lat')).toBeCloseTo(60.1939, 6);
    expect(parseCoordinate('-0.4614', 'lon')).toBeCloseTo(-0.4614, 6);
    expect(parseCoordinate(' 11.1004 ', 'lon')).toBeCloseTo(11.1004, 6);
  });

  it('reads a European decimal comma', () => {
    expect(parseCoordinate('60,1939', 'lat')).toBeCloseTo(60.1939, 6);
    expect(parseCoordinate('-118,4081', 'lon')).toBeCloseTo(-118.4081, 6);
  });

  it('reads degrees, minutes and seconds however they are punctuated', () => {
    // 60°11'38" = 60 + 11/60 + 38/3600 = 60.19389
    expect(parseCoordinate('60 11 38 N', 'lat')).toBeCloseTo(60.1939, 3);
    expect(parseCoordinate('N60°11\'38"', 'lat')).toBeCloseTo(60.1939, 3);
    expect(parseCoordinate('60:11:38N', 'lat')).toBeCloseTo(60.1939, 3);
    expect(parseCoordinate('601138N', 'lat')).toBeCloseTo(60.1939, 3);
  });

  it('reads degrees and decimal minutes', () => {
    // 60°11.63' = 60.19383
    expect(parseCoordinate('60 11.63 N', 'lat')).toBeCloseTo(60.1938, 3);
  });

  it('reads a three-digit packed longitude as three digits of degrees', () => {
    // 118°24'29"W = -118.408. Read from the right, so a longitude's extra
    // degree digit does not turn into an hour of minutes.
    expect(parseCoordinate('1182429W', 'lon')).toBeCloseTo(-118.408, 3);
  });

  it('takes the hemisphere from a letter or from a minus sign', () => {
    expect(parseCoordinate('33 56 46 S', 'lat')).toBeCloseTo(-33.946, 3);
    expect(parseCoordinate('S33 56 46', 'lat')).toBeCloseTo(-33.946, 3);
    expect(parseCoordinate('-33.9461', 'lat')).toBeCloseTo(-33.9461, 6);
    expect(parseCoordinate('149 59 47 W', 'lon')).toBeCloseTo(-149.996, 3);
  });

  it('keeps zero as zero, whichever way it is written', () => {
    expect(parseCoordinate('0', 'lat')).toBe(0);
    expect(parseCoordinate('0.0000', 'lon')).toBe(0);
  });

  it('refuses a value that is off the earth', () => {
    // A latitude of 118 is not a latitude — most likely the columns are the
    // other way round, and keeping it would put an aerodrome nowhere.
    expect(parseCoordinate('118.4081', 'lat')).toBeNaN();
    expect(parseCoordinate('-190', 'lon')).toBeNaN();
  });

  it('refuses what is not a number at all', () => {
    expect(parseCoordinate('', 'lat')).toBeNaN();
    expect(parseCoordinate('n/a', 'lat')).toBeNaN();
    expect(parseCoordinate(null, 'lat')).toBeNaN();
    expect(parseCoordinate(undefined, 'lon')).toBeNaN();
  });
});

describe('reading a supplied airport file', () => {
  const FILE = [
    'icao,iata,latitude,longitude,name',
    'ENGM,OSL,60.1939,11.1004,Oslo Gardermoen',
    'EGLL,LHR,51.4775,-0.4614,London Heathrow',
    'YSSY,SYD,-33.9461,151.1772,Sydney',
  ].join('\n');

  it('finds the columns by name and ignores the rest', () => {
    const result = parseAirportSource(FILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.columns).toEqual({
      code: 'icao',
      iata: 'iata',
      lat: 'latitude',
      lon: 'longitude',
    });
    expect(result.rejected).toEqual([]);
  });

  it('indexes the IATA code as well, without displacing an ICAO one', () => {
    const result = parseAirportSource(FILE);
    if (!result.ok) throw new Error(result.reason);

    const codes = result.airports.map((a) => a.code);
    expect(codes).toContain('ENGM');
    expect(codes).toContain('OSL');
    expect(result.aliases).toBe(3);
  });

  it('lets an ICAO code win a clash with an IATA one, whatever the row order', () => {
    // "BGO" is Bergen's IATA code. If some other aerodrome's ICAO code were
    // also BGO, the ICAO one has to win — the logbook stores ICAO, so that is
    // what a lookup is asking about. Row order must not decide it.
    const clashing = [
      'icao,iata,latitude,longitude',
      'ENBR,BGO,60.2934,5.2181', // the alias comes first in the file
      'BGO,XXX,10.0,20.0', // …and the real ICAO code second
    ].join('\n');

    const result = parseAirportSource(clashing);
    if (!result.ok) throw new Error(result.reason);

    const bgo = result.airports.find((a) => a.code === 'BGO');
    expect(bgo).toEqual({ code: 'BGO', lat: 10, lon: 20 });
  });

  it('can be told to ignore IATA codes entirely', () => {
    const result = parseAirportSource(FILE, { iata: false });
    if (!result.ok) throw new Error(result.reason);

    expect(result.aliases).toBe(0);
    expect(result.airports.map((a) => a.code)).toEqual(['ENGM', 'EGLL', 'YSSY']);
    expect(result.columns.iata).toBeNull();
  });

  it('refuses to ship SIM, which is both a sentinel and a real aerodrome', () => {
    // Every FSTD entry stores "SIM" in both aerodrome fields, and SIM is also
    // the IATA code for Simbai in Papua New Guinea. A simulator session that
    // resolved to a place would be given a night calculation for a flight that
    // never happened.
    const withSim = [
      'icao,iata,latitude,longitude',
      'SIM,ZZZ,-5.4917,144.5333',
      'AYSM,SIM,-5.4917,144.5333',
    ].join('\n');

    const result = parseAirportSource(withSim);
    if (!result.ok) throw new Error(result.reason);

    expect(result.airports.map((a) => a.code)).not.toContain('SIM');
    expect(result.rejected[0]).toMatchObject({ code: 'SIM', reason: expect.stringContaining('sentinel') });
  });

  it('reports every row it drops, with a reason and a row number', () => {
    const messy = [
      'icao,latitude,longitude',
      'ENGM,60.1939,11.1004',
      ',55.0,10.0', // no code
      'TOOLONGCODE,55.0,10.0', // not a code
      'EKCH,not a number,12.6561', // unreadable
    ].join('\n');

    const result = parseAirportSource(messy);
    if (!result.ok) throw new Error(result.reason);

    expect(result.airports).toHaveLength(1);
    expect(result.rejected.map((r) => r.row)).toEqual([3, 4, 5]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'no code',
      'code is not 2–6 letters or digits',
      expect.stringContaining('unreadable coordinates'),
    ]);
  });

  it('keeps the first of two rows with the same code, and says so', () => {
    const duplicated = [
      'icao,latitude,longitude',
      'ENGM,60.1939,11.1004',
      'ENGM,0.0,0.0',
    ].join('\n');

    const result = parseAirportSource(duplicated);
    if (!result.ok) throw new Error(result.reason);

    expect(result.airports).toHaveLength(1);
    expect(result.airports[0].lat).toBeCloseTo(60.1939, 4);
    expect(result.duplicates).toEqual(['ENGM']);
  });

  it('reads a semicolon-delimited file, because the CSV reader sniffs it', () => {
    const european = ['ident;lat;lon', 'ENGM;60,1939;11,1004'].join('\n');
    const result = parseAirportSource(european);
    if (!result.ok) throw new Error(result.reason);

    expect(result.airports[0]).toEqual({
      code: 'ENGM',
      lat: expect.closeTo(60.1939, 4),
      lon: expect.closeTo(11.1004, 4),
    });
  });

  it('says what is missing rather than producing an empty list', () => {
    const noCode = parseAirportSource('name,latitude,longitude\nOslo,60.1,11.1');
    expect(noCode.ok).toBe(false);
    if (!noCode.ok) expect(noCode.reason).toContain('no code column');

    const noCoords = parseAirportSource('icao,name\nENGM,Oslo');
    expect(noCoords.ok).toBe(false);
    if (!noCoords.ok) expect(noCoords.reason).toContain('latitude/longitude');
  });
});
