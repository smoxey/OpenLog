/**
 * The totals view.
 *
 * The arithmetic is covered in `domain/totals.test.ts` and
 * `domain/openingBalance.test.ts`. What this file covers is what the screen
 * SAYS — and in particular the two things a pilot could be misled by:
 *
 *  - that a brought-forward balance appears in the all-time figures and in no
 *    other range, with its own column so it can be accounted for;
 *  - that simulator time never appears as a line of the flight-time table.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import TotalsPanel from './TotalsPanel.svelte';
import { db } from '../storage/db';
import { addFlight, updateSettings, type NewFlightInput } from '../storage';
import { loadSettings } from '../stores/settings.svelte';
import { addDays, localIsoDate } from '../time/blockTime';

const TODAY = localIsoDate(new Date());

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
  await loadSettings();
});

/**
 * A complete, SAVEABLE flight.
 *
 * The time columns follow `totalMinutes` rather than being fixed at 90:
 * `validateFlight` caps PIC at the total, so a helper that varied only the
 * total would quietly save nothing and every figure below would be wrong for a
 * reason that looked like a totals bug.
 */
function input(overrides: Partial<NewFlightInput> = {}): NewFlightInput {
  const total = overrides.totalMinutes ?? 90;
  return {
    date: TODAY,
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '10:00',
    onBlock: '11:30',
    aircraftType: 'C172',
    registration: 'LN-ABC',
    picName: '',
    landingsDay: 1,
    ...overrides,
    totalMinutes: total,
    picMinutes: overrides.picMinutes ?? total,
    singlePilotSeMinutes: overrides.singlePilotSeMinutes ?? total,
  };
}

