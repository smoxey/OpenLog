/**
 * The dry run.
 *
 * The import promises that nothing reaches the logbook until the pilot has seen
 * what it will do. These tests defend that promise: if a count here is wrong,
 * the confirmation the pilot gave was for a different import than the one that
 * runs.
 *
 * Two things get the most attention. **Conflicts are grouped into situations,
 * not listed as pairs** — three rows of the real file mutually overlap, so
 * pairing shows the same three rows three times and asks for the same decision
 * three times. And **simulator block time is reported as a separate number**,
 * because the whole point of avoiding the simulator block-time trap is lost if the pilot
 * cannot see that it was avoided.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, type ParsedCsv } from './csv';
import { buildMapping, type ImportMapping } from './mapping';
import { detectPreset } from './presets';
import { buildImportPlan, type ImportPlan } from './plan';
import type { RowEdit, TransformContext } from './transform';
import type { DurationFormat } from './units';
import { normalizeRegistration, type Aircraft } from '../domain/aircraft';
import type { Flight } from '../domain/flight';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const RB = readFileSync(path.join(FIXTURE_DIR, 'rb-logbook.csv'), 'utf8');

const MINUTES: DurationFormat = { unit: 'minutes', decimal: '.' };

const A320: Aircraft = { registration: 'OY-XXA', type: 'A320', class: 'ME', multiPilot: true };
const A319: Aircraft = { registration: 'OY-XXC', type: 'A319', class: 'ME', multiPilot: true };
const A320E: Aircraft = { registration: 'OY-XXE', type: 'A320', class: 'ME', multiPilot: true };
const PA28: Aircraft = { registration: 'LN-XXB', type: 'PA28', class: 'SE', multiPilot: false };
const UNTYPED: Aircraft = { registration: 'LN-XXZ', type: 'PA28', class: 'SE', multiPilot: false };
const C172: Aircraft = { registration: 'LN-XXD', type: 'C172', class: 'SE', multiPilot: false };

const ALL_AIRCRAFT = [A320, A319, A320E, PA28, C172, UNTYPED];

function parse(text: string): ParsedCsv {
  const result = parseCsv(text);
  if (!result.ok) throw new Error(result.rejection.message);
  return result.file;
}

function makeContext(aircraft: Aircraft[] = [], idPrefix = 'id'): TransformContext {
  let n = 0;
  return {
    aircraft: new Map(aircraft.map((a) => [normalizeRegistration(a.registration), a])),
    fallbackClass: 'ME',
    // Deterministic, but the prefix matters: a second import of the same file
    // produces DIFFERENT ids in reality (crypto.randomUUID), and reusing them
    // here would let `findConflicts` treat each new record as its own stored
    // copy and skip it — hiding exactly the collision the test is checking for.
    makeId: () => `${idPrefix}-${++n}`,
  };
}

function planFixture(
  options: {
    aircraft?: Aircraft[];
    existing?: Flight[];
    skipLines?: number[];
    text?: string;
    idPrefix?: string;
    edits?: Map<number, RowEdit>;
  } = {},
): { plan: ImportPlan; file: ParsedCsv; mapping: ImportMapping } {
  const file = parse(options.text ?? RB);
  const mapping = buildMapping(file.headers, detectPreset(file.headers), MINUTES);
  const plan = buildImportPlan(
    file,
    mapping,
    makeContext(options.aircraft ?? ALL_AIRCRAFT, options.idPrefix),
    options.existing ?? [],
    options.aircraft ?? [],
    { skipLines: options.skipLines, edits: options.edits },
  );
  return { plan, file, mapping };
}

describe('counts', () => {
  const { plan } = planFixture();

  it('reads every row of the file', () => {
    expect(plan.counts.rowsRead).toBe(14);
  });

  it('separates flights from simulator sessions', () => {
    expect(plan.counts.flights).toBe(11);
    expect(plan.counts.simulatorSessions).toBe(2);
  });

  it('reports flight time and simulator time as SEPARATE numbers', () => {
    // If these were ever added together the whole entry-type design would be
    // pointless. The no-times row contributes nothing because it has no Total
    // Block to contribute — it is held back entirely.
    expect(plan.counts.flightMinutes).toBe(1468);
    expect(plan.counts.simulatorMinutes).toBe(315);
  });

  it('states how much block time was found on simulator rows and NOT counted', () => {
    // 240 + 120. The simulator block-time trap in miniature: avoided, and visibly so.
    expect(plan.counts.parkedSimulatorBlockMinutes).toBe(360);
    expect(plan.counts.flightMinutes).not.toContain(360);
  });

  it('adds up: ready + held back = rows read', () => {
    const { ready, needingAircraft, errors, rowsRead } = plan.counts;
    expect(ready + needingAircraft + errors).toBe(rowsRead);
  });

  it('counts the row with no times as an error, not as a missing aircraft', () => {
    expect(plan.counts.errors).toBe(1);
    expect(plan.counts.needingAircraft).toBe(0);
  });
});

describe('rows held back', () => {
  it('separates "needs an aircraft type" from "is broken"', () => {
    // With no aircraft confirmed, the blank-type row is a QUESTION. Calling it
    // invalid would send the pilot hunting for damage that is not there.
    const { plan } = planFixture({ aircraft: [] });
    expect(plan.counts.needingAircraft).toBe(1);
    const held = plan.rejected.find((r) => r.needsAircraft);
    expect(held?.line).toBe(4);
    expect(held?.issues[0].code).toBe('missing-aircraft');
  });

  it('lets the aircraft answers unblock those rows', () => {
    const withAnswers = planFixture({ aircraft: ALL_AIRCRAFT });
    expect(withAnswers.plan.counts.needingAircraft).toBe(0);
    expect(withAnswers.plan.counts.ready).toBe(13);
  });

  it('reports the no-times row with a label the pilot can find in their file', () => {
    const { plan } = planFixture();
    const broken = plan.rejected.find((r) => !r.needsAircraft);
    expect(broken?.line).toBe(5);
    expect(broken?.label).toContain('2024-06-01');
  });

  it('never silently drops a row — every one is either planned or rejected', () => {
    const { plan } = planFixture();
    const accounted = plan.rows.length + plan.rejected.length;
    expect(accounted).toBe(plan.counts.rowsRead);
  });
});

describe('conflicts — grouped into situations, not listed as pairs', () => {
  const { plan } = planFixture();

  it('finds exactly two situations in the fixture, not four pairs', () => {
    // The fixture mirrors the real file: one overlapping PAIR (lines 6, 7) and
    // one mutually-overlapping TRIPLE (lines 8, 9, 10). That is four
    // overlapping pairs but only two things for a pilot to look at.
    expect(plan.conflicts).toHaveLength(2);
  });

  it('puts the three mutually-overlapping rows in ONE group', () => {
    const triple = plan.conflicts.find((g) => g.lines.length === 3);
    expect(triple?.lines).toEqual([8, 9, 10]);
  });

  it('keeps the ordinary pair as its own group', () => {
    const pair = plan.conflicts.find((g) => g.lines.length === 2);
    expect(pair?.lines).toEqual([6, 7]);
  });

  it('counts five conflicting rows across those two groups', () => {
    expect(plan.counts.conflicting).toBe(5);
  });

  it('describes each group in one line of plain words', () => {
    for (const group of plan.conflicts) {
      expect(group.summary).toMatch(/overlap/i);
      expect(group.summary.length).toBeGreaterThan(10);
    }
  });

  it('orders groups by where they appear in the file', () => {
    expect(plan.conflicts[0].lines[0]).toBeLessThan(plan.conflicts[1].lines[0]);
  });

  it('never repeats the line numbers the caller already prints', () => {
    // Found in a real browser: the summary said "row 2" and the UI printed
    // "Line 2" beside it, giving "Line 2 — row 2 overlaps…".
    for (const group of plan.conflicts) {
      expect(group.summary).not.toMatch(/\brows? \d/i);
    }
  });
});

describe('conflicts against the logbook that is already there', () => {
  it('catches importing the same file twice', () => {
    // The first import's records become `existing` for the second. Every timed
    // row then collides with its own stored copy.
    const first = planFixture();
    const stored = first.plan.rows.map((row) => row.record);

    const second = planFixture({ existing: stored, idPrefix: 'second' });
    expect(second.plan.conflicts.length).toBeGreaterThan(0);
    // Every flight row with block times conflicts with the stored copy.
    expect(second.plan.counts.conflicting).toBe(11);
  });

  it('reads correctly for a single row colliding only with stored data', () => {
    // The commonest shape when a file is re-imported: one line, one collision,
    // and no within-file overlap at all. In a real export this happens on
    // every row.
    const first = planFixture();
    const stored = first.plan.rows.map((row) => row.record);
    const second = planFixture({ existing: stored, idPrefix: 'second' });

    const single = second.plan.conflicts.find((g) => g.lines.length === 1);
    expect(single?.summary).toMatch(/^overlaps 1 flight already in your logbook$/);
  });

  it('names the stored flights a group collides with', () => {
    const first = planFixture();
    const stored = first.plan.rows.map((row) => row.record);
    const second = planFixture({ existing: stored, idPrefix: 'second' });
    const withExisting = second.plan.conflicts.filter((g) => g.existingIds.length > 0);
    expect(withExisting.length).toBeGreaterThan(0);
    expect(withExisting[0].summary).toMatch(/already in your logbook/i);
  });

  it('finds nothing when the stored logbook is somewhere else entirely', () => {
    const elsewhere: Flight[] = [];
    const { plan } = planFixture({ existing: elsewhere });
    // Only the file's own internal overlaps remain.
    expect(plan.conflicts).toHaveLength(2);
  });

  it('never lets a simulator session take part in a conflict', () => {
    // Schema v3 forces their block times empty, so there is nothing to
    // intersect. If FSTD entries ever gain real times, revisit this.
    const { plan } = planFixture();
    const simLines = plan.rows.filter((r) => r.record.entryType === 'fstd').map((r) => r.line);
    const conflictLines = plan.conflicts.flatMap((g) => g.lines);
    for (const line of simLines) expect(conflictLines).not.toContain(line);
  });
});

describe('skipping the conflicting rows', () => {
  it('leaves them out and clears the pause', () => {
    const { plan } = planFixture();
    const conflicting = plan.conflicts.flatMap((g) => g.lines);
    const after = planFixture({ skipLines: conflicting });

    expect(after.plan.conflicts).toHaveLength(0);
    expect(after.plan.counts.ready).toBe(plan.counts.ready - conflicting.length);
    for (const line of conflicting) {
      expect(after.plan.rows.map((r) => r.line)).not.toContain(line);
    }
  });

  it('recalculates the flight time so the preview matches what will be written', () => {
    // The number the pilot confirms must be the number that lands. Skipping
    // rows without re-totalling would break exactly that.
    const { plan } = planFixture();
    const conflicting = plan.conflicts.flatMap((g) => g.lines);
    const skipped = planFixture({ skipLines: conflicting });

    const expected = plan.rows
      .filter((row) => !conflicting.includes(row.line))
      .reduce((sum, row) => sum + row.record.totalMinutes, 0);
    expect(skipped.plan.counts.flightMinutes).toBe(expected);
  });
});

describe('the duration-unit guard', () => {
  /** Plan the fixture forcing a duration unit, as the mapping UI lets you do. */
  function planWithUnit(unit: DurationFormat['unit']) {
    const file = parse(RB);
    const mapping = buildMapping(file.headers, detectPreset(file.headers), {
      unit,
      decimal: '.',
    });
    let n = 0;
    return buildImportPlan(
      file,
      mapping,
      {
        aircraft: new Map(ALL_AIRCRAFT.map((a) => [normalizeRegistration(a.registration), a])),
        fallbackClass: 'ME',
        makeId: () => `id-${++n}`,
      },
      [],
      ALL_AIRCRAFT,
    );
  }

  it('CATCHES whole minutes being read as decimal hours', () => {
    // The real failure: a whole logbook imported as tens of thousands of hours because the
    // unit was set to decimal hours for a file holding whole minutes. The block
    // times in the same rows said so all along.
    const plan = planWithUnit('decimalHours');

    expect(plan.durationCheck.suggestion).toBe('minutes');
    expect(plan.durationCheck.ratio).toBeGreaterThan(50);
    expect(plan.durationCheck.comparable).toBeGreaterThan(5);
  });

  it('says nothing when the unit is right', () => {
    const plan = planWithUnit('minutes');
    expect(plan.durationCheck.suggestion).toBeNull();
    // The fixture's totals agree with their own block times, bar the deliberate
    // timezone row, so the median ratio sits at exactly 1.
    expect(plan.durationCheck.ratio).toBe(1);
  });

  it('catches the mistake in the other direction too', () => {
    // A file of decimal hours read as minutes: 2.3 becomes 2 minutes.
    const csv = [
      'Date,Duty Type,Departure,Arrival,Aircraft ID,Aircraft Type,Out,In,Total Block',
      '2024-01-01,0,ENGM,ENBR,LN-AAA,C172,08:00,10:18,2.3',
      '2024-01-02,0,ENGM,ENBR,LN-AAA,C172,08:00,10:18,2.3',
      '2024-01-03,0,ENGM,ENBR,LN-AAA,C172,08:00,10:18,2.3',
    ].join('\r\n');
    const { plan } = planFixture({ text: csv });
    expect(plan.durationCheck.suggestion).toBe('decimalHours');
  });

  it('is not fooled by a file whose totals legitimately differ a little', () => {
    // The timezone-crossing sector is out by an hour on a two-hour leg — a
    // ratio of 1.5, nowhere near the threshold. Guarding too eagerly would cry
    // wolf on every long-haul logbook.
    const plan = planWithUnit('minutes');
    expect(plan.durationCheck.ratio).toBeLessThan(2);
    expect(plan.durationCheck.suggestion).toBeNull();
  });

  it('stays quiet when the file carries no block times to check against', () => {
    const csv = [
      'Date,Duty Type,Aircraft ID,Aircraft Type,Total Block',
      '2024-01-01,0,LN-AAA,C172,138',
    ].join('\r\n');
    const { plan } = planFixture({ text: csv });
    expect(plan.durationCheck.comparable).toBe(0);
    expect(plan.durationCheck.suggestion).toBeNull();
  });

  it('never suggests the unit already chosen', () => {
    for (const unit of ['minutes', 'decimalHours'] as const) {
      expect(planWithUnit(unit).durationCheck.suggestion).not.toBe(unit);
    }
  });

  it('ignores simulator rows, which have no block times by definition', () => {
    const plan = planWithUnit('minutes');
    // 11 flights are planned; one has no times at all and is rejected, so ten
    // are comparable. The two simulator sessions contribute nothing.
    expect(plan.durationCheck.comparable).toBe(plan.counts.flights);
    expect(plan.counts.simulatorSessions).toBe(2);
  });
});

