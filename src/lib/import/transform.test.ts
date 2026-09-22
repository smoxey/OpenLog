/**
 * Row -> record.
 *
 * THE RULE these tests exist to defend, above every other: **a simulator row
 * never contributes flight time.** RB populates `Total Block` on `Duty Type = 1`
 * rows; in a real export that added up to well over a hundred hours that were never flown, and it
 * would look entirely plausible in a totals column. The test that matters most
 * in this file is the one asserting flight time is unchanged by importing the
 * simulator rows.
 *
 * Everything is driven from the permanent synthetic fixture, which reproduces
 * all eight documented RB quirks plus the three the real file turned out to
 * have. The fixture must never be edited to make a test pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, type ParsedCsv } from './csv';
import { buildMapping, durationSamples, type ImportMapping } from './mapping';
import { detectPreset, RB_PRESET } from './presets';
import { collectAircraftNeeds, transformRow, type RowResult, type TransformContext } from './transform';
import { sniffDurationFormat, type DurationFormat } from './units';
import { normalizeRegistration, type Aircraft } from '../domain/aircraft';
import { CURRENT_SCHEMA_VERSION, SIMULATOR_AERODROME, type Flight } from '../domain/flight';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const RB = readFileSync(path.join(FIXTURE_DIR, 'rb-logbook.csv'), 'utf8');
const V1_CSV = readFileSync(path.join(FIXTURE_DIR, 'v1-export.csv'), 'utf8');

const MINUTES: DurationFormat = { unit: 'minutes', decimal: '.' };

function parse(text: string): ParsedCsv {
  const result = parseCsv(text);
  if (!result.ok) throw new Error(result.rejection.message);
  return result.file;
}

/** Deterministic ids, so a failure names a row rather than a uuid. */
function makeContext(overrides: Partial<TransformContext> = {}): TransformContext {
  let n = 0;
  return {
    aircraft: new Map(),
    fallbackClass: 'ME',
    makeId: () => `id-${++n}`,
    ...overrides,
  };
}

function aircraftMap(...entries: Aircraft[]): Map<string, Aircraft> {
  return new Map(entries.map((a) => [normalizeRegistration(a.registration), a]));
}

/** The whole fixture, transformed. */
function runFixture(context = makeContext()): {
  file: ParsedCsv;
  mapping: ImportMapping;
  results: RowResult[];
} {
  const file = parse(RB);
  const mapping = buildMapping(file.headers, detectPreset(file.headers), MINUTES);
  const results = file.rows.map((row) => transformRow(row, file.headers, mapping, context));
  return { file, mapping, results };
}

const ok = (results: RowResult[]): Flight[] =>
  results.filter((r): r is Extract<RowResult, { ok: true }> => r.ok).map((r) => r.record);

const failed = (results: RowResult[]) =>
  results.filter((r): r is Extract<RowResult, { ok: false }> => !r.ok);

/** Rows keyed by their line in the fixture, for naming a specific quirk. */
function byLine(results: RowResult[], line: number): RowResult {
  const found = results.find((r) => r.line === line);
  if (!found) throw new Error(`no result for line ${line}`);
  return found;
}

function record(results: RowResult[], line: number): Flight {
  const result = byLine(results, line);
  if (!result.ok) throw new Error(`line ${line} failed: ${result.issues[0]?.message}`);
  return result.record;
}