/** Whitespace-collapsed text of a node, so markup line wrapping cannot fail a match. */
function textOf(selector: string): string {
  return (document.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Assert a flight was actually stored — a silent validation refusal is not a pass. */
async function expectSaved(result: Awaited<ReturnType<typeof addFlight>>) {
  if (!result.ok) throw new Error(`fixture flight refused: ${result.errors[0].message}`);
}

async function setup() {
  const onBack = vi.fn();
  const onSettings = vi.fn();
  render(TotalsPanel, { props: { onBack, onSettings } });
  return { onBack, onSettings, user: userEvent.setup() };
}

/** The figure shown for a row of the main table, in its last (Total) column. */
function figureFor(label: string): string {
  const rows = Array.from(document.querySelectorAll('table.figures tbody tr'));
  const row = rows.find((r) => r.querySelector('th')?.textContent?.trim() === label);
  if (!row) throw new Error(`no row labelled "${label}"`);
  const cells = row.querySelectorAll('td');
  return cells[cells.length - 1].textContent?.trim() ?? '';
}

/** Every cell of a row, so a three-column breakdown can be read whole. */
function rowCells(label: string): string[] {
  const rows = Array.from(document.querySelectorAll('table.figures tbody tr'));
  const row = rows.find((r) => r.querySelector('th')?.textContent?.trim() === label);
  if (!row) throw new Error(`no row labelled "${label}"`);
  return Array.from(row.querySelectorAll('td')).map((c) => c.textContent?.trim() ?? '');
}

async function chooseRange(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('button', { name: label }));
}

describe('an empty logbook', () => {
  it('offers the way to enter a previous logbook rather than a wall of zeros', async () => {
    const { user, onSettings } = await setup();
    await screen.findByText(/No flights logged yet/i);

    await user.click(screen.getByRole('button', { name: /Add a previous logbook total/i }));
    expect(onSettings).toHaveBeenCalled();
  });
});

describe('the ranges', () => {
  beforeEach(async () => {
    await expectSaved(await addFlight(input({ date: TODAY, totalMinutes: 90 })));
    await expectSaved(await addFlight(input({ date: addDays(TODAY, -200), totalMinutes: 60 })));
  });

  it('shows the whole logbook on all time', async () => {
    await setup();
    await screen.findByRole('button', { name: 'All time' });
    expect(figureFor('Total')).toBe('2.5');
  });

  it('narrows to the last 90 days', async () => {
    const { user } = await setup();
    await screen.findByRole('button', { name: 'Last 90 days' });
    await chooseRange(user, 'Last 90 days');
    expect(figureFor('Total')).toBe('1.5');
  });

  it('says which window it is showing', async () => {
    const { user } = await setup();
    await screen.findByRole('button', { name: 'Last 28 days' });
    await chooseRange(user, 'Last 28 days');
    expect(screen.getByText(new RegExp(addDays(TODAY, -28)))).toBeInTheDocument();
  });
});

describe('a brought-forward balance', () => {
  beforeEach(async () => {
    await expectSaved(await addFlight(input({ date: TODAY, totalMinutes: 90 })));
    await updateSettings({ openingBalance: { totalMinutes: 600, landingsDay: 40 } });
    await loadSettings();
  });

  it('is broken out into its own column on all time', async () => {
    await setup();
    await screen.findByRole('button', { name: 'All time' });
    // Brought forward, this logbook, total.
    expect(rowCells('Total')).toEqual(['10.0', '1.5', '11.5']);
  });

  it('carries landings forward too', async () => {
    await setup();
    await screen.findByRole('button', { name: 'All time' });
    expect(rowCells('Ldg Day')).toEqual(['40', '1', '41']);
  });

  it('is ABSENT from a date range, and says why', async () => {
    const { user } = await setup();
    await screen.findByRole('button', { name: 'Last 90 days' });
    await chooseRange(user, 'Last 90 days');

    expect(figureFor('Total')).toBe('1.5');
    expect(rowCells('Total')).toHaveLength(1);
    expect(screen.getByText(/Brought-forward hours have no\s+dates/i)).toBeInTheDocument();
  });
});

describe('simulator time', () => {
  beforeEach(async () => {
    await expectSaved(await addFlight(input({ date: TODAY, totalMinutes: 90 })));
    await addFlight({
      entryType: 'fstd',
      date: TODAY,
      depAerodrome: 'SIM',
      arrAerodrome: 'SIM',
      offBlock: '',
      onBlock: '',
      aircraftType: 'FNPT2',
      registration: '',
      picName: '',
      totalMinutes: 0,
      simulatorMinutes: 120,
      simulatorRegistration: 'EU-DK187',
    });
  });

  it('is reported in its own block, outside the flight-time table', async () => {
    await setup();
    await screen.findByRole('heading', { name: 'Simulator' });
    expect(textOf('.sim')).toContain('2.0');
    expect(textOf('.sim')).toMatch(/1 session/);
  });

  it('leaves every flight figure untouched', async () => {
    await setup();
    await screen.findByRole('heading', { name: 'Simulator' });
    expect(figureFor('Total')).toBe('1.5');
  });

  it('says out loud that it counts toward nothing', async () => {
    await setup();
    await screen.findByRole('heading', { name: 'Simulator' });
    expect(textOf('.sim')).toMatch(/never flight time/i);
  });

  it('is not counted as a flight', async () => {
    await setup();
    await screen.findByRole('heading', { name: 'Simulator' });
    expect(screen.getByText(/^1 flight/)).toBeInTheDocument();
  });
});

describe('the breakdowns', () => {
  beforeEach(async () => {
    await expectSaved(
      await addFlight(input({ aircraftType: 'C172', registration: 'LN-ABC', totalMinutes: 90 })),
    );
    await expectSaved(
      await addFlight(input({ aircraftType: 'PA28', registration: 'LN-XYZ', totalMinutes: 60 })),
    );
  });

  it('lists aircraft types, heaviest first, once opened', async () => {
    const { user } = await setup();
    await screen.findByText('By aircraft type');
    await user.click(screen.getByText('By aircraft type'));

    const types = Array.from(document.querySelectorAll('.breakdown table tbody th')).map((el) =>
      el.textContent?.trim(),
    );
    expect(types).toEqual(['C172', 'PA28']);
  });

  it('lists registrations once opened', async () => {
    const { user } = await setup();
    await screen.findByText('By registration');
    await user.click(screen.getByText('By registration'));

    const regs = Array.from(document.querySelectorAll('.breakdown table tbody th')).map((el) =>
      el.textContent?.trim(),
    );
    expect(regs).toEqual(['LN-ABC', 'LN-XYZ']);
  });
});

describe('currency on screen', () => {
  /** The currency block's text, whitespace collapsed. */
  function currencyText(): string {
    return textOf('.currency');
  }

  it('reports not-current when there is nothing in the window', async () => {
    await expectSaved(await addFlight(input({ date: addDays(TODAY, -200) })));
    await setup();
    await screen.findByRole('heading', { name: /Passenger-carrying currency/i });
    expect(currencyText()).toMatch(/No landings in the last 90 days/i);
  });

  it('reports current, with the date it runs until', async () => {
    for (const days of [0, 5, 10]) {
      await expectSaved(await addFlight(input({ date: addDays(TODAY, -days) })));
    }
    await setup();
    await screen.findByRole('heading', { name: /Passenger-carrying currency/i });
    expect(currencyText()).toContain('Single-engine');
    expect(currencyText()).toMatch(/Current/);
    // Ten days ago supplied the third landing, so currency runs 90 days from then.
    expect(currencyText()).toContain(addDays(addDays(TODAY, -10), 90));
  });

  it('says how many more landings are needed', async () => {
    await expectSaved(await addFlight(input({ date: TODAY })));
    await setup();
    await screen.findByRole('heading', { name: /Passenger-carrying currency/i });
    expect(currencyText()).toMatch(/Not current/);
    expect(currencyText()).toMatch(/1 of 3/);
    expect(currencyText()).toMatch(/2 more needed/);
  });

  it('carries the disclaimer, and names the take-off assumption', async () => {
    await expectSaved(await addFlight(input({ date: TODAY })));
    await setup();
    await screen.findByRole('heading', { name: /Passenger-carrying currency/i });
    const text = currencyText();
    expect(text).toContain('FCL.060(b)(1)');
    expect(text).toMatch(/Take-offs are counted from your landings/i);
    expect(text).toMatch(/you remain responsible for your own currency/i);
  });

  it('is NOT changed by the range selector', async () => {
    // Currency is a 90-day rule. A selector that moved it would produce
    // something that looks like a currency and is not one.
    for (const days of [0, 5, 10]) {
      await expectSaved(await addFlight(input({ date: addDays(TODAY, -days) })));
    }
    const { user } = await setup();
    await screen.findByRole('button', { name: 'Last 28 days' });
    const before = currencyText();
    await chooseRange(user, 'Last 28 days');
    expect(currencyText()).toBe(before);
  });

  it('says when simulator sessions were set aside', async () => {
    await expectSaved(await addFlight(input({ date: TODAY })));
    await addFlight({
      entryType: 'fstd',
      date: TODAY,
      depAerodrome: 'SIM',
      arrAerodrome: 'SIM',
      offBlock: '',
      onBlock: '',
      aircraftType: 'FNPT2',
      registration: '',
      picName: '',
      totalMinutes: 0,
      simulatorMinutes: 120,
    });
    await setup();
    await screen.findByRole('heading', { name: /Passenger-carrying currency/i });
    expect(currencyText()).toMatch(/Simulator landings do not satisfy the rule/i);
  });
});
