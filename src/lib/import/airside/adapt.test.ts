import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCsv, type ParsedCsv } from '../csv';
import { buildMapping } from '../mapping';
import { buildImportPlan } from '../plan';
import { collectAircraftNeeds } from '../transform';
import { groupAircraftByType, resolveAircraft, seedAnswers } from '../aircraftAnswers';
import type { Airport } from '../../airports/types';
import { adaptAirside, ADAPTED_HEADERS, surveyAirside, type AirsideOptions } from './adapt';
import { AIRSIDE_PRESET } from './preset';

/**
 * The synthetic fixture, and a hand-made aerodrome table to read it against.
 *
 * The tables are INJECTED rather than taken from the bundled list, for the same
 * reason `suggestNightForEntry` takes its lookup as an argument: the behaviour
 * under test is the adaptation, and a test that also depended on 39,000 rows of
 * generated data would fail for reasons that have nothing to do with it.
 *
 * `FEA` is deliberately absent from `ICAO` and present in `COORDINATES` — it is
 * a real IATA code with no ICAO code, and the point is that such an aerodrome
 * still gets a night calculation. `ZZZ` is in neither.
 */
const ICAO: Record<string, string> = {
  OSL: 'ENGM',
  BGO: 'ENBR',
  TRD: 'ENVA',
  LHR: 'EGLL',
  LPA: 'GCLP',
  ARN: 'ESSA',
  TLL: 'EETN',
  CPH: 'EKCH',
  ABZ: 'EGPD',
};

const COORDINATES: Record<string, Airport> = {
  ENGM: { code: 'ENGM', lat: 60.1939, lon: 11.1004 },
  ENBR: { code: 'ENBR', lat: 60.2934, lon: 5.2181 },
  ENVA: { code: 'ENVA', lat: 63.4578, lon: 10.924 },
  EGLL: { code: 'EGLL', lat: 51.4775, lon: -0.4614 },
  GCLP: { code: 'GCLP', lat: 27.9319, lon: -15.3866 },
  ESSA: { code: 'ESSA', lat: 59.6519, lon: 17.9186 },
  EETN: { code: 'EETN', lat: 59.4133, lon: 24.8328 },
  EKCH: { code: 'EKCH', lat: 55.6181, lon: 12.6561 },
  EGPD: { code: 'EGPD', lat: 57.2019, lon: -2.1978 },
  FEA: { code: 'FEA', lat: 60.6417, lon: -0.9464 },
};

const deps = {
  toIcao: (code: string) => ICAO[code.toUpperCase()],
  lookupAirport: (code: string) => COORDINATES[code.toUpperCase()],
};

function fixture(): ParsedCsv {
  const result = parseCsv(readFileSync('src/lib/import/fixtures/airside.csv', 'utf8'));
  if (!result.ok) throw new Error(`fixture would not parse: ${result.rejection.message}`);
  return result.file;
}

function options(overrides: Partial<AirsideOptions> = {}): AirsideOptions {
  return {
    anchors: new Map([['OSL', 'Europe/Oslo']]),
    primaryAirport: 'OSL',
    hyphenPrefixes: new Set(['SE', 'OY']),
    aircraftTypes: new Map([
      ['32N', 'A320'],
      ['320', 'A320'],
      ['319', 'A319'],
    ]),
    computeNight: true,
    ...overrides,
  };
}

/** One adapted row, as an object, so a test can name the column it means. */
function cells(file: ParsedCsv, line: number): Record<string, string> {
  const row = file.rows.find((r) => r.line === line);
  if (!row) throw new Error(`no row on line ${line}`);
  return Object.fromEntries(ADAPTED_HEADERS.map((header, i) => [header, row.cells[i]]));
}

describe('the fixture itself', () => {
  it('carries the traps it exists to carry', () => {
    const raw = readFileSync('src/lib/import/fixtures/airside.csv', 'utf8');
    // CRLF and no trailing newline are both real properties of the format, and
    // `.gitattributes` marks this file `-text` so a checkout cannot rewrite
    // them. If this fails, that rule has been lost.
    expect(raw).toContain('\r\n');
    expect(raw.endsWith('\n')).toBe(false);
    expect(raw.charCodeAt(0)).not.toBe(0xfeff);
    expect(fixture().rows).toHaveLength(15);
  });
});