describe('THE GOVERNING RULE — simulator time is never flight time', () => {
  const { results } = runFixture();

  it('imports Duty Type 1 rows as FSTD entries, never as flights', () => {
    const sims = ok(results).filter((r) => r.entryType === 'fstd');
    expect(sims).toHaveLength(2);
  });

  it('adds ZERO flight time from the simulator rows', () => {
    // The single most important assertion in this prompt. The fixture's two
    // simulator rows carry Total Block 240 and 120; if either reached
    // totalMinutes, this number would be 360 higher.
    const sims = ok(results).filter((r) => r.entryType === 'fstd');
    const flightTimeFromSims = sims.reduce((sum, r) => sum + r.totalMinutes, 0);
    expect(flightTimeFromSims).toBe(0);
  });

  it('takes session time from the Simulator column, not from Total Block', () => {
    // The two disagree in the fixture exactly as they do in the real file, and
    // Simulator is the one that means what it says.
    const sims = ok(results).filter((r) => r.entryType === 'fstd');
    expect(sims.map((r) => r.simulatorMinutes).sort((a, b) => a - b)).toEqual([105, 210]);
  });

  it('preserves the discarded Total Block in extra rather than deleting it', () => {
    // Never counted, never summed — `extra` feeds no total — but not destroyed
    // either. The pilot's file said 240, and the record still says so.
    const sim = record(results, 3);
    expect(sim.entryType).toBe('fstd');
    expect(sim.totalMinutes).toBe(0);
    expect(sim.extra['Total Block']).toBe('240');
  });

  it('flags the parking so the preview can state it', () => {
    const result = byLine(results, 3);
    expect(result.ok && result.flags).toContain('sim-block-parked');
  });

  it('files the device id in simulatorRegistration, never in registration', () => {
    // This is what stops the aircraft store filling with simulators that are
    // not aircraft.
    const sim = record(results, 3);
    expect(sim.simulatorRegistration).toBe('EU-XX123');
    expect(sim.registration).toBe('');
  });

  it('gives a simulator row the SIM aerodromes and no block times', () => {
    const sim = record(results, 3);
    expect(sim.depAerodrome).toBe(SIMULATOR_AERODROME);
    expect(sim.arrAerodrome).toBe(SIMULATOR_AERODROME);
    expect(sim.offBlock).toBe('');
    expect(sim.onBlock).toBe('');
  });

  it('never lets a simulator row carry landings into a total', () => {
    const sim = record(results, 3);
    expect(sim.landingsDay).toBe(0);
    expect(sim.landingsNight).toBe(0);
  });
});

describe('the eight documented quirks', () => {
  it('1. a normal airline sector maps every documented column', () => {
    const { results } = runFixture();
    const flight = record(results, 2);
    expect(flight).toMatchObject({
      entryType: 'flight',
      date: '2024-03-11',
      depAerodrome: 'EKCH',
      arrAerodrome: 'EGLL',
      registration: 'OY-XXA',
      aircraftType: 'A320',
      offBlock: '07:05',
      onBlock: '09:23',
      totalMinutes: 138,
      nightMinutes: 28,
      ifrMinutes: 138,
      landingsDay: 1,
      landingsNight: 0,
    });
  });

  it('2. a simulator row — covered above', () => {
    expect(true).toBe(true);
  });

  it('3. a blank Aircraft Type is held for an answer, not blanked and not dropped', () => {
    // With nothing known about the aircraft, the row is held back under its own
    // issue code — "waiting for a type", not "this row is broken". That
    // distinction is what lets the preview say "23 rows need a type" instead of
    // sending the pilot hunting for a fault in their file.
    const { results } = runFixture();
    const result = byLine(results, 4);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].code).toBe('missing-aircraft');
      expect(result.issues[0].message).toContain('LN-XXZ');
      expect(result.flags).toContain('aircraft-unknown');
    }
  });

  it('3b. and once the aircraft step answers, the same row imports', () => {
    // THIS is the format document's "give the user a chance to fill it in":
    // one answer per registration, applied to every row that needs it.
    const answered = makeContext({
      aircraft: aircraftMap({ registration: 'LN-XXZ', type: 'PA28', class: 'SE', multiPilot: false }),
    });
    const { results } = runFixture(answered);
    const flight = record(results, 4);
    expect(flight.registration).toBe('LN-XXZ');
    expect(flight.aircraftType).toBe('PA28');
    expect(flight.singlePilotSeMinutes).toBe(60);
  });

  it('4. a row with no times at all is REPORTED, not silently skipped', () => {
    const { results } = runFixture();
    const result = byLine(results, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'invalid')).toBe(true);
      // Named well enough for the pilot to find it in their own file.
      expect(result.label).toContain('2024-06-01');
    }
  });

  it('5. and 6. overlapping flights both import — overlap is Phase D’s job', () => {
    // The transform's business is one row at a time. Conflicts are a property
    // of a SET of rows, so they belong to the plan, not here.
    const { results } = runFixture();
    expect(byLine(results, 6).ok).toBe(true);
    expect(byLine(results, 7).ok).toBe(true);
  });

  it('7. a flight crossing midnight keeps its logged total', () => {
    const { results } = runFixture();
    const flight = record(results, 11);
    expect(flight.offBlock).toBe('22:30');
    expect(flight.onBlock).toBe('01:15');
    expect(flight.totalMinutes).toBe(165);
  });

  it('8. a timezone-crossing sector keeps Total Block, not the interval', () => {
    // 14:00 -> 16:00 is 120 minutes of clock, but the logged total is 180 and
    // the logged total is what the pilot's logbook says. The block times are
    // not dependably UTC; we report, we never silently correct.
    const { results } = runFixture();
    const flight = record(results, 12);
    expect(flight.offBlock).toBe('14:00');
    expect(flight.onBlock).toBe('16:00');
    expect(flight.totalMinutes).toBe(180);
  });

  it('9. a GA training flight maps Dual Received to dual time', () => {
    const { results } = runFixture();
    const flight = record(results, 13);
    expect(flight.aircraftType).toBe('C172');
    expect(flight.dualMinutes).toBe(90);
    // The literal 0 sitting in Dual Given must not become instructor time.
    expect(flight.instructorMinutes).toBe(0);
  });
});

