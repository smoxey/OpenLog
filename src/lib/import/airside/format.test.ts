import { describe, it, expect } from 'vitest';
import {
  AIRSIDE_HEADERS,
  hyphenateRegistration,
  looksLikeAirside,
  parseAirsideFlight,
  parseAirsideLanding,
  registrationPrefix,
  suggestAircraftType,
} from './format';

describe('recognising an Airside file', () => {
  it('claims a file with all nine columns', () => {
    expect(looksLikeAirside([...AIRSIDE_HEADERS])).toBe(true);
  });

  it('does not care about column order or extra columns', () => {
    expect(looksLikeAirside(['Landing', ...AIRSIDE_HEADERS, 'Something Else'])).toBe(true);
  });

  it('refuses a file missing even one column', () => {
    expect(looksLikeAirside(AIRSIDE_HEADERS.filter((h) => h !== 'Block on'))).toBe(false);
  });

  it('does not claim an RB export, whose columns are different', () => {
    expect(looksLikeAirside(['Date', 'Duty Type', 'Departure', 'Arrival', 'Out', 'In'])).toBe(false);
  });
});

describe('the packed Flight column', () => {
  it('unpacks a flight number, a date and a route', () => {
    expect(parseAirsideFlight('XY0123-20240115-OSL-BGO')).toEqual({
      number: 'XY0123',
      date: '2024-01-15',
      departure: 'OSL',
      arrival: 'BGO',
    });
  });

  it('accepts a numeric-only flight number and lower case', () => {
    expect(parseAirsideFlight('w62345-20240101-arn-cph')).toEqual({
      number: 'W62345',
      date: '2024-01-01',
      departure: 'ARN',
      arrival: 'CPH',
    });
  });

  it('refuses anything that is not the whole shape', () => {
    // The route is the dangerous part: a half-read cell would put two wrong
    // aerodromes in the logbook, so a cell that does not match entirely is not
    // read at all.
    for (const value of [
      '',
      'SCHEDULED',
      'XY0123-20240115-OSL',
      'XY0123-20240115-OSLO-BGO',
      'XY0123-2024011-OSL-BGO',
      'XY0123 20240115 OSL BGO',
    ]) {
      expect(parseAirsideFlight(value)).toBeNull();
    }
  });

  it('blanks a date the calendar does not have, and keeps the route', () => {
    // The date inside the identifier is never used to log the flight — the
    // Departure Date column is — so an impossible one costs nothing but must
    // not be passed off as real.
    expect(parseAirsideFlight('XY0123-20240230-OSL-BGO')).toEqual({
      number: 'XY0123',
      date: '',
      departure: 'OSL',
      arrival: 'BGO',
    });
  });
});

describe('putting the hyphen back into a registration', () => {
  const enabled = new Set(['SE', 'LN', 'OY', 'EI', 'G']);

  it('splits after a two-letter prefix', () => {
    expect(hyphenateRegistration('SEXYZ', enabled)).toBe('SE-XYZ');
    expect(hyphenateRegistration('OYXBT', enabled)).toBe('OY-XBT');
    expect(hyphenateRegistration('EIXSG', enabled)).toBe('EI-XSG');
  });

  it('splits after a one-letter prefix when no two-letter one matches', () => {
    expect(hyphenateRegistration('GABCD', enabled)).toBe('G-ABCD');
  });

  it('prefers the two-letter reading', () => {
    // `EI` is Ireland and `EC` is Spain; reading either as a one-letter prefix
    // would put the hyphen in the wrong place.
    expect(registrationPrefix('EIXSG')).toBe('EI');
    expect(registrationPrefix('ECMXA')).toBe('EC');
  });

  it('leaves a registration alone when its prefix was not enabled', () => {
    expect(hyphenateRegistration('SEXYZ', new Set())).toBe('SEXYZ');
  });

  it('leaves a registration that already has a hyphen exactly as it is', () => {
    expect(hyphenateRegistration('SE-XYZ', enabled)).toBe('SE-XYZ');
  });

  it('leaves a registry it does not know alone', () => {
    // The United States uses no hyphen. Inserting one would be a silent,
    // permanent change to a field nobody re-reads.
    expect(registrationPrefix('N12345')).toBe('');
    expect(hyphenateRegistration('N12345', enabled)).toBe('N12345');
    expect(hyphenateRegistration('JA8089', enabled)).toBe('JA8089');
  });

  it('does not split a value with nothing left after the prefix', () => {
    expect(registrationPrefix('SEA')).toBe('');
    expect(registrationPrefix('SE')).toBe('');
  });

  it('uppercases and trims', () => {
    expect(hyphenateRegistration('  sexyz ', enabled)).toBe('SE-XYZ');
  });

  it('says nothing about an empty cell', () => {
    expect(hyphenateRegistration('', enabled)).toBe('');
    expect(registrationPrefix(undefined)).toBe('');
  });
});

describe('model codes', () => {
  it('suggests the ICAO designator for codes it knows', () => {
    expect(suggestAircraftType('319')).toBe('A319');
    expect(suggestAircraftType('32N')).toBe('A320');
    expect(suggestAircraftType('73H')).toBe('B738');
  });

  it('passes an unknown code through unchanged rather than losing it', () => {
    expect(suggestAircraftType('XYZ')).toBe('XYZ');
    expect(suggestAircraftType('')).toBe('');
  });
});

describe('the Landing column', () => {
  it('reads the values a file might write', () => {
    expect(parseAirsideLanding('TRUE')).toBe(true);
    expect(parseAirsideLanding('true')).toBe(true);
    expect(parseAirsideLanding('1')).toBe(true);
    expect(parseAirsideLanding('Yes')).toBe(true);
  });

  it('reads anything else as no landing', () => {
    // A landing this app invented would be a currency claim the pilot never
    // made, so the unrecognised case fails towards nothing.
    for (const value of ['FALSE', '', '0', 'maybe', undefined]) {
      expect(parseAirsideLanding(value)).toBe(false);
    }
  });
});
