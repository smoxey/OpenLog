/**
 * Bulk adjust — the plan.
 *
 * The tests exist to hold three things still, because all three rewrite records
 * the pilot cannot get back:
 *
 *  - the MEANING of add/remove (fill the column with the entry's own time, or
 *    empty it) — not arithmetic on an amount;
 *  - EXACT aircraft matching, unlike the list filter's substring match;
 *  - and the refusal to touch a column that does not apply to the kind of entry.
 */
import { describe, expect, it } from 'vitest';
import {
  ADJUSTABLE_FIELDS,
  EMPTY_SPEC,
  adjustFlight,
  getAdjustableField,
  excludeFromPlan,
  knownValues,
  planBulkAdjust,
  planResults,
  type BulkAdjustSpec,
} from './bulkAdjust';
import type { Flight } from './flight';

function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    schemaVersion: 3,
    entryType: 'flight',
    date: '2026-07-18',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '10:00',
    onBlock: '11:30',
    aircraftType: 'A320',
    registration: 'LN-ABC',
    picName: '',
    totalMinutes: 90,
    picMinutes: 0,
    coPilotMinutes: 0,
    dualMinutes: 0,
    instructorMinutes: 0,
    singlePilotSeMinutes: 0,
    singlePilotMeMinutes: 0,
    multiPilotMinutes: 0,
    nightMinutes: 0,
    ifrMinutes: 0,
    landingsDay: 1,
    landingsNight: 0,
    simulatorMinutes: 0,
    simulatorRegistration: '',
    remarks: '',
    extra: {},
    ...overrides,
  };
}

function sim(overrides: Partial<Flight> = {}): Flight {
  return flight({
    entryType: 'fstd',
    depAerodrome: 'SIM',
    arrAerodrome: 'SIM',
    offBlock: '',
    onBlock: '',
    registration: '',
    totalMinutes: 0,
    simulatorMinutes: 120,
    simulatorRegistration: 'EU-DK187',
    landingsDay: 0,
    ...overrides,
  });
}

function spec(overrides: Partial<BulkAdjustSpec> = {}): BulkAdjustSpec {
  return {
    ...EMPTY_SPEC,
    fieldKey: 'multiPilotMinutes',
    target: 'aircraftType',
    value: 'A320',
    ...overrides,
  };
}

describe('which columns can be adjusted', () => {
  it('offers the summable duration columns', () => {
    const keys = ADJUSTABLE_FIELDS.map((f) => f.key);
    expect(keys).toContain('multiPilotMinutes');
    expect(keys).toContain('singlePilotMeMinutes');
    expect(keys).toContain('singlePilotSeMinutes');
    expect(keys).toContain('ifrMinutes');
    expect(keys).toContain('instructorMinutes');
  });

  it('never offers the yardsticks — they are what the others are measured against', () => {
    const keys = ADJUSTABLE_FIELDS.map((f) => f.key);
    expect(keys).not.toContain('totalMinutes');
    expect(keys).not.toContain('simulatorMinutes');
  });

  it('never offers landings, which are counts and not durations', () => {
    const keys = ADJUSTABLE_FIELDS.map((f) => f.key);
    expect(keys).not.toContain('landingsDay');
    expect(keys).not.toContain('landingsNight');
  });

  it('refuses a key that is not on the list', () => {
    expect(getAdjustableField('totalMinutes')).toBeUndefined();
    expect(planBulkAdjust([flight()], spec({ fieldKey: 'totalMinutes' })).problem).toMatch(
      /not a time column/,
    );
  });
});

describe('what add and remove mean', () => {
  it('add files the entry OWN total into the column', () => {
    const f = flight({ totalMinutes: 138 });
    expect(adjustFlight(f, spec({ operation: 'add' })).multiPilotMinutes).toBe(138);
  });

  it('add reads simulator time on a simulator session, not flight time', () => {
    const s = sim({ simulatorMinutes: 120 });
    const adjusted = adjustFlight(s, spec({ fieldKey: 'ifrMinutes', operation: 'add' }));
    expect(adjusted.ifrMinutes).toBe(120);
    expect(adjusted.totalMinutes).toBe(0);
  });

  it('remove empties the column and leaves the total alone', () => {
    const f = flight({ totalMinutes: 138, multiPilotMinutes: 138 });
    const adjusted = adjustFlight(f, spec({ operation: 'remove' }));
    expect(adjusted.multiPilotMinutes).toBe(0);
    expect(adjusted.totalMinutes).toBe(138);
  });

  it('never mutates the input', () => {
    const f = flight({ totalMinutes: 90 });
    adjustFlight(f, spec());
    expect(f.multiPilotMinutes).toBe(0);
  });
});