describe('surveying an Airside file', () => {
  const survey = surveyAirside(fixture());

  it('counts every aerodrome the file touches, busiest first', () => {
    // Twelve: the air return on line 11 touches it at both ends.
    expect(survey.airports[0]).toEqual({ code: 'OSL', count: 12 });
    expect(survey.airports.map((a) => a.code)).toContain('FEA');
  });

  it('groups registrations by the prefix that would be hyphenated', () => {
    expect(survey.prefixes.map((p) => p.prefix).sort()).toEqual(['OY', 'SE']);
    expect(survey.prefixes.every((p) => p.known)).toBe(true);
  });

  it('lists a registration whose registry it does not know, rather than guessing', () => {
    expect(survey.unrecognisedRegistrations).toEqual(['N12345']);
  });

  it('proposes a designator for each model code, and passes an unknown one through', () => {
    const byCode = Object.fromEntries(survey.models.map((m) => [m.code, m.suggestion]));
    expect(byCode).toEqual({ '32N': 'A320', '320': 'A320', '319': 'A319', ABC: 'ABC' });
  });

  it('names the row whose Flight column could not be read', () => {
    expect(survey.unreadableLines).toEqual([14]);
  });
});

describe('adapting an Airside file', () => {
  it('unpacks the Flight column into a number and an ICAO route', () => {
    const { file } = adaptAirside(fixture(), deps, options());
    const row = cells(file, 2);
    expect(row['Flight Number']).toBe('XY1001');
    expect(row.Departure).toBe('ENGM');
    expect(row.Arrival).toBe('ENBR');
  });

  it('converts the block times to UTC, and builds the on-block from the total', () => {
    // 15 January, Oslo is UTC+01:00. 08:00 local is 07:00Z, and 07:00 + 55
    // minutes is 07:55 — which is also what the file's own arrival time says.
    const { file } = adaptAirside(fixture(), deps, options());
    const row = cells(file, 2);
    expect(row.Date).toBe('2024-01-15');
    expect(row['Block Off']).toBe('07:00');
    expect(row['Block On']).toBe('07:55');
    expect(row['Total Time']).toBe('55');
  });

  it('works a foreign departure out from the row´s own arithmetic', () => {
    // London, anchored nowhere: 17:05 local against a 20:20 Oslo arrival and a
    // 135-minute total says London is UTC+0, so 17:05 local is 17:05Z.
    const row = cells(adaptAirside(fixture(), deps, options()).file, 5);
    expect(row.Departure).toBe('EGLL');
    expect(row['Block Off']).toBe('17:05');
    expect(row['Block On']).toBe('19:20');
  });

  it('moves the date back when the departure is after local midnight', () => {
    // The flight number says the 11th, the Departure Date column says the 12th
    // because the departure slipped, and 00:10 at UTC+02:00 is 22:10 on the
    // 11th in UTC. The logbook's date is the UTC date of the off-block.
    const { file, report } = adaptAirside(fixture(), deps, options());
    const row = cells(file, 9);
    expect(row.Date).toBe('2024-07-11');
    expect(row['Block Off']).toBe('22:10');
    expect(row['Block On']).toBe('23:20');
    expect(report.dateShifted).toBe(1);
    expect(report.scheduleMismatch).toEqual([9]);
  });

  it('expresses a sector landing after midnight as an on-block before its off-block', () => {
    const row = cells(adaptAirside(fixture(), deps, options()).file, 10);
    expect(row['Block Off']).toBe('21:40');
    expect(row['Block On']).toBe('03:00');
  });

  it('hyphenates the registrations whose prefix was confirmed, and only those', () => {
    const { file } = adaptAirside(fixture(), deps, options());
    expect(cells(file, 2).Registration).toBe('SE-XAA');
    expect(cells(file, 9).Registration).toBe('OY-XAA');
    expect(cells(file, 12).Registration).toBe('N12345');
  });

  it('leaves every registration alone when no prefix is confirmed', () => {
    const { file } = adaptAirside(fixture(), deps, options({ hyphenPrefixes: new Set() }));
    expect(cells(file, 2).Registration).toBe('SEXAA');
  });

  it('writes the designator the pilot chose for each model code', () => {
    const { file } = adaptAirside(
      fixture(),
      deps,
      options({ aircraftTypes: new Map([['32N', 'A20N']]) }),
    );
    expect(cells(file, 2)['Aircraft Type']).toBe('A20N');
    // A code with no answer falls back to the suggestion, never to nothing.
    expect(cells(file, 4)['Aircraft Type']).toBe('A320');
  });

  it('keeps an IATA code it cannot translate, and says which', () => {
    const { file, report } = adaptAirside(fixture(), deps, options());
    expect(cells(file, 12).Arrival).toBe('FEA');
    expect(report.unresolvedCodes).toEqual(['FEA', 'ZZZ']);
  });

  it('keeps a row whose Flight column would not read, rather than dropping it', () => {
    // The count of rows in must equal the count of rows out. A row that
    // vanished here would be indistinguishable from one that was never there.
    const { file, report } = adaptAirside(fixture(), deps, options());
    expect(file.rows).toHaveLength(15);
    expect(report.rowsRead).toBe(15);
    const row = cells(file, 14);
    expect(row.Departure).toBe('');
    expect(row.Arrival).toBe('');
    // What the cell said, so the pilot can find the row in their own file.
    expect(row['Flight Number']).toBe('SCHEDULED');
  });
});