describe('correcting a row before importing it', () => {
  /** The fixture's overlapping pair: line 6 runs 08:00–10:00, line 7 09:00–11:00. */
  const movePair = (offBlock: string, onBlock: string) =>
    planFixture({ edits: new Map([[7, { offBlock, onBlock }]]) });

  it('RESOLVES the overlap when the corrected times no longer intersect', () => {
    // The whole point of editing in place: fix the times and the conflict goes
    // away, rather than the pilot having to skip a real flight.
    const before = planFixture();
    expect(before.plan.conflicts.some((g) => g.lines.includes(7))).toBe(true);

    const after = movePair('10:00', '12:00');
    expect(after.plan.conflicts.some((g) => g.lines.includes(7))).toBe(false);
    // Touching is not overlapping, so 10:00 against a 10:00 landing is clean.
    expect(after.plan.conflicts).toHaveLength(1);
  });

  it('still imports the row, with the corrected values', () => {
    const after = movePair('10:00', '12:00');
    const row = after.plan.rows.find((r) => r.line === 7);
    expect(row?.record.offBlock).toBe('10:00');
    expect(row?.record.onBlock).toBe('12:00');
    expect(row?.edited).toBe(true);
  });

  it('re-derives the aircraft times when the total is corrected', () => {
    // The ordering trap. Reducing the total without re-deriving would leave
    // multiPilotMinutes holding the old, larger figure — and the row would then
    // fail validation for component times exceeding the total.
    const { plan } = planFixture({ edits: new Map([[2, { totalMinutes: 60 }]]) });
    const row = plan.rows.find((r) => r.line === 2);
    expect(row?.record.totalMinutes).toBe(60);
    expect(row?.record.multiPilotMinutes).toBe(60);
    expect(row?.record.coPilotMinutes).toBe(60);
  });

  it('counts the corrections and says so', () => {
    const { plan } = planFixture({ edits: new Map([[7, { offBlock: '10:00', onBlock: '12:00' }]]) });
    expect(plan.counts.edited).toBe(1);
    expect(plan.statements.some((s) => /corrected here before importing/i.test(s))).toBe(true);
    expect(plan.statements.some((s) => /not what the file says/i.test(s))).toBe(true);
  });

  it('reports a correction that is not valid, rather than swallowing it', () => {
    // A half-typed time must not silently import as something else.
    const { plan } = planFixture({ edits: new Map([[7, { offBlock: '25:99' }]]) });
    expect(plan.rows.some((r) => r.line === 7)).toBe(false);
    const rejected = plan.rejected.find((r) => r.line === 7);
    expect(rejected?.issues[0].code).toBe('invalid');
  });

  it('recalculates the flight total from the corrected values', () => {
    const { plan } = planFixture({ edits: new Map([[2, { totalMinutes: 60 }]]) });
    // 1468 less the original 138, plus the corrected 60.
    expect(plan.counts.flightMinutes).toBe(1468 - 138 + 60);
  });

  it('leaves a simulator row alone, because it has nothing to correct', () => {
    // Its block times are empty by definition and its flight time is zero.
    const { plan } = planFixture({ edits: new Map([[3, { totalMinutes: 999 }]]) });
    const sim = plan.rows.find((r) => r.line === 3);
    expect(sim?.record.totalMinutes).toBe(0);
    expect(sim?.edited).toBe(false);
    expect(plan.counts.edited).toBe(0);
  });

  it('is unaffected by an edit for a line that does not exist', () => {
    const { plan } = planFixture({ edits: new Map([[9999, { offBlock: '01:00' }]]) });
    expect(plan.counts.edited).toBe(0);
    expect(plan.counts.ready).toBe(13);
  });

  it('lets dropping and editing be used together', () => {
    const { plan } = planFixture({
      skipLines: [6],
      edits: new Map([[7, { offBlock: '10:00', onBlock: '12:00' }]]),
    });
    expect(plan.rows.some((r) => r.line === 6)).toBe(false);
    expect(plan.rows.find((r) => r.line === 7)?.record.offBlock).toBe('10:00');
  });
});

