import { describe, expect, it } from 'vitest';
import {
  ROWS_PER_SPREAD,
  countCell,
  joinDuration,
  planLogbookPrint,
  splitDuration,
} from './easaLayout';
import type { Flight } from '../domain/flight';

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

/** N flights, one per day, in a scrambled order so sorting has work to do. */
function scrambled(count: number): Flight[] {
  const made = Array.from({ length: count }, (_, i) =>
    flight({ date: `2026-03-${String(i + 1).padStart(2, '0')}`, id: `id-${i}` }),
  );
  return [...made].reverse();
}

describe('the shape of a spread', () => {
  it('rules eight rows', () => {
    expect(ROWS_PER_SPREAD).toBe(8);
  });

  it('pads a short page with blank ruled rows rather than ending in mid-air', () => {
    const plan = planLogbookPrint(scrambled(3));
    expect(plan.spreads).toHaveLength(1);
    expect(plan.spreads[0].rows).toHaveLength(8);
    expect(plan.spreads[0].rows.slice(3).every((r) => r === null)).toBe(true);
  });

  it('starts a second spread on the ninth flight', () => {
    expect(planLogbookPrint(scrambled(8)).spreads).toHaveLength(1);
    expect(planLogbookPrint(scrambled(9)).spreads).toHaveLength(2);
  });

  it('produces one blank spread for an empty logbook', () => {
    // A blank ruled page is what a paper logbook is before anything is written
    // in it. Printing nothing is a worse answer to "print my logbook".
    const plan = planLogbookPrint([]);
    expect(plan.spreads).toHaveLength(1);
    expect(plan.spreads[0].rows.every((r) => r === null)).toBe(true);
    expect(plan.flightCount).toBe(0);
  });

  it('numbers spreads from one', () => {
    expect(planLogbookPrint(scrambled(20)).spreads.map((s) => s.number)).toEqual([1, 2, 3]);
  });
});

describe('order', () => {
  it('reads OLDEST FIRST, the opposite of the list view', () => {
    const dates = planLogbookPrint(scrambled(5)).spreads[0].rows.slice(0, 5).map((r) => r!.date);
    expect(dates).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
    ]);
  });

  it('breaks a same-day tie by off-block', () => {
    const rows = planLogbookPrint([
      flight({ id: 'b', date: '2026-03-01', offBlock: '14:00' }),
      flight({ id: 'a', date: '2026-03-01', offBlock: '09:00' }),
    ]).spreads[0].rows;
    expect(rows.slice(0, 2).map((r) => r!.id)).toEqual(['a', 'b']);
  });

  it('breaks a tie by id when there are no block times at all', () => {
    // Two simulator sessions on one day. Without this the print order would
    // depend on whatever order storage returned, and a logbook that reprints
    // differently each time is not a record of anything.
    const rows = planLogbookPrint([
      session({ id: 'z', date: '2026-03-01' }),
      session({ id: 'a', date: '2026-03-01' }),
    ]).spreads[0].rows;
    expect(rows.slice(0, 2).map((r) => r!.id)).toEqual(['a', 'z']);
  });
});

describe('the running totals', () => {
  it('carries this page into the next page’s brought-forward', () => {
    const plan = planLogbookPrint(scrambled(12));
    const [first, second] = plan.spreads;
    expect(first.totals.broughtForward.totalMinutes).toBe(0);
    expect(first.totals.thisPage.totalMinutes).toBe(8 * 90);
    expect(first.totals.cumulative.totalMinutes).toBe(8 * 90);

    expect(second.totals.broughtForward.totalMinutes).toBe(8 * 90);
    expect(second.totals.thisPage.totalMinutes).toBe(4 * 90);
    expect(second.totals.cumulative.totalMinutes).toBe(12 * 90);
  });

  it('ends on the same figure the whole logbook adds up to', () => {
    const plan = planLogbookPrint(scrambled(19));
    const last = plan.spreads[plan.spreads.length - 1];
    expect(last.totals.cumulative.totalMinutes).toBe(19 * 90);
    expect(last.totals.cumulative.landingsDay).toBe(19);
  });

  it('totals every summable column, not just time', () => {
    const plan = planLogbookPrint([flight({ nightMinutes: 30, landingsNight: 2 })]);
    expect(plan.spreads[0].totals.cumulative.nightMinutes).toBe(30);
    expect(plan.spreads[0].totals.cumulative.landingsNight).toBe(2);
  });
});