describe('the zone, as the adapted file reports it', () => {
  it('marks the rows it had to assume, and only those', () => {
    const { file, report } = adaptAirside(fixture(), deps, options());
    // Lines 8, 12 and 13 touch no aerodrome any answer reaches.
    expect([...report.zonesAssumed]).toEqual([8, 12, 13]);
    expect(cells(file, 8)['Zone Assumed']).toBe('UTC+01:00');
    expect(cells(file, 2)['Zone Assumed']).toBe('');
  });

  it('assumes fewer rows the more aerodromes are named', () => {
    const one = adaptAirside(fixture(), deps, options());
    const three = adaptAirside(
      fixture(),
      deps,
      options({
        anchors: new Map([
          ['OSL', 'Europe/Oslo'],
          ['ARN', 'Europe/Stockholm'],
          ['ABZ', 'Europe/London'],
        ]),
      }),
    );
    expect(three.report.zonesAssumed.length).toBeLessThan(one.report.zonesAssumed.length);
    expect(three.report.zonesResolved).toBeGreaterThan(one.report.zonesResolved);
  });

  it('does not change a row it had already worked out when an anchor is added', () => {
    // The point of the whole mechanism: an offset derived from evidence is not
    // an opinion, so a second answer must not move it.
    const one = adaptAirside(fixture(), deps, options());
    const three = adaptAirside(
      fixture(),
      deps,
      options({
        anchors: new Map([
          ['OSL', 'Europe/Oslo'],
          ['ARN', 'Europe/Stockholm'],
          ['ABZ', 'Europe/London'],
        ]),
      }),
    );
    for (const line of [2, 3, 4, 5, 6, 7, 9, 10, 11, 15, 16]) {
      expect(cells(three.file, line)).toEqual(cells(one.file, line));
    }
  });
});