describe('the Dual Given / Instructor merge rule', () => {
  const headers = ['Date', 'Duty Type', 'Departure', 'Arrival', 'Aircraft ID', 'Aircraft Type', 'Out', 'In', 'Total Block', 'Dual Given', 'Instructor'];

  function runRow(dualGiven: string, instructor: string): RowResult {
    const csv = [
      headers.join(','),
      ['2024-01-01', '0', 'ENGM', 'ENBR', 'LN-AAA', 'C172', '10:00', '11:00', '60', dualGiven, instructor].join(','),
    ].join('\r\n');
    const file = parse(csv);
    const mapping = buildMapping(file.headers, RB_PRESET, MINUTES);
    return transformRow(file.rows[0], file.headers, mapping, makeContext());
  }

  it('takes whichever column is non-zero', () => {
    const a = runRow('45', '0');
    expect(a.ok && a.record.instructorMinutes).toBe(45);
    const b = runRow('0', '45');
    expect(b.ok && b.record.instructorMinutes).toBe(45);
  });

  it('treats two equal values as redundant, not contradictory', () => {
    const result = runRow('45', '45');
    expect(result.ok && result.record.instructorMinutes).toBe(45);
  });

  it('REPORTS a genuine disagreement rather than summing it', () => {
    // Summing would claim 105 minutes of instruction from a row describing at
    // most 60. There is no safe automatic answer, so a human is asked.
    const result = runRow('45', '60');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.code === 'source-conflict');
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/double-count/);
      expect(issue?.message).toContain('45');
      expect(issue?.message).toContain('60');
    }
  });

  it('leaves instructor time at zero when both columns are zero', () => {
    const result = runRow('0', '0');
    expect(result.ok && result.record.instructorMinutes).toBe(0);
  });
});

