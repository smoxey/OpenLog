import { describe, expect, it } from 'vitest';
import {
  computeTotals,
  emptyTotals,
  groupTotals,
  isInRange,
  rangeWindow,
  simulatorTotals,
  sumTotals,
} from './totals';
import { SAMPLE_FLIGHTS } from '../export/fixtures/sample-logbook';
import { SUMMABLE_FIELDS } from '../registry/fields';
import { addDays, localIsoDate } from '../time/blockTime';
import type { Flight } from './flight';

/** "Now" for every range test. A fixed local noon, so no test is time-of-day dependent. */
const NOW = new Date(2026, 6, 18, 12, 0, 0); // 18 July 2026, local
const TODAY = localIsoDate(NOW);

function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    schemaVersion: 3,
    entryType: 'flight',
    date: TODAY,
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '10:00',
    onBlock: '11:30',
    aircraftType: 'C172',
    registration: 'LN-ABC',
    picName: '',
    totalMinutes: 90,
    picMinutes: 90,
    coPilotMinutes: 0,
    dualMinutes: 0,
    instructorMinutes: 0,
    singlePilotSeMinutes: 90,
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

function session(overrides: Partial<Flight> = {}): Flight {
  return flight({
    entryType: 'fstd',
    depAerodrome: 'SIM',
    arrAerodrome: 'SIM',
    offBlock: '',
    onBlock: '',
    registration: '',
    totalMinutes: 0,
    picMinutes: 0,
    singlePilotSeMinutes: 0,
    landingsDay: 0,
    simulatorMinutes: 120,
    simulatorRegistration: 'EU-DK187',
    ...overrides,
  });
}

describe('sumTotals', () => {
  it('returns zero for every summable field on an empty logbook', () => {
    const totals = sumTotals([]);
    expect(Object.keys(totals).sort()).toEqual(SUMMABLE_FIELDS.map((f) => f.key).sort());
    for (const key of Object.keys(totals)) expect(totals[key]).toBe(0);
  });

  it('matches the permanent sample logbook, field by field', () => {
    const totals = sumTotals(SAMPLE_FLIGHTS);
    const expected = emptyTotals();
    for (const record of SAMPLE_FLIGHTS) {
      for (const field of SUMMABLE_FIELDS) {
        const raw = (record as unknown as Record<string, unknown>)[field.key];
        if (typeof raw === 'number') expected[field.key] += raw;
      }
    }
    expect(totals).toEqual(expected);
  });

  it('sums a field stored in `extra`', () => {
    // No summable `extra` field exists yet, so this proves the READ path rather
    // than a live field: an `extra` value must not leak into a core-field total.
    const withExtra = flight({ extra: { totalMinutes: 999 } });
    expect(sumTotals([withExtra]).totalMinutes).toBe(90);
  });

  it('ignores a non-numeric value rather than producing NaN', () => {
    const damaged = flight({ totalMinutes: 'ninety' as unknown as number });
    expect(sumTotals([damaged]).totalMinutes).toBe(0);
  });
});

describe('simulator time never joins a flight total', () => {
  it('leaves every flight total completely unchanged', () => {
    const flights = [flight(), flight({ totalMinutes: 60, singlePilotSeMinutes: 60 })];
    const before = sumTotals(flights);
    const after = sumTotals([...flights, session()]);
    // The WHOLE object, not just total time: this is the governing rule of the
    // entry-type design and a single leaking column would break it.
    expect(after).toEqual(before);
  });

  it('reports session time in its own figure', () => {
    const sim = simulatorTotals([flight(), session({ simulatorMinutes: 90 }), session()]);
    expect(sim).toEqual({ sessionMinutes: 210, sessionCount: 2 });
  });

  it('counts no sessions in a logbook of flights', () => {
    expect(simulatorTotals([flight(), flight()])).toEqual({
      sessionMinutes: 0,
      sessionCount: 0,
    });
  });
});

describe('rangeWindow', () => {
  it('reaches back 28 whole days, inclusive', () => {
    expect(rangeWindow('last28', NOW)).toEqual({ from: addDays(TODAY, -28), to: TODAY });
  });

  it('starts the calendar year on 1 January and ends today', () => {
    expect(rangeWindow('calendarYear', NOW)).toEqual({ from: '2026-01-01', to: TODAY });
  });

  it('is unbounded for all time', () => {
    expect(rangeWindow('allTime', NOW)).toEqual({ from: null, to: null });
  });
});