describe('statements — what the import decided rather than read', () => {
  it('states the flight total in hours', () => {
    const { plan } = planFixture();
    // 1468 minutes -> 24.5 hours, in the same one-decimal form the app uses
    // everywhere else. Export and display formats never diverge.
    expect(plan.statements.some((s) => /24\.5 hours of flight time/.test(s))).toBe(true);
  });

  it('states simulator time separately, and says it is never flight time', () => {
    const { plan } = planFixture();
    const line = plan.statements.find((s) => /simulator session/i.test(s));
    expect(line).toMatch(/never counted as flight time/i);
  });

  it('names the parked block time out loud', () => {
    // The trap, stated. A pilot bitten by another importer will want to see
    // this number named and excluded rather than merely absent.
    const { plan } = planFixture();
    const line = plan.statements.find((s) => /block time recorded against/i.test(s));
    expect(line).toMatch(/6\.0 hours/);
    expect(line).toMatch(/NOT added to your flight time/);
  });

  it('states the co-pilot inference as a claim, not a fact', () => {
    const { plan } = planFixture();
    const line = plan.statements.find((s) => /co-pilot time/i.test(s));
    expect(line).toMatch(/worked out from the aircraft, not read/i);
  });

  it('says nothing about co-pilot time when nothing was inferred', () => {
    const { plan } = planFixture({ aircraft: [PA28, C172, UNTYPED] });
    expect(plan.statements.some((s) => /co-pilot/i.test(s))).toBe(false);
  });

  it('counts rows waiting for an aircraft type', () => {
    const { plan } = planFixture({ aircraft: [] });
    expect(plan.statements.some((s) => /cannot be imported until the aircraft/i.test(s))).toBe(true);
  });
});