describe('the co-pilot inference', () => {
  const multiPilot: Aircraft = { registration: 'OY-XXA', type: 'A320', class: 'ME', multiPilot: true };
  const singlePilot: Aircraft = { registration: 'LN-XXD', type: 'C172', class: 'SE', multiPilot: false };

  it('logs a multi-pilot sector with no function time as co-pilot AND multi-pilot time', () => {
    // The RB document's inference, expressed as a rule about the aircraft. An
    // A320 sector of 138 minutes imports as multiPilot 138, coPilot 138, and
    // no single-pilot time at all.
    const { results } = runFixture(makeContext({ aircraft: aircraftMap(multiPilot) }));
    const flight = record(results, 2);
    expect(flight.multiPilotMinutes).toBe(138);
    expect(flight.coPilotMinutes).toBe(138);
    expect(flight.singlePilotSeMinutes).toBe(0);
    expect(flight.singlePilotMeMinutes).toBe(0);
  });

  it('flags the inference, so the preview can state it as a claim', () => {
    const { results } = runFixture(makeContext({ aircraft: aircraftMap(multiPilot) }));
    const result = byLine(results, 2);
    expect(result.ok && result.flags).toContain('derived-copilot');
  });

  it('leaves a row that already carries PIC time completely alone', () => {
    // Some rows of the real file do record PIC time. None of them may be
    // overwritten by a guess.
    const gaWithPic: Aircraft = { registration: 'LN-XXZ', type: 'PA28', class: 'SE', multiPilot: true };
    const { results } = runFixture(makeContext({ aircraft: aircraftMap(gaWithPic) }));
    const flight = record(results, 4);
    expect(flight.picMinutes).toBe(60);
    expect(flight.coPilotMinutes).toBe(0);
    const result = byLine(results, 4);
    expect(result.ok && result.flags).not.toContain('derived-copilot');
  });

  it('never infers co-pilot time on a single-pilot aircraft', () => {
    const { results } = runFixture(makeContext({ aircraft: aircraftMap(singlePilot) }));
    const flight = record(results, 13);
    expect(flight.coPilotMinutes).toBe(0);
    expect(flight.singlePilotSeMinutes).toBe(90);
  });

  it('never infers co-pilot time on a row carrying dual received', () => {
    const dualAircraft: Aircraft = { registration: 'LN-XXD', type: 'C172', class: 'SE', multiPilot: true };
    const { results } = runFixture(makeContext({ aircraft: aircraftMap(dualAircraft) }));
    const flight = record(results, 13);
    expect(flight.dualMinutes).toBe(90);
    expect(flight.coPilotMinutes).toBe(0);
  });

  it('mentions no aircraft TYPE anywhere — the rule is about multiPilot', () => {
    // If this module ever grows an "A320" string, the inference has stopped
    // being about the aircraft the pilot confirmed and become a hardcoded list.
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'transform.ts'), 'utf8');
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/A32\d|A31\d|B73\d/);
  });
});

describe('unknown columns', () => {
  it('preserves them in extra under their own heading', () => {
    const { results } = runFixture();
    const flight = record(results, 2);
    expect(flight.extra['Pilot Flying']).toBe('true');
    expect(flight.extra['Night Takeoff']).toBe('1');
  });

  it('does NOT write the empty ones', () => {
    // RB has 105 columns, most empty on most rows. Writing them all would put
    // 80 empty keys on every record and 80 empty columns in every CSV export.
    const { results } = runFixture();
    const flight = record(results, 2);
    expect(flight.extra).not.toHaveProperty('Crew PIC');
    expect(flight.extra).not.toHaveProperty('Approach1');
    expect(Object.keys(flight.extra).length).toBeLessThan(10);
  });

  it('keeps the value as the string the file actually held', () => {
    // Lossless and free of special cases. Coercing "0180" to a number, or
    // "true" to a boolean, would be us deciding what the file meant.
    const { results } = runFixture();
    const flight = record(results, 12);
    expect(flight.extra['X-Country']).toBe('180');
    expect(typeof flight.extra['X-Country']).toBe('string');
  });

  it('preserves the columns that have no schema home', () => {
    const { results } = runFixture();
    const ga = record(results, 13);
    expect(ga.extra['Actual Instrument']).toBe('12');
  });
});

