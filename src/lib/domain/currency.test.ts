/**
 * Passenger-carrying recency.
 *
 * These are the highest-stakes tests in the project. Every assertion here is
 * about NOT telling a pilot they are current when they are not, so where a case
 * is ambiguous the test asserts the cautious answer on purpose.
 */
import { describe, expect, it } from 'vitest';
import {
  CURRENCY_WINDOW_DAYS,
  REQUIRED_LANDINGS,
  currencyClassOf,
  currencyReport,
} from './currency';
import { addDays, localIsoDate } from '../time/blockTime';
import type { Flight } from './flight';

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

/** The group for a class key, or undefined when the report has none. */
function group(flights: Flight[], key: string) {
  return currencyReport(flights, NOW).groups.find((g) => g.key === key);
}

describe('the rule', () => {
  it('requires three', () => {
    expect(REQUIRED_LANDINGS).toBe(3);
    expect(CURRENCY_WINDOW_DAYS).toBe(90);
  });

  it('is current on three landings inside the window', () => {
    const flights = [flight(), flight(), flight()];
    expect(group(flights, 'SE')).toMatchObject({ landings: 3, current: true, shortfall: 0 });
  });

  it('is NOT current on two, and says how many are missing', () => {
    const flights = [flight(), flight()];
    expect(group(flights, 'SE')).toMatchObject({ landings: 2, current: false, shortfall: 1 });
  });

  it('COUNTS LANDINGS, NOT FLIGHTS — one flight with three landings is enough', () => {
    const flights = [flight({ landingsDay: 3 })];
    expect(group(flights, 'SE')).toMatchObject({ landings: 3, current: true, flightCount: 1 });
  });

  it('counts night landings toward the general rule', () => {
    // The night VARIANT is a separate restriction and is out of scope. The
    // general rule does not care whether a landing was by day or by night.
    const flights = [flight({ landingsDay: 0, landingsNight: 2 }), flight({ landingsDay: 1 })];
    expect(group(flights, 'SE')).toMatchObject({ landings: 3, current: true });
  });

  it('reports not-current for an empty logbook rather than throwing', () => {
    const report = currencyReport([], NOW);
    expect(report.groups).toEqual([]);
  });
});

describe('the 90-day boundary', () => {
  it('counts a landing made exactly 90 days ago', () => {
    const flights = [
      flight({ date: addDays(TODAY, -90) }),
      flight({ date: addDays(TODAY, -90) }),
      flight({ date: addDays(TODAY, -90) }),
    ];
    expect(group(flights, 'SE')).toMatchObject({ landings: 3, current: true });
  });

  it('does NOT count one made 91 days ago', () => {
    const flights = [
      flight({ date: addDays(TODAY, -91) }),
      flight({ date: addDays(TODAY, -90) }),
      flight({ date: addDays(TODAY, -90) }),
    ];
    expect(group(flights, 'SE')).toMatchObject({ landings: 2, current: false });
  });

  it('reports the window it used', () => {
    expect(currencyReport([], NOW).window).toEqual({ from: addDays(TODAY, -90), to: TODAY });
  });
});

describe('when the currency lapses', () => {
  it('is 90 days after the third-most-recent landing', () => {
    const flights = [
      flight({ date: TODAY }),
      flight({ date: addDays(TODAY, -10) }),
      flight({ date: addDays(TODAY, -40) }), // the third one, counting back
    ];
    expect(group(flights, 'SE')?.currentUntil).toBe(addDays(addDays(TODAY, -40), 90));
  });

  it('ignores landings older than the third when working it out', () => {
    const flights = [
      flight({ date: TODAY }),
      flight({ date: addDays(TODAY, -10) }),
      flight({ date: addDays(TODAY, -40) }),
      flight({ date: addDays(TODAY, -80) }), // older; must not move the date
    ];
    expect(group(flights, 'SE')?.currentUntil).toBe(addDays(addDays(TODAY, -40), 90));
  });

  it('takes the third landing from a single multi-landing flight', () => {
    const flights = [flight({ date: addDays(TODAY, -30), landingsDay: 5 })];
    expect(group(flights, 'SE')?.currentUntil).toBe(addDays(addDays(TODAY, -30), 90));
  });

  it('is null when the pilot is not current', () => {
    expect(group([flight()], 'SE')?.currentUntil).toBeNull();
  });
});

describe('class and type keep their own currencies', () => {
  const me = { singlePilotSeMinutes: 0, singlePilotMeMinutes: 90 };

  it('SE landings do not make a pilot current on ME', () => {
    const flights = [flight(), flight(), flight()];
    expect(group(flights, 'SE')?.current).toBe(true);
    expect(group(flights, 'ME')).toBeUndefined();
  });

  it('ME landings do not make a pilot current on SE', () => {
    const flights = [flight(me), flight(me), flight(me)];
    expect(group(flights, 'ME')?.current).toBe(true);
    expect(group(flights, 'SE')).toBeUndefined();
  });

  it('does not pool SE and ME into one figure', () => {
    const flights = [flight(), flight(), flight(me), flight(me)];
    expect(group(flights, 'SE')?.current).toBe(false);
    expect(group(flights, 'ME')?.current).toBe(false);
  });

  it('keys multi-pilot currency by TYPE — an A320 does nothing for a B738', () => {
    const mp = { singlePilotSeMinutes: 0, multiPilotMinutes: 90 };
    const flights = [
      flight({ ...mp, aircraftType: 'A320' }),
      flight({ ...mp, aircraftType: 'A320' }),
      flight({ ...mp, aircraftType: 'A320' }),
      flight({ ...mp, aircraftType: 'B738' }),
    ];
    expect(group(flights, 'MP:A320')?.current).toBe(true);
    expect(group(flights, 'MP:B738')?.current).toBe(false);
  });
});