describe('the aircraft step', () => {
  it('lists every aircraft the flight rows mention', () => {
    const { plan } = planFixture();
    expect(plan.aircraft.map((a) => a.registration)).toEqual([
      'LN-XXB',
      'LN-XXD',
      'LN-XXZ',
      'OY-XXA',
      'OY-XXC',
      'OY-XXE',
    ]);
  });

  it('excludes simulator devices', () => {
    const { plan } = planFixture();
    const regs = plan.aircraft.map((a) => a.registration);
    expect(regs).not.toContain('EU-XX123');
    expect(regs).not.toContain('EU-XX456');
  });
});

describe('edge cases', () => {
  it('plans an empty file as nothing to do, rather than failing', () => {
    const header = RB.split('\r\n')[0];
    const { plan } = planFixture({ text: header });
    expect(plan.counts.rowsRead).toBe(0);
    expect(plan.rows).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.counts.flightMinutes).toBe(0);
  });

  it('is unbothered by an empty logbook', () => {
    const { plan } = planFixture({ existing: [] });
    expect(plan.counts.ready).toBeGreaterThan(0);
  });

  it('produces the same plan twice for the same input', () => {
    // The preview must not be a moving target between the screen the pilot
    // reads and the write that follows.
    const a = planFixture().plan;
    const b = planFixture().plan;
    expect(a.counts).toEqual(b.counts);
    expect(a.conflicts).toEqual(b.conflicts);
  });
});