describe('matching an aircraft', () => {
  it('matches a type exactly, not as a prefix', () => {
    const flights = [flight({ aircraftType: 'A320' }), flight({ aircraftType: 'A321' })];
    const plan = planBulkAdjust(flights, spec({ value: 'A32' }));
    expect(plan.problem).toMatch(/Nothing in the logbook matches/);
  });

  it('ignores case and surrounding space on both sides', () => {
    const flights = [flight({ aircraftType: ' a320 ' })];
    expect(planBulkAdjust(flights, spec({ value: 'A320' })).changes).toHaveLength(1);
    expect(planBulkAdjust(flights, spec({ value: '  a320' })).changes).toHaveLength(1);
  });

  it('takes every registration of a type', () => {
    const flights = [
      flight({ aircraftType: 'A320', registration: 'LN-AAA' }),
      flight({ aircraftType: 'A320', registration: 'LN-BBB' }),
      flight({ aircraftType: 'C172', registration: 'LN-CCC' }),
    ];
    const plan = planBulkAdjust(flights, spec());
    expect(plan.changes).toHaveLength(2);
  });

  it('matches a single registration when asked to', () => {
    const flights = [
      flight({ registration: 'LN-AAA' }),
      flight({ registration: 'LN-BBB' }),
    ];
    const plan = planBulkAdjust(flights, spec({ target: 'registration', value: 'ln-aaa' }));
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].flight.registration).toBe('LN-AAA');
  });

  it('identifies a simulator session by its device id', () => {
    const flights = [sim({ simulatorRegistration: 'EU-DK187' })];
    const plan = planBulkAdjust(
      flights,
      spec({ fieldKey: 'ifrMinutes', target: 'registration', value: 'EU-DK187' }),
    );
    expect(plan.changes).toHaveLength(1);
  });

  it('asks for an aircraft before it will plan anything', () => {
    expect(planBulkAdjust([flight()], spec({ value: '   ' })).problem).toMatch(/Enter an aircraft/);
  });
});

describe('the date range', () => {
  const flights = [
    flight({ date: '2025-12-31' }),
    flight({ date: '2026-01-01' }),
    flight({ date: '2026-06-30' }),
    flight({ date: '2026-12-31' }),
    flight({ date: '2027-01-01' }),
  ];

  it('takes everything when both ends are empty', () => {
    expect(planBulkAdjust(flights, spec()).changes).toHaveLength(5);
  });

  it('includes both ends', () => {
    const plan = planBulkAdjust(flights, spec({ from: '2026-01-01', to: '2026-12-31' }));
    expect(plan.changes.map((c) => c.flight.date)).toEqual([
      '2026-01-01',
      '2026-06-30',
      '2026-12-31',
    ]);
  });

  it('treats one empty end as unbounded on that side', () => {
    expect(planBulkAdjust(flights, spec({ from: '2026-12-31' })).changes).toHaveLength(2);
    expect(planBulkAdjust(flights, spec({ to: '2026-01-01' })).changes).toHaveLength(2);
  });

  it('refuses a range that ends before it starts', () => {
    const plan = planBulkAdjust(flights, spec({ from: '2026-12-31', to: '2026-01-01' }));
    expect(plan.problem).toMatch(/ends before it starts/);
    expect(plan.changes).toHaveLength(0);
  });
});

