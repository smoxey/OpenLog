import { describe, expect, it } from 'vitest';
import {
  applyOpeningBalance,
  isEmptyOpeningBalance,
  openingBalanceKeys,
  readOpeningBalance,
  sanitizeOpeningBalance,
} from './openingBalance';
import { computeTotals, groupTotals, sumTotals } from './totals';
import { SUMMABLE_FIELDS } from '../registry/fields';
import { localIsoDate } from '../time/blockTime';
import type { Flight } from './flight';

const NOW = new Date(2026, 6, 18, 12, 0, 0);
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

describe('which columns a balance may carry', () => {
  it('is exactly the summable set', () => {
    expect(openingBalanceKeys().sort()).toEqual(SUMMABLE_FIELDS.map((f) => f.key).sort());
  });

  it('has no room for simulator time', () => {
    // Not a special case — `simulatorMinutes` is not summable, so there is no
    // such thing as a brought-forward simulator balance.
    expect(openingBalanceKeys()).not.toContain('simulatorMinutes');
  });
});

describe('sanitizeOpeningBalance', () => {
  it('keeps a usable figure', () => {
    expect(sanitizeOpeningBalance({ totalMinutes: 60000 })).toEqual({ totalMinutes: 60000 });
  });

  it('drops a key that is not a summable field', () => {
    expect(sanitizeOpeningBalance({ totalMinutes: 60, nonsense: 5 })).toEqual({
      totalMinutes: 60,
    });
  });

  it('drops a non-summable registry field', () => {
    expect(sanitizeOpeningBalance({ simulatorMinutes: 600 })).toEqual({});
  });

  it('drops negative, fractional and non-numeric values', () => {
    expect(
      sanitizeOpeningBalance({
        totalMinutes: -60,
        picMinutes: 1.5,
        nightMinutes: '60' as unknown as number,
        ifrMinutes: NaN,
      }),
    ).toEqual({});
  });

  it('drops zeros, so an empty balance has one representation', () => {
    expect(sanitizeOpeningBalance({ totalMinutes: 0, picMinutes: 0 })).toEqual({});
  });

  it('survives rubbish', () => {
    expect(sanitizeOpeningBalance(null)).toEqual({});
    expect(sanitizeOpeningBalance('nope')).toEqual({});
    expect(sanitizeOpeningBalance([1, 2, 3])).toEqual({});
  });
});

describe('readOpeningBalance — the strict, file-reading path', () => {
  it('reports absence as null, which is NOT zero', () => {
    // A file that says nothing about a balance must leave this device's own
    // balance alone rather than wiping it.
    expect(readOpeningBalance(undefined)).toEqual({ balance: null });
    expect(readOpeningBalance(null)).toEqual({ balance: null });
  });

  it('reads a valid balance', () => {
    expect(readOpeningBalance({ totalMinutes: 600, landingsDay: 12 })).toEqual({
      balance: { totalMinutes: 600, landingsDay: 12 },
    });
  });

  it('REFUSES an unknown column rather than dropping it', () => {
    const result = readOpeningBalance({ totalMinutes: 600, madeUpColumn: 5 });
    expect('errors' in result).toBe(true);
  });

  it('REFUSES a fractional or negative figure', () => {
    expect('errors' in readOpeningBalance({ totalMinutes: 1.5 })).toBe(true);
    expect('errors' in readOpeningBalance({ totalMinutes: -1 })).toBe(true);
  });

  it('refuses something that is not a set of figures at all', () => {
    expect('errors' in readOpeningBalance('600')).toBe(true);
    expect('errors' in readOpeningBalance([600])).toBe(true);
  });
});

describe('isEmptyOpeningBalance', () => {
  it('is true for nothing, for an empty object and for all zeros', () => {
    expect(isEmptyOpeningBalance(null)).toBe(true);
    expect(isEmptyOpeningBalance({})).toBe(true);
    expect(isEmptyOpeningBalance({ totalMinutes: 0 })).toBe(true);
  });

  it('is false as soon as anything is carried forward', () => {
    expect(isEmptyOpeningBalance({ totalMinutes: 1 })).toBe(false);
  });
});

describe('applyOpeningBalance', () => {
  it('adds to the existing figure', () => {
    const totals = sumTotals([flight()]);
    const combined = applyOpeningBalance(totals, { totalMinutes: 600 });
    expect(combined.totalMinutes).toBe(690);
  });

  it('does not mutate its input', () => {
    const totals = sumTotals([flight()]);
    applyOpeningBalance(totals, { totalMinutes: 600 });
    expect(totals.totalMinutes).toBe(90);
  });

  it('changes nothing when the balance is empty', () => {
    const totals = sumTotals([flight()]);
    expect(applyOpeningBalance(totals, {})).toEqual(totals);
  });

  it('ignores a column that is not summable', () => {
    const totals = sumTotals([flight()]);
    expect(applyOpeningBalance(totals, { simulatorMinutes: 600 })).toEqual(totals);
  });

  it('carries landings forward too', () => {
    const totals = sumTotals([flight()]);
    expect(applyOpeningBalance(totals, { landingsDay: 400 }).landingsDay).toBe(401);
  });
});

describe('THE RULE: all-time only', () => {
  /*
    The most important tests in this file. A brought-forward figure has no date
    and no aircraft, so there is no honest range or group it can belong to. The
    engine is kept ignorant of the balance and this is what proves it.
  */
  const balance = { totalMinutes: 600, landingsDay: 50 };
  const flights = [flight({ date: TODAY }), flight({ date: '2020-01-01' })];

  it('is absent from a 28-day total', () => {
    const range = computeTotals(flights, 'last28', NOW);
    expect(range.totals.totalMinutes).toBe(90);
  });

  it('is absent from a 90-day total', () => {
    expect(computeTotals(flights, 'last90', NOW).totals.totalMinutes).toBe(90);
  });

  it('is absent from a calendar-year total', () => {
    expect(computeTotals(flights, 'calendarYear', NOW).totals.totalMinutes).toBe(90);
  });

  it('is absent from the raw all-time total until it is explicitly applied', () => {
    // The engine cannot add it even by accident: it has no way to see it.
    expect(computeTotals(flights, 'allTime', NOW).totals.totalMinutes).toBe(180);
  });

  it('is absent from every grouping', () => {
    const byType = groupTotals(flights, 'aircraftType');
    const byReg = groupTotals(flights, 'registration');
    expect(byType.reduce((s, g) => s + g.totals.totalMinutes, 0)).toBe(180);
    expect(byReg.reduce((s, g) => s + g.totals.totalMinutes, 0)).toBe(180);
  });

  it('appears once, and only once, when applied to the all-time total', () => {
    const allTime = computeTotals(flights, 'allTime', NOW);
    const withBalance = applyOpeningBalance(allTime.totals, balance);
    expect(withBalance.totalMinutes).toBe(780);
    expect(withBalance.landingsDay).toBe(52);
  });
});