describe('the opening balance', () => {
  const balance = { totalMinutes: 600, landingsDay: 40 };

  it('opens the FIRST page as its brought-forward figure', () => {
    const plan = planLogbookPrint(scrambled(2), { openingBalance: balance });
    expect(plan.spreads[0].totals.broughtForward.totalMinutes).toBe(600);
    expect(plan.spreads[0].totals.cumulative.totalMinutes).toBe(600 + 180);
    expect(plan.hasOpeningBalance).toBe(true);
  });

  it('enters exactly ONCE, however many pages there are', () => {
    // The rule that it is an all-time figure, expressed as a page: later pages
    // inherit it through the running total rather than adding it again.
    const plan = planLogbookPrint(scrambled(20), { openingBalance: balance });
    const last = plan.spreads[plan.spreads.length - 1];
    expect(last.totals.cumulative.totalMinutes).toBe(600 + 20 * 90);
    expect(last.totals.cumulative.landingsDay).toBe(40 + 20);
  });

  it('is absent when nothing is carried forward', () => {
    const plan = planLogbookPrint(scrambled(2));
    expect(plan.spreads[0].totals.broughtForward.totalMinutes).toBe(0);
    expect(plan.hasOpeningBalance).toBe(false);
  });

  it('does not treat an all-zero balance as one', () => {
    const plan = planLogbookPrint(scrambled(1), { openingBalance: { totalMinutes: 0 } });
    expect(plan.hasOpeningBalance).toBe(false);
  });
});

describe('simulator sessions', () => {
  it('are printed as rows but add nothing to the flight totals', () => {
    const plan = planLogbookPrint([flight(), session(), flight()]);
    expect(plan.flightCount).toBe(3);
    expect(plan.spreads[0].totals.cumulative.totalMinutes).toBe(180);
  });

  it('total in their own column, with their own running figure', () => {
    const plan = planLogbookPrint([
      ...scrambled(8),
      session({ date: '2026-03-09', simulatorMinutes: 90 }),
    ]);
    expect(plan.spreads[0].simulator.thisPage).toBe(0);
    expect(plan.spreads[1].simulator.broughtForward).toBe(0);
    expect(plan.spreads[1].simulator.thisPage).toBe(90);
    expect(plan.spreads[1].simulator.cumulative).toBe(90);
  });

  it('carry their running total across pages', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      session({ date: `2026-03-${String(i + 1).padStart(2, '0')}`, simulatorMinutes: 60 }),
    );
    const plan = planLogbookPrint(many);
    expect(plan.spreads[0].simulator.cumulative).toBe(480);
    expect(plan.spreads[1].simulator.broughtForward).toBe(480);
    expect(plan.spreads[1].simulator.cumulative).toBe(540);
  });
});

describe('the date range', () => {
  it('prints only what falls inside it, inclusive at both ends', () => {
    const flights = [
      flight({ date: '2026-01-01' }),
      flight({ date: '2026-06-15' }),
      flight({ date: '2026-12-31' }),
    ];
    const plan = planLogbookPrint(flights, { from: '2026-01-01', to: '2026-06-15' });
    expect(plan.flightCount).toBe(2);
    expect(plan.firstDate).toBe('2026-01-01');
    expect(plan.lastDate).toBe('2026-06-15');
  });

  it('prints the whole logbook when unbounded', () => {
    expect(planLogbookPrint(scrambled(5), {}).flightCount).toBe(5);
  });

  it('reports the range actually printed, for the cover', () => {
    const plan = planLogbookPrint(scrambled(5));
    expect(plan.firstDate).toBe('2026-03-01');
    expect(plan.lastDate).toBe('2026-03-05');
  });
});

describe('a ruled duration cell', () => {
  it('splits hours from minutes with no colon', () => {
    expect(splitDuration(98)).toEqual({ hours: '1', minutes: '38' });
  });

  it('zero-pads the minutes', () => {
    expect(splitDuration(65)).toEqual({ hours: '1', minutes: '05' });
  });

  it('does NOT cap hours at 24 — a column holds a career', () => {
    expect(splitDuration(18541 * 60 + 44)).toEqual({ hours: '18541', minutes: '44' });
  });

  it('leaves an empty cell for nothing, rather than printing a zero', () => {
    expect(splitDuration(0)).toEqual({ hours: '', minutes: '' });
    expect(splitDuration(NaN)).toEqual({ hours: '', minutes: '' });
  });
});

describe('a totals cell', () => {
  it('joins with a colon, the way the reference prints a running total', () => {
    expect(joinDuration(18541 * 60 + 44)).toBe('18541:44');
    expect(joinDuration(98)).toBe('1:38');
  });

  it('prints zero as 0:00 — a total of nothing is a fact, not an absence', () => {
    expect(joinDuration(0)).toBe('0:00');
  });

  it('survives rubbish', () => {
    expect(joinDuration(NaN)).toBe('0:00');
    expect(joinDuration(-5)).toBe('0:00');
  });
});

describe('a count cell', () => {
  it('prints a real count and blanks a zero', () => {
    expect(countCell(3)).toBe('3');
    expect(countCell(0)).toBe('');
    expect(countCell(undefined)).toBe('');
  });
});
