import { describe, expect, it } from 'vitest';
import { EMPTY_CRITERIA, filterFlights, isEmptyCriteria } from './filter';
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

/** Criteria with only the named fields set. */
function criteria(overrides: Partial<typeof EMPTY_CRITERIA> = {}) {
  return { ...EMPTY_CRITERIA, ...overrides };
}

describe('no criteria', () => {
  it('returns everything', () => {
    const flights = [flight(), flight()];
    expect(filterFlights(flights, EMPTY_CRITERIA)).toHaveLength(2);
  });

  it('recognises whitespace-only criteria as empty', () => {
    expect(isEmptyCriteria(criteria({ text: '   ', registration: '\t' }))).toBe(true);
  });

  it('returns a copy rather than the original array', () => {
    const flights = [flight()];
    expect(filterFlights(flights, EMPTY_CRITERIA)).not.toBe(flights);
  });
});

describe('free text', () => {
  it('matches remarks', () => {
    const flights = [
      flight({ remarks: 'ILS 01 to minimums' }),
      flight({ remarks: 'Local circuits' }),
    ];
    expect(filterFlights(flights, criteria({ text: 'ILS' }))).toHaveLength(1);
  });

  it('matches an aerodrome', () => {
    const flights = [flight({ arrAerodrome: 'ENBR' }), flight({ arrAerodrome: 'ENVA' })];
    expect(filterFlights(flights, criteria({ text: 'enva' }))).toHaveLength(1);
  });

  it('matches a registration and a type', () => {
    const flights = [flight({ registration: 'LN-XYZ' }), flight({ aircraftType: 'PA28' })];
    expect(filterFlights(flights, criteria({ text: 'xyz' }))).toHaveLength(1);
    expect(filterFlights(flights, criteria({ text: 'pa28' }))).toHaveLength(1);
  });

  it('matches a simulator device id', () => {
    const session = flight({
      entryType: 'fstd',
      registration: '',
      simulatorRegistration: 'EU-DK187',
    });
    expect(filterFlights([session, flight()], criteria({ text: 'dk187' }))).toHaveLength(1);
  });

  it('ignores case and surrounding whitespace', () => {
    const flights = [flight({ remarks: 'Night circuits' })];
    expect(filterFlights(flights, criteria({ text: '  NIGHT  ' }))).toHaveLength(1);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterFlights([flight()], criteria({ text: 'zzzz' }))).toEqual([]);
  });
});

describe('structured criteria', () => {
  it('filters by date range, inclusive at both ends', () => {
    const flights = [
      flight({ date: '2026-01-01' }),
      flight({ date: '2026-06-15' }),
      flight({ date: '2026-12-31' }),
    ];
    const result = filterFlights(flights, criteria({ from: '2026-01-01', to: '2026-06-15' }));
    expect(result.map((f) => f.date)).toEqual(['2026-01-01', '2026-06-15']);
  });

  it('accepts an open-ended range', () => {
    const flights = [flight({ date: '2025-01-01' }), flight({ date: '2026-01-01' })];
    expect(filterFlights(flights, criteria({ from: '2026-01-01' }))).toHaveLength(1);
    expect(filterFlights(flights, criteria({ to: '2025-12-31' }))).toHaveLength(1);
  });

  it('filters by aircraft type', () => {
    const flights = [flight({ aircraftType: 'C172' }), flight({ aircraftType: 'PA28' })];
    expect(filterFlights(flights, criteria({ aircraftType: 'pa28' }))).toHaveLength(1);
  });

  it('matches a registration through the same normalization the store uses', () => {
    const flights = [flight({ registration: 'LN-ABC' }), flight({ registration: 'LN-XYZ' })];
    expect(filterFlights(flights, criteria({ registration: 'ln-abc' }))).toHaveLength(1);
    expect(filterFlights(flights, criteria({ registration: '  ln-abc  ' }))).toHaveLength(1);
  });

  it('matches an aerodrome at EITHER end', () => {
    const flights = [
      flight({ depAerodrome: 'ENBR', arrAerodrome: 'ENGM' }),
      flight({ depAerodrome: 'ENGM', arrAerodrome: 'ENBR' }),
      flight({ depAerodrome: 'ENVA', arrAerodrome: 'ENZV' }),
    ];
    expect(filterFlights(flights, criteria({ aerodrome: 'ENBR' }))).toHaveLength(2);
  });
});

describe('criteria compose with AND', () => {
  const flights = [
    flight({ aircraftType: 'C172', date: '2026-03-01', arrAerodrome: 'ENBR' }),
    flight({ aircraftType: 'C172', date: '2026-09-01', arrAerodrome: 'ENBR' }),
    flight({ aircraftType: 'PA28', date: '2026-03-02', arrAerodrome: 'ENBR' }),
    flight({ aircraftType: 'C172', date: '2026-03-03', arrAerodrome: 'ENVA' }),
  ];

  it('narrows on type AND date range AND aerodrome', () => {
    const result = filterFlights(
      flights,
      criteria({
        aircraftType: 'C172',
        from: '2026-01-01',
        to: '2026-06-30',
        aerodrome: 'ENBR',
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-03-01');
  });

  it('never widens — adding a criterion can only remove rows', () => {
    const broad = filterFlights(flights, criteria({ aircraftType: 'C172' }));
    const narrow = filterFlights(
      flights,
      criteria({ aircraftType: 'C172', aerodrome: 'ENBR' }),
    );
    expect(narrow.length).toBeLessThanOrEqual(broad.length);
    for (const f of narrow) expect(broad).toContain(f);
  });

  it('combines free text with a structured criterion', () => {
    const result = filterFlights(
      [
        flight({ aircraftType: 'C172', remarks: 'ILS' }),
        flight({ aircraftType: 'PA28', remarks: 'ILS' }),
      ],
      criteria({ text: 'ils', aircraftType: 'C172' }),
    );
    expect(result).toHaveLength(1);
  });
});

describe('order and damaged data', () => {
  it('preserves the order it was given', () => {
    const flights = [
      flight({ date: '2026-03-01', remarks: 'a' }),
      flight({ date: '2026-01-01', remarks: 'a' }),
      flight({ date: '2026-02-01', remarks: 'a' }),
    ];
    const result = filterFlights(flights, criteria({ text: 'a' }));
    expect(result.map((f) => f.date)).toEqual(['2026-03-01', '2026-01-01', '2026-02-01']);
  });

  it('keeps a dateless record when no date bound is set', () => {
    const damaged = flight({ date: '' });
    expect(filterFlights([damaged], criteria({ text: 'engm' }))).toHaveLength(1);
  });

  it('excludes a dateless record once a date bound is set', () => {
    const damaged = flight({ date: '' });
    expect(filterFlights([damaged], criteria({ from: '2026-01-01' }))).toEqual([]);
  });
});

describe('the performance budget', () => {
  // A smoke alarm rather than a benchmark, for the reason set out in
  // `totals.test.ts`: the threshold is loose enough to survive a busy
  // machine and tight enough to catch an accidental O(n²).
  it('filters 2,000 flights on every keystroke without a quadratic blowup', () => {
    const many = Array.from({ length: 2000 }, (_, i) =>
      flight({ remarks: `sector ${i}`, aircraftType: i % 2 === 0 ? 'C172' : 'PA28' }),
    );
    const started = performance.now();
    // Ten keystrokes' worth.
    for (let i = 0; i < 10; i += 1) {
      filterFlights(many, criteria({ text: 'sector 1', aircraftType: 'C172' }));
    }
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