describe('reading the class off the flight', () => {
  it('reads single-engine', () => {
    expect(currencyClassOf(flight())).toEqual({ kind: 'SE', typeDesignator: '' });
  });

  it('reads multi-engine', () => {
    expect(
      currencyClassOf(flight({ singlePilotSeMinutes: 0, singlePilotMeMinutes: 90 })),
    ).toEqual({ kind: 'ME', typeDesignator: '' });
  });

  it('reads multi-pilot, carrying the type', () => {
    expect(
      currencyClassOf(
        flight({ singlePilotSeMinutes: 0, multiPilotMinutes: 90, aircraftType: 'A320' }),
      ),
    ).toEqual({ kind: 'MP', typeDesignator: 'A320' });
  });

  it('refuses to guess when two columns are populated', () => {
    // A hand override can legitimately leave SE and ME both non-zero. Picking
    // one would be inventing a fact about the flight.
    expect(
      currencyClassOf(flight({ singlePilotSeMinutes: 90, singlePilotMeMinutes: 90 })),
    ).toMatchObject({ kind: 'unclassified' });
  });

  it('refuses to guess when none is populated', () => {
    expect(
      currencyClassOf(flight({ singlePilotSeMinutes: 0, totalMinutes: 0 })),
    ).toMatchObject({ kind: 'unclassified' });
  });
});

describe('an unclassified record', () => {
  const ambiguous = { singlePilotSeMinutes: 90, singlePilotMeMinutes: 90 };

  it('is reported rather than dropped', () => {
    const flights = [flight(ambiguous), flight(ambiguous), flight(ambiguous)];
    expect(group(flights, 'unclassified')).toMatchObject({ landings: 3 });
  });

  it('NEVER confers a currency, however many landings it has', () => {
    // There is no class to be current on. Reporting `current: true` here would
    // be the exact failure this module exists to avoid.
    const flights = [flight({ ...ambiguous, landingsDay: 10 })];
    expect(group(flights, 'unclassified')?.current).toBe(false);
    expect(group(flights, 'unclassified')?.currentUntil).toBeNull();
  });

  it('sorts below the real currencies', () => {
    const flights = [
      flight({ ...ambiguous, landingsDay: 10 }),
      flight(),
      flight(),
      flight(),
    ];
    const keys = currencyReport(flights, NOW).groups.map((g) => g.key);
    expect(keys[keys.length - 1]).toBe('unclassified');
  });
});

describe('what counts toward nothing', () => {
  it('excludes simulator sessions by an explicit filter', () => {
    /*
      An FSTD entry stores zero landings, so it would contribute nothing anyway.
      This asserts the DELIBERATE exclusion, so that if the landing columns ever
      become writable on a session the rule still holds.
    */
    const session = flight({
      entryType: 'fstd',
      depAerodrome: 'SIM',
      arrAerodrome: 'SIM',
      offBlock: '',
      onBlock: '',
      registration: '',
      totalMinutes: 0,
      singlePilotSeMinutes: 0,
      simulatorMinutes: 120,
      landingsDay: 6, // impossible today; constructed to prove the filter
    });
    const report = currencyReport([session], NOW);
    expect(report.groups).toEqual([]);
    expect(report.skipped.simulator).toBe(1);
  });

  it('excludes a flight dated in the future', () => {
    const flights = [
      flight({ date: addDays(TODAY, 1), landingsDay: 5 }),
      flight(),
      flight(),
    ];
    expect(group(flights, 'SE')?.current).toBe(false);
    expect(currencyReport(flights, NOW).skipped.future).toBe(1);
  });

  it('excludes a flight that landed nowhere', () => {
    const flights = [flight({ landingsDay: 0 }), flight(), flight()];
    expect(group(flights, 'SE')).toMatchObject({ landings: 2, current: false });
  });

  it('cannot be reached by a brought-forward balance', () => {
    // Asserted by construction: the report takes flights and nothing else, so
    // there is no argument through which an opening balance could arrive.
    const report = currencyReport([], NOW);
    expect(report.groups).toEqual([]);
  });

  it('ignores a damaged date rather than counting it', () => {
    const flights = [flight({ date: 'not-a-date', landingsDay: 5 }), flight(), flight()];
    expect(group(flights, 'SE')).toMatchObject({ landings: 2, current: false });
  });

  it('ignores a negative or non-numeric landing count', () => {
    const flights = [
      flight({ landingsDay: -5 as number }),
      flight({ landingsDay: 'three' as unknown as number }),
      flight(),
      flight(),
    ];
    expect(group(flights, 'SE')).toMatchObject({ landings: 2, current: false });
  });
});