describe('night time and the landing columns', () => {
  it('works night out and puts a dark arrival in the night column', () => {
    // Line 7 blocks in at Oslo at 21:30 local in January. Line 2 blocks in at
    // Bergen at 08:55 local, before dawn in January but the calculation is what
    // decides that, not this test.
    const { file, report } = adaptAirside(fixture(), deps, options());
    expect(report.nightRows).toBeGreaterThan(0);
    expect(cells(file, 7)['Ldg Night']).toBe('1');
    expect(cells(file, 7)['Ldg Day']).toBe('0');
    expect(report.nightLandings).toBeGreaterThanOrEqual(1);
  });

  it('never invents a landing, whatever the sun was doing', () => {
    const { file } = adaptAirside(fixture(), deps, options());
    // Line 6 has Landing FALSE, and the pilot who did not land the aeroplane
    // does not get a landing because it happened to be dark.
    expect(cells(file, 6)['Ldg Day']).toBe('0');
    expect(cells(file, 6)['Ldg Night']).toBe('0');
  });

  it('files a landing it could not place as a day landing, and counts it', () => {
    // Line 13 arrives at ZZZ, which is in no list, so there is no answer about
    // the sun. A night landing quietly filed as a day one is a currency claim
    // that is wrong, so the number is reported rather than absorbed.
    const { file, report } = adaptAirside(fixture(), deps, options());
    expect(cells(file, 13)['Ldg Day']).toBe('1');
    expect(cells(file, 13)['Ldg Night']).toBe('0');
    expect(report.unplacedLandings).toBe(1);
    expect(report.nightMissingAerodromes).toEqual(['ZZZ']);
  });

  it('leaves every night column empty and every landing in Day when turned off', () => {
    const { file, report } = adaptAirside(fixture(), deps, options({ computeNight: false }));
    expect(report.nightRows).toBe(0);
    expect(report.nightMinutes).toBe(0);
    for (const row of file.rows) {
      expect(row.cells[9]).toBe('');
      expect(row.cells[11]).toBe('0');
    }
    expect(cells(file, 7)['Ldg Day']).toBe('1');
  });
});

describe('the adapted file through the ordinary importer', () => {
  function plan(overrides: Partial<AirsideOptions> = {}) {
    const adapted = adaptAirside(fixture(), deps, options(overrides));
    const mapping = buildMapping(adapted.file.headers, AIRSIDE_PRESET, {
      unit: 'minutes',
      decimal: '.',
    });
    const needs = collectAircraftNeeds(adapted.file.rows, mapping);
    const aircraft = resolveAircraft(
      needs,
      seedAnswers(groupAircraftByType(needs), [], 'ME'),
      'ME',
    );
    let n = 0;
    return {
      adapted,
      plan: buildImportPlan(
        adapted.file,
        mapping,
        {
          aircraft: new Map(aircraft.map((a) => [a.registration, a])),
          fallbackClass: 'ME',
          makeId: () => `airside-${n++}`,
        },
        [],
        aircraft,
      ),
    };
  }

  it('imports every row that has a route, and rejects the one that has none', () => {
    const { plan: result } = plan();
    expect(result.counts.rowsRead).toBe(15);
    expect(result.counts.ready).toBe(14);
    expect(result.rejected.map((row) => row.line)).toEqual([14]);
  });

  it('stores block times that agree exactly with the totals', () => {
    // The on-block is built from the total, so the duration sanity check — the
    // guard against reading minutes as hours — must land on exactly 1.
    const { plan: result } = plan();
    expect(result.durationCheck.ratio).toBe(1);
    expect(result.durationCheck.suggestion).toBeNull();
  });

  it('logs airline sectors as co-pilot and multi-pilot time', () => {
    const { plan: result } = plan();
    expect(result.counts.inferredCoPilot).toBeGreaterThan(0);
    const sector = result.rows.find((row) => row.line === 2);
    expect(sector?.record.coPilotMinutes).toBe(55);
    expect(sector?.record.multiPilotMinutes).toBe(55);
    expect(sector?.record.picName).toBe('');
  });

  it('keeps the flight number and the assumed zone on the record', () => {
    const { plan: result } = plan();
    const sector = result.rows.find((row) => row.line === 2);
    expect(sector?.record.extra['Flight Number']).toBe('XY1001');
    expect(sector?.record.extra['Zone Assumed']).toBeUndefined();

    const assumed = result.rows.find((row) => row.line === 8);
    expect(assumed?.record.extra['Zone Assumed']).toBe('UTC+01:00');
  });

  it('finds the overlap the fixture contains, through the shared rule', () => {
    // Lines 2 and 16 both depart Oslo that morning and cannot both be true.
    // `findConflicts` is the one definition of that, shared with the entry
    // form; this only checks it is reached from here.
    const { plan: result } = plan();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].lines).toEqual([2, 16]);
  });

  it('never turns an Airside row into a simulator session', () => {
    const { plan: result } = plan();
    expect(result.counts.simulatorSessions).toBe(0);
    expect(result.rows.every((row) => row.record.entryType === 'flight')).toBe(true);
  });
});