describe('what the plan counts', () => {
  it('counts only entries whose value actually moves', () => {
    const flights = [
      flight({ totalMinutes: 90, multiPilotMinutes: 0 }),
      flight({ totalMinutes: 90, multiPilotMinutes: 90 }),
    ];
    const plan = planBulkAdjust(flights, spec());
    expect(plan.matched).toHaveLength(2);
    expect(plan.changes).toHaveLength(1);
    expect(plan.unchangedCount).toBe(1);
  });

  it('says so rather than offering a no-op run', () => {
    const flights = [flight({ totalMinutes: 90, multiPilotMinutes: 90 })];
    expect(planBulkAdjust(flights, spec()).problem).toMatch(/already read that way/);
  });

  it('reports the minutes on both sides of the change', () => {
    const flights = [flight({ totalMinutes: 90 }), flight({ totalMinutes: 120 })];
    const plan = planBulkAdjust(flights, spec());
    expect(plan.minutesBefore).toBe(0);
    expect(plan.minutesAfter).toBe(210);
  });

  it('splits the count by kind of entry', () => {
    const flights = [flight({ ifrMinutes: 0 }), sim({ ifrMinutes: 0 })];
    const plan = planBulkAdjust(flights, spec({ fieldKey: 'ifrMinutes' }));
    expect(plan.changedFlightCount).toBe(1);
    expect(plan.changedFstdCount).toBe(1);
  });
});

describe('columns that do not apply to an entry type', () => {
  it('leaves simulator sessions out of a multi-pilot fill', () => {
    // multiPilotMinutes is a flight-only column: `applyEntryTypeInvariants`
    // would zero it again on write, so writing it would be a lie told twice.
    const flights = [sim({ aircraftType: 'A320' })];
    const plan = planBulkAdjust(flights, spec());
    expect(plan.matched).toHaveLength(0);
    expect(plan.problem).toMatch(/Nothing in the logbook matches/);
  });

  it('includes simulator sessions for a column they do have', () => {
    const flights = [sim({ aircraftType: 'A320' })];
    const plan = planBulkAdjust(flights, spec({ fieldKey: 'ifrMinutes' }));
    expect(plan.changes).toHaveLength(1);
  });
});

describe('mutually exclusive columns', () => {
  it('warns rather than clearing the sibling, so two passes do not undo each other', () => {
    const flights = [flight({ totalMinutes: 90, singlePilotMeMinutes: 90 })];
    const plan = planBulkAdjust(flights, spec({ fieldKey: 'multiPilotMinutes' }));
    expect(plan.problem).toBeUndefined();
    expect(plan.exclusivityWarnings).toHaveLength(1);
    expect(plan.exclusivityWarnings[0].otherKey).toBe('singlePilotMeMinutes');
    // The sibling survives — the pilot asked for one column, not for a rewrite
    // of the other two.
    expect(planResults(plan)[0].singlePilotMeMinutes).toBe(90);
    expect(planResults(plan)[0].multiPilotMinutes).toBe(90);
  });

  it('says nothing when no sibling is set', () => {
    const flights = [flight({ totalMinutes: 90 })];
    expect(planBulkAdjust(flights, spec()).exclusivityWarnings).toHaveLength(0);
  });

  it('says nothing when emptying a column — that can only resolve a clash', () => {
    const flights = [flight({ totalMinutes: 90, multiPilotMinutes: 90, singlePilotMeMinutes: 90 })];
    const plan = planBulkAdjust(flights, spec({ operation: 'remove' }));
    expect(plan.exclusivityWarnings).toHaveLength(0);
  });

  it('says nothing for a column that is not one of the three', () => {
    const flights = [flight({ totalMinutes: 90, multiPilotMinutes: 90 })];
    const plan = planBulkAdjust(flights, spec({ fieldKey: 'ifrMinutes' }));
    expect(plan.exclusivityWarnings).toHaveLength(0);
  });
});

describe('planResults', () => {
  it('produces one adjusted record per change and nothing else', () => {
    const flights = [flight({ totalMinutes: 90 }), flight({ aircraftType: 'C172' })];
    const results = planResults(planBulkAdjust(flights, spec()));
    expect(results).toHaveLength(1);
    expect(results[0].multiPilotMinutes).toBe(90);
  });

  it('produces nothing for a plan that cannot run', () => {
    expect(planResults(planBulkAdjust([flight()], spec({ value: '' })))).toEqual([]);
  });

  it('preserves everything else on the record, including extra', () => {
    const flights = [flight({ totalMinutes: 90, remarks: 'ILS 19R', extra: { legacyId: 7 } })];
    const [result] = planResults(planBulkAdjust(flights, spec()));
    expect(result.remarks).toBe('ILS 19R');
    expect(result.extra).toEqual({ legacyId: 7 });
    expect(result.id).toBe(flights[0].id);
  });
});

