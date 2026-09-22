/**
 * Bulk night time — the plan.
 *
 * These hold still the three promises the tool makes to a pilot who is about to
 * let it rewrite hundreds of flights they cannot get back:
 *
 *  - it works out night the SAME WAY the entry form does, from a real route
 *    and a real clock — never a second definition of night;
 *  - what it cannot work out it SKIPS AND SAYS SO, rather than writing a zero
 *    that is indistinguishable from a real answer;
 *  - and every flight it would change can be individually refused, with the
 *    logged figure kept exactly as it was.
 *
 * The aerodromes here are real coordinates for real places, so the night
 * figures asserted below are the ones the sun actually produces. A test that
 * mocked the calculation would prove only that the plumbing runs.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_NIGHT_SPEC,
  applyNightToFlight,
  excludeFromNightPlan,
  nightPlanResults,
  planBulkNight,
  type BulkNightSpec,
} from './bulkNight';
import type { Airport } from '../airports/types';
import type { Flight } from './flight';

/** A handful of real aerodromes, so the sun in these tests is the real sun. */
const AIRPORTS: Record<string, Airport> = {
  ENGM: { code: 'ENGM', lat: 60.1939, lon: 11.1004 },
  ENBR: { code: 'ENBR', lat: 60.2934, lon: 5.2181 },
  EKCH: { code: 'EKCH', lat: 55.6179, lon: 12.656 },
  ENTC: { code: 'ENTC', lat: 69.6833, lon: 18.9189 },
};

const lookup = (code: string): Airport | undefined => AIRPORTS[code.toUpperCase()];

function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    schemaVersion: 3,
    entryType: 'flight',
    date: '2026-01-15',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    // 20:00–21:00 UTC in mid-January over southern Norway: solidly dark.
    offBlock: '20:00',
    onBlock: '21:00',
    aircraftType: 'A320',
    registration: 'LN-ABC',
    picName: '',
    totalMinutes: 60,
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
  } as Flight;
}

const spec = (overrides: Partial<BulkNightSpec> = {}): BulkNightSpec => ({
  ...EMPTY_NIGHT_SPEC,
  ...overrides,
});

describe('planBulkNight', () => {
  it('works out night for a flight that has none', () => {
    const plan = planBulkNight([flight()], spec(), lookup);

    expect(plan.problem).toBeUndefined();
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].before).toBe(0);
    // A whole hour in the dark, capped at the flight's own total.
    expect(plan.changes[0].after).toBe(60);
    expect(plan.minutesAfter).toBe(60);
  });

  it('leaves a daytime flight alone rather than writing a zero over a zero', () => {
    const day = flight({ offBlock: '10:00', onBlock: '11:00' });
    const plan = planBulkNight([day], spec(), lookup);

    expect(plan.changes).toHaveLength(0);
    expect(plan.unchangedCount).toBe(1);
    expect(plan.problem).toContain('already reads that way');
  });

  describe('scope', () => {
    it('"missing" never offers a flight that already carries a night figure', () => {
      const logged = flight({ nightMinutes: 42 });
      const plan = planBulkNight([logged], spec({ scope: 'missing' }), lookup);

      expect(plan.matched).toHaveLength(0);
      expect(plan.changes).toHaveLength(0);
      expect(plan.problem).toContain('already has a night figure');
    });

    it('"all" offers it, and reports that accepting would overwrite', () => {
      const logged = flight({ nightMinutes: 42 });
      const plan = planBulkNight([logged], spec({ scope: 'all' }), lookup);

      expect(plan.changes).toHaveLength(1);
      expect(plan.changes[0].before).toBe(42);
      expect(plan.changes[0].after).toBe(60);
      expect(plan.overwriteCount).toBe(1);
    });
  });

  describe('what it refuses to guess at', () => {
    it('skips a flight whose aerodrome is not in the list, and names it', () => {
      const unknown = flight({ arrAerodrome: 'ZZZZ' });
      const plan = planBulkNight([unknown], spec(), lookup);

      expect(plan.changes).toHaveLength(0);
      expect(plan.skipped).toHaveLength(1);
      expect(plan.skipped[0].reason).toBe('unknownAerodrome');
      expect(plan.skipped[0].missing).toEqual(['ZZZZ']);
      expect(plan.missingAerodromes).toEqual(['ZZZZ']);
    });

    it('skips a flight with no block times', () => {
      const noTimes = flight({ offBlock: '', onBlock: '' });
      const plan = planBulkNight([noTimes], spec(), lookup);

      expect(plan.changes).toHaveLength(0);
      expect(plan.skipped[0].reason).toBe('incomplete');
    });

    it('never considers a simulator session — there is no sun in a simulator', () => {
      const sim = flight({
        entryType: 'fstd',
        depAerodrome: '',
        arrAerodrome: '',
        totalMinutes: 0,
        simulatorMinutes: 120,
        simulatorRegistration: 'SIM-1',
      });
      const plan = planBulkNight([sim], spec(), lookup);

      expect(plan.matched).toHaveLength(0);
      expect(plan.skipped).toHaveLength(0);
    });

    it('orders the missing aerodromes by how often they turn up', () => {
      const flights = [
        flight({ arrAerodrome: 'ZZZZ' }),
        flight({ arrAerodrome: 'ZZZZ' }),
        flight({ arrAerodrome: 'YYYY' }),
      ];
      const plan = planBulkNight(flights, spec(), lookup);

      expect(plan.missingAerodromes).toEqual(['ZZZZ', 'YYYY']);
    });
  });

  describe('date bounds', () => {
    it('only offers flights inside them, both ends included', () => {
      const flights = [
        flight({ date: '2026-01-10' }),
        flight({ date: '2026-01-15' }),
        flight({ date: '2026-01-20' }),
      ];
      const plan = planBulkNight(flights, spec({ from: '2026-01-15', to: '2026-01-20' }), lookup);

      expect(plan.changes).toHaveLength(2);
      expect(plan.changes.map((c) => c.flight.date)).toEqual(['2026-01-15', '2026-01-20']);
    });

    it('refuses a range that ends before it starts', () => {
      const plan = planBulkNight(
        [flight()],
        spec({ from: '2026-02-01', to: '2026-01-01' }),
        lookup,
      );

      expect(plan.problem).toBe('The date range ends before it starts.');
      expect(plan.changes).toHaveLength(0);
    });
  });

  it('flags the flights where the sun sat close to the threshold', () => {
    // A high-latitude winter afternoon, where twilight is long and a minute
    // either way is a real judgement call rather than arithmetic.
    const flights = [flight({ depAerodrome: 'ENTC', arrAerodrome: 'ENGM' })];
    const plan = planBulkNight(flights, spec(), lookup);

    expect(plan.grazingCount).toBe(plan.changes.filter((c) => c.grazing).length);
  });

  it('caps the night figure at the flight it belongs to', () => {
    // The block times say an hour; the total says forty minutes. Night can
    // never exceed the total, or `validateFlight` would reject the record.
    const short = flight({ totalMinutes: 40 });
    const plan = planBulkNight([short], spec(), lookup);

    expect(plan.changes[0].after).toBeLessThanOrEqual(40);
  });
});