describe('picName', () => {
  it('is left empty on every imported row', () => {
    // Settled: no "SELF", no placeholder. RB records PIC time, not the PIC's
    // name, and the pilot is not the commander on most of these flights — an
    // invented value would be wrong rather than merely absent.
    const { results } = runFixture();
    for (const flight of ok(results)) expect(flight.picName).toBe('');
  });
});

describe('schema and validation', () => {
  it('stamps every record at the current schema version', () => {
    const { results } = runFixture();
    for (const flight of ok(results)) expect(flight.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('keeps the NORMALIZED record, so an import cannot produce what the form could not', () => {
    // Lowercase ICAO codes in a hand-edited file come back uppercased, exactly
    // as `readBackup` does it and for the same reason.
    const csv = [
      'Date,Duty Type,Departure,Arrival,Aircraft ID,Aircraft Type,Out,In,Total Block',
      '2024-01-01,0,engm,enbr,ln-aaa,C172,10:00,11:00,60',
    ].join('\r\n');
    const file = parse(csv);
    const mapping = buildMapping(file.headers, RB_PRESET, MINUTES);
    const result = transformRow(file.rows[0], file.headers, mapping, makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.depAerodrome).toBe('ENGM');
      expect(result.record.arrAerodrome).toBe('ENBR');
    }
  });

  it('gives every record a distinct id, so imported rows can conflict with each other', () => {
    const { results } = runFixture();
    const ids = ok(results).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never throws, whatever a row holds', () => {
    const csv = [
      'Date,Duty Type,Departure,Arrival,Aircraft ID,Aircraft Type,Out,In,Total Block',
      'nonsense,,,,,,,,,',
      ',,,,,,,,',
    ].join('\r\n');
    const file = parse(csv);
    const mapping = buildMapping(file.headers, RB_PRESET, MINUTES);
    for (const row of file.rows) {
      expect(() => transformRow(row, file.headers, mapping, makeContext())).not.toThrow();
    }
  });

  it('reports an unparseable duration rather than treating it as zero', () => {
    const csv = [
      'Date,Duty Type,Departure,Arrival,Aircraft ID,Aircraft Type,Out,In,Total Block',
      '2024-01-01,0,ENGM,ENBR,LN-AAA,C172,10:00,11:00,about an hour',
    ].join('\r\n');
    const file = parse(csv);
    const mapping = buildMapping(file.headers, RB_PRESET, MINUTES);
    const result = transformRow(file.rows[0], file.headers, mapping, makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].code).toBe('unparseable');
  });
});

describe('our own CSV, at schema v1', () => {
  // The regression test that makes schemaVersion mean something on the CSV
  // path: a file written before v2 and v3 existed still imports, and its
  // missing columns default correctly rather than failing.
  function runV1() {
    const file = parse(V1_CSV);
    // Build the mapping FIRST, then sniff from the columns it marks as
    // durations. Sampling by header name would pull in `Departure Time` —
    // "08:00" — and judge the whole file to be in hh:mm, after which every
    // real duration parses wrongly.
    const provisional = buildMapping(file.headers, detectPreset(file.headers), MINUTES);
    const guess = sniffDurationFormat(durationSamples(file.rows, provisional));
    const mapping = buildMapping(file.headers, detectPreset(file.headers), guess.format);
    return { file, mapping, results: file.rows.map((r) => transformRow(r, file.headers, mapping, makeContext())) };
  }

  it('imports every row', () => {
    const { results } = runV1();
    expect(failed(results)).toHaveLength(0);
    expect(ok(results)).toHaveLength(3);
  });

  it('reads its decimal hours correctly', () => {
    // 1.2 decimal hours is 72 minutes, not 1 minute and not 72 hours.
    const { results } = runV1();
    expect(ok(results)[0].totalMinutes).toBe(72);
    expect(ok(results)[2].totalMinutes).toBe(138);
  });

  it('fills the v2 and v3 fields its columns never had', () => {
    const { results } = runV1();
    const flight = ok(results)[0];
    expect(flight.entryType).toBe('flight');
    expect(flight.simulatorMinutes).toBe(0);
    expect(flight.simulatorRegistration).toBe('');
    expect(flight.dualMinutes).toBe(0);
    expect(flight.ifrMinutes).toBe(0);
    expect(flight.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('reads a quoted remark containing a comma', () => {
    const { results } = runV1();
    expect(ok(results)[1].remarks).toBe('Night rating, dual');
  });
});

describe('cross-locale round trip', () => {
  it('reads a European-decimal file identically to a standard one', () => {
    const standard = ['Date,Duty Type,Departure,Arrival,Aircraft ID,Aircraft Type,Out,In,Total Block', '2024-01-01,0,ENGM,ENBR,LN-AAA,C172,10:00,11:12,1.2'].join('\r\n');
    const european = ['Date;Duty Type;Departure;Arrival;Aircraft ID;Aircraft Type;Out;In;Total Block', '2024-01-01;0;ENGM;ENBR;LN-AAA;C172;10:00;11:12;1,2'].join('\r\n');

    const run = (text: string) => {
      const file = parse(text);
      const guess = sniffDurationFormat(file.rows.map((r) => r.cells[8]));
      const mapping = buildMapping(file.headers, RB_PRESET, guess.format);
      const result = transformRow(file.rows[0], file.headers, mapping, makeContext());
      if (!result.ok) throw new Error(result.issues[0].message);
      return result.record;
    };

    const a = run(standard);
    const b = run(european);
    expect(a.totalMinutes).toBe(72);
    expect(b.totalMinutes).toBe(72);
    expect({ ...a, id: '' }).toEqual({ ...b, id: '' });
  });
});

describe('block times', () => {
  const HEADERS = 'Date,Duty Type,Departure,Arrival,Aircraft ID,Aircraft Type,Out,In,Total Block';

  /** One row, with whatever `Out` and `In` the case is about. */
  function runRow(
    out: string,
    inn: string,
    options: { date?: string; offsetMinutes?: number } = {},
  ): RowResult {
    const csv = [
      HEADERS,
      `${options.date ?? '2024-01-01'},0,ENGM,ENBR,LN-AAA,C172,${out},${inn},72`,
    ].join('\r\n');
    const file = parse(csv);
    const mapping: ImportMapping = {
      ...buildMapping(file.headers, RB_PRESET, MINUTES),
      timeZoneOffsetMinutes: options.offsetMinutes ?? 0,
    };
    return transformRow(file.rows[0], file.headers, mapping, makeContext());
  }

  it('normalises every shape a foreign export writes a time in', () => {
    // All four mean 08:05, and the logbook must hold one spelling of it —
    // three of these four fail `validateFlight` if copied through verbatim.
    for (const written of ['08:05', '8:05', '0805', '08:05:00']) {
      const result = runRow(written, '09:30');
      expect(result.ok && result.record.offBlock).toBe('08:05');
    }
  });

  it('reads a file written on a 12-hour clock', () => {
    const result = runRow('8:05 AM', '11:36 PM');
    expect(result.ok && result.record.offBlock).toBe('08:05');
    expect(result.ok && result.record.onBlock).toBe('23:36');
  });

  it('reports a time it cannot read rather than storing the raw cell', () => {
    const result = runRow('half past eight', '09:30');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].code).toBe('unparseable');
    expect(result.issues[0].column).toBe('Out');
  });

  it('treats an empty time as absent, not as unreadable', () => {
    // The distinction matters for the message the pilot gets. A blank cell is a
    // missing required field, which is a gap in the file; "could not be read as
    // a time of day" would send them looking for a typo that is not there.
    const result = runRow('', '');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).not.toContain('unparseable');
    expect(result.issues[0].code).toBe('invalid');
  });

  it('is untouched by the zone when the file is in UTC', () => {
    const utc = runRow('10:00', '11:12');
    expect(utc.ok && utc.record.offBlock).toBe('10:00');
    expect(utc.ok && utc.record.date).toBe('2024-01-01');
  });

  it('converts a local-time file to the UTC the logbook stores', () => {
    const result = runRow('10:00', '11:12', { offsetMinutes: 120 });
    expect(result.ok && result.record.offBlock).toBe('08:00');
    expect(result.ok && result.record.onBlock).toBe('09:12');
    expect(result.ok && result.record.date).toBe('2024-01-01');
  });

  it('moves the DATE when the off-block crosses midnight into UTC', () => {
    // The error this whole option can introduce, and the one it must get right:
    // 01:30 local at UTC+02:00 departed on the last day of February in UTC.
    const result = runRow('01:30', '03:00', { date: '2024-03-01', offsetMinutes: 120 });
    expect(result.ok && result.record.offBlock).toBe('23:30');
    expect(result.ok && result.record.date).toBe('2024-02-29');
  });

  it('leaves the date alone when only the ON-block crosses', () => {
    // One record, one date, and it is the departure's. A landing after midnight
    // is already expressed by an on-block earlier than the off-block.
    const result = runRow('20:00', '23:00', { date: '2024-01-01', offsetMinutes: -120 });
    expect(result.ok && result.record.offBlock).toBe('22:00');
    expect(result.ok && result.record.onBlock).toBe('01:00');
    expect(result.ok && result.record.date).toBe('2024-01-01');
  });

  it('never moves a simulator session, which has no block times to convert', () => {
    const csv = [
      HEADERS,
      '2024-01-01,1,,,EU-XX123,A320-SIM,,,240',
    ].join('\r\n');
    const file = parse(csv);
    const mapping: ImportMapping = {
      ...buildMapping(file.headers, RB_PRESET, MINUTES),
      timeZoneOffsetMinutes: 720,
    };
    const result = transformRow(file.rows[0], file.headers, mapping, makeContext());
    expect(result.ok && result.record.entryType).toBe('fstd');
    expect(result.ok && result.record.date).toBe('2024-01-01');
  });
});

describe('collectAircraftNeeds', () => {
  const { file, mapping } = runFixture();
  const needs = collectAircraftNeeds(file.rows, mapping);

  it('lists every registration the flight rows mention', () => {
    expect(needs.map((n) => n.registration)).toEqual([
      'LN-XXB',
      'LN-XXD',
      'LN-XXZ',
      'OY-XXA',
      'OY-XXC',
      'OY-XXE',
    ]);
  });

  it('EXCLUDES simulator devices, which are not aircraft', () => {
    // Their identifier is a device id. Letting it into the aircraft store is
    // exactly what simulatorRegistration exists to prevent.
    expect(needs.map((n) => n.registration)).not.toContain('EU-XX123');
    expect(needs.map((n) => n.registration)).not.toContain('EU-XX456');
  });

  it('reports the types seen against each registration', () => {
    // LN-XXZ appears once, with no type anywhere — the gap the aircraft step
    // fills, and the shape the real file has.
    const untyped = needs.find((n) => n.registration === 'LN-XXZ');
    expect(untyped?.typesSeen).toEqual([]);
    expect(untyped?.rowCount).toBe(1);

    const ln = needs.find((n) => n.registration === 'LN-XXB');
    expect(ln?.typesSeen).toEqual(['PA28']);
    expect(ln?.rowCount).toBe(1);
  });

  it('counts the rows referencing each aircraft', () => {
    const oy = needs.find((n) => n.registration === 'OY-XXA');
    // Lines 2, 5, 6, 8 and 11 of the fixture.
    expect(oy?.rowCount).toBe(5);
  });

  it('normalizes the registration into the aircraft store key', () => {
    const csv = ['Date,Duty Type,Aircraft ID,Aircraft Type', '2024-01-01,0, ln-aaa ,C172'].join('\r\n');
    const parsedFile = parse(csv);
    const map = buildMapping(parsedFile.headers, RB_PRESET, MINUTES);
    const result = collectAircraftNeeds(parsedFile.rows, map);
    expect(result[0].registration).toBe('LN-AAA');
  });
});