describe('knownValues', () => {
  it('lists distinct types, sorted', () => {
    const flights = [
      flight({ aircraftType: 'C172' }),
      flight({ aircraftType: 'A320' }),
      flight({ aircraftType: 'a320' }),
    ];
    expect(knownValues(flights, 'aircraftType')).toEqual(['A320', 'C172']);
  });

  it('lists registrations and simulator device ids together', () => {
    const flights = [flight({ registration: 'LN-ABC' }), sim({ simulatorRegistration: 'EU-DK187' })];
    expect(knownValues(flights, 'registration')).toEqual(['EU-DK187', 'LN-ABC']);
  });

  it('leaves out empties', () => {
    expect(knownValues([flight({ aircraftType: '' })], 'aircraftType')).toEqual([]);
  });
});

/**
 * Unticking a row.
 *
 * The plan the pilot reads and the plan that runs must be the same object
 * narrowed, not two computations that could drift apart — so these hold that
 * every number the screen and the confirmation quote follows the ticks, and
 * that the two counts which describe the LOGBOOK rather than the ticks do not.
 */
describe('excludeFromPlan', () => {
  it('drops the unticked entries from what would be written', () => {
    const keep = flight({ registration: 'LN-AAA', totalMinutes: 90 });
    const drop = flight({ registration: 'LN-BBB', totalMinutes: 60 });
    const plan = excludeFromPlan(planBulkAdjust([keep, drop], spec()), new Set([drop.id]));

    expect(plan.changes.map((c) => c.flight.id)).toEqual([keep.id]);
    expect(plan.excludedCount).toBe(1);
    expect(planResults(plan)).toHaveLength(1);
    expect(planResults(plan)[0].id).toBe(keep.id);
  });

  it('narrows the minutes and the split by kind of entry', () => {
    const keep = flight({ registration: 'LN-AAA', totalMinutes: 90 });
    const drop = flight({ registration: 'LN-BBB', totalMinutes: 60 });
    const session = sim({ aircraftType: 'A320', simulatorMinutes: 120 });
    const base = planBulkAdjust([keep, drop, session], spec({ fieldKey: 'ifrMinutes' }));
    expect(base.changes).toHaveLength(3);

    const plan = excludeFromPlan(base, new Set([drop.id, session.id]));
    expect(plan.changedFlightCount).toBe(1);
    expect(plan.changedFstdCount).toBe(0);
    expect(plan.minutesBefore).toBe(0);
    expect(plan.minutesAfter).toBe(90);
  });

  it('drops the clash warning of an entry that is no longer being changed', () => {
    const clashing = flight({ registration: 'LN-AAA', singlePilotMeMinutes: 90 });
    const base = planBulkAdjust([clashing], spec());
    expect(base.exclusivityWarnings).toHaveLength(1);

    expect(excludeFromPlan(base, new Set([clashing.id])).exclusivityWarnings).toEqual([]);
  });

  it('reports unticking everything as a problem, so Apply has one rule', () => {
    const only = flight();
    const plan = excludeFromPlan(planBulkAdjust([only], spec()), new Set([only.id]));

    expect(plan.problem).toMatch(/unticked/i);
    expect(plan.changes).toEqual([]);
    expect(planResults(plan)).toEqual([]);
  });

  it('leaves what describes the logbook alone — matched, and already-right entries', () => {
    const keep = flight({ registration: 'LN-AAA', totalMinutes: 90 });
    const drop = flight({ registration: 'LN-BBB', totalMinutes: 60 });
    const already = flight({ registration: 'LN-CCC', totalMinutes: 75, multiPilotMinutes: 75 });
    const base = planBulkAdjust([keep, drop, already], spec());
    expect(base.unchangedCount).toBe(1);

    const plan = excludeFromPlan(base, new Set([drop.id]));
    expect(plan.matched).toHaveLength(3);
    expect(plan.unchangedCount).toBe(1);
  });

  it('ignores ids that are not in the plan, rather than mis-counting', () => {
    const only = flight();
    const base = planBulkAdjust([only], spec());
    const plan = excludeFromPlan(base, new Set(['an-id-from-a-sentence-since-edited']));

    expect(plan).toBe(base);
    expect(plan.excludedCount).toBe(0);
  });

  it('leaves an unrunnable plan exactly as it found it', () => {
    const base = planBulkAdjust([flight()], spec({ value: 'B738' }));
    expect(excludeFromPlan(base, new Set(['anything']))).toBe(base);
  });
});