describe('excludeFromNightPlan — keeping what was logged', () => {
  it('leaves an unticked flight exactly as it was', () => {
    const keep = flight({ nightMinutes: 42 });
    const change = flight({ nightMinutes: 10 });
    const base = planBulkNight([keep, change], spec({ scope: 'all' }), lookup);
    expect(base.changes).toHaveLength(2);

    const narrowed = excludeFromNightPlan(base, new Set([keep.id]));

    expect(narrowed.changes).toHaveLength(1);
    expect(narrowed.excludedCount).toBe(1);
    expect(narrowed.changes[0].flight.id).toBe(change.id);
    // And the write derived from it does not mention the kept flight at all.
    expect(nightPlanResults(narrowed).map((f) => f.id)).toEqual([change.id]);
  });

  it('narrows the minutes and the counts with the ticks', () => {
    const a = flight({ nightMinutes: 5 });
    const b = flight({ nightMinutes: 7 });
    const base = planBulkNight([a, b], spec({ scope: 'all' }), lookup);

    const narrowed = excludeFromNightPlan(base, new Set([a.id]));

    expect(narrowed.minutesBefore).toBe(7);
    expect(narrowed.minutesAfter).toBe(60);
    expect(narrowed.overwriteCount).toBe(1);
  });

  it('does not narrow what describes the logbook rather than the ticks', () => {
    const changing = flight();
    const skipped = flight({ arrAerodrome: 'ZZZZ' });
    const base = planBulkNight([changing, skipped], spec(), lookup);

    const narrowed = excludeFromNightPlan(base, new Set([changing.id]));

    expect(narrowed.matched).toHaveLength(2);
    expect(narrowed.skipped).toHaveLength(1);
  });

  it('makes unticking everything a problem, so Apply disables by one rule', () => {
    const one = flight();
    const base = planBulkNight([one], spec(), lookup);

    const narrowed = excludeFromNightPlan(base, new Set([one.id]));

    expect(narrowed.problem).toBe('Every flight is unticked — nothing left to change.');
    expect(nightPlanResults(narrowed)).toEqual([]);
  });

  it('ignores ids that are no longer in the plan', () => {
    const base = planBulkNight([flight()], spec(), lookup);

    expect(excludeFromNightPlan(base, new Set(['gone'])).changes).toHaveLength(1);
  });
});

describe('applyNightToFlight', () => {
  it('moves the night figure and nothing else', () => {
    const before = flight({ landingsDay: 1, landingsNight: 0, ifrMinutes: 55 });

    const after = applyNightToFlight(before, 60);

    expect(after.nightMinutes).toBe(60);
    // The landing columns are deliberately not touched by the bulk tool.
    expect(after.landingsDay).toBe(1);
    expect(after.landingsNight).toBe(0);
    expect(after.ifrMinutes).toBe(55);
    expect(before.nightMinutes).toBe(0);
  });
});