describe('range boundaries', () => {
  it('includes a flight exactly 28 days ago and excludes one 29 days ago', () => {
    const inside = flight({ date: addDays(TODAY, -28) });
    const outside = flight({ date: addDays(TODAY, -29) });
    const totals = computeTotals([inside, outside], 'last28', NOW);
    expect(totals.flightCount).toBe(1);
    expect(totals.totals.totalMinutes).toBe(90);
  });

  it('includes a flight exactly 90 days ago and excludes one 91 days ago', () => {
    const inside = flight({ date: addDays(TODAY, -90) });
    const outside = flight({ date: addDays(TODAY, -91) });
    const totals = computeTotals([inside, outside], 'last90', NOW);
    expect(totals.flightCount).toBe(1);
  });

  it('includes today', () => {
    expect(computeTotals([flight({ date: TODAY })], 'last28', NOW).flightCount).toBe(1);
  });

  it('excludes last year from the calendar year', () => {
    const totals = computeTotals(
      [flight({ date: '2026-01-01' }), flight({ date: '2025-12-31' })],
      'calendarYear',
      NOW,
    );
    expect(totals.flightCount).toBe(1);
  });

  it('counts a leap day inside a range', () => {
    const leapNow = new Date(2024, 2, 1, 12, 0, 0); // 1 March 2024
    const totals = computeTotals([flight({ date: '2024-02-29' })], 'last28', leapNow);
    expect(totals.flightCount).toBe(1);
  });

  it('counts everything in the all-time range', () => {
    const totals = computeTotals(
      [flight({ date: '1998-04-01' }), flight({ date: TODAY })],
      'allTime',
      NOW,
    );
    expect(totals.flightCount).toBe(2);
  });
});

describe('a damaged date', () => {
  it('is still counted in the all-time total', () => {
    // Losing a record silently from every figure is worse than showing it in
    // the one figure that has no date bounds to place it in.
    const totals = computeTotals([flight({ date: 'not-a-date' })], 'allTime', NOW);
    expect(totals.flightCount).toBe(1);
  });

  it('is outside every bounded window', () => {
    expect(isInRange('not-a-date', { from: '2026-01-01', to: '2026-12-31' })).toBe(false);
    expect(isInRange(undefined, { from: '2026-01-01', to: null })).toBe(false);
  });
});

describe('groupings', () => {
  it('sums each type group to the same figure the all-time total gives', () => {
    const flights = [
      flight({ aircraftType: 'C172', totalMinutes: 60, singlePilotSeMinutes: 60 }),
      flight({ aircraftType: 'C172', totalMinutes: 90, singlePilotSeMinutes: 90 }),
      flight({ aircraftType: 'PA28', totalMinutes: 45, singlePilotSeMinutes: 45 }),
    ];
    const groups = groupTotals(flights, 'aircraftType');
    const grouped = groups.reduce((sum, g) => sum + g.totals.totalMinutes, 0);
    expect(grouped).toBe(sumTotals(flights).totalMinutes);
    expect(groups.map((g) => g.key)).toEqual(['C172', 'PA28']);
  });

  it('treats `ln-abc` and `LN-ABC` as one registration', () => {
    const groups = groupTotals(
      [flight({ registration: 'ln-abc' }), flight({ registration: 'LN-ABC ' })],
      'registration',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: 'LN-ABC', flightCount: 2 });
  });

  it('orders by total time descending', () => {
    const groups = groupTotals(
      [
        flight({ aircraftType: 'PA28', totalMinutes: 30 }),
        flight({ aircraftType: 'C172', totalMinutes: 300 }),
      ],
      'aircraftType',
    );
    expect(groups.map((g) => g.key)).toEqual(['C172', 'PA28']);
  });

  it('breaks a tie by key, so equal totals always render in the same order', () => {
    const groups = groupTotals(
      [
        flight({ aircraftType: 'PA28', totalMinutes: 60 }),
        flight({ aircraftType: 'C172', totalMinutes: 60 }),
        flight({ aircraftType: 'BE76', totalMinutes: 60 }),
      ],
      'aircraftType',
    );
    expect(groups.map((g) => g.key)).toEqual(['BE76', 'C172', 'PA28']);
  });

  it('does not invent an aircraft out of a simulator session', () => {
    const groups = groupTotals([flight(), session()], 'registration');
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('LN-ABC');
  });

  it('keeps records with no type in their own empty-keyed group rather than dropping them', () => {
    const groups = groupTotals([flight({ aircraftType: '' })], 'aircraftType');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: '', flightCount: 1 });
  });
});

describe('the performance budget', () => {
  /*
    A SMOKE ALARM, NOT A BENCHMARK.

    The threshold is deliberately loose. This suite runs its files in parallel,
    so a tight wall-clock assertion measures how busy the machine is as much as
    how fast the code is — and a test that fails for that reason teaches people
    to ignore it. What it is really here to catch is an accidental O(n²): the
    honest work below takes single-digit milliseconds, so a quadratic mistake
    would miss this by orders of magnitude rather than by a hair.
  */
  it('totals 2,000 flights without a quadratic blowup', () => {
    const many = Array.from({ length: 2000 }, (_, i) =>
      flight({ date: addDays(TODAY, -(i % 400)) }),
    );
    const started = performance.now();
    computeTotals(many, 'allTime', NOW);
    computeTotals(many, 'last90', NOW);
    groupTotals(many, 'aircraftType');
    groupTotals(many, 'registration');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
