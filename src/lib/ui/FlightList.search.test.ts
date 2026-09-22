/**
 * Search and filter on the list screen.
 *
 * The matching rules are covered in `domain/filter.test.ts`. What this file
 * covers is the wiring, and one thing that matters more than any of it: a
 * filter that matches nothing must never look like a logbook that has lost its
 * flights.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import FlightList from './FlightList.svelte';
import { db } from '../storage/db';
import { addFlight, type NewFlightInput } from '../storage';
import { loadSettings, setShowSimulatorEntries } from '../stores/settings.svelte';

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
  await loadSettings();
});

function input(overrides: Partial<NewFlightInput> = {}): NewFlightInput {
  const total = overrides.totalMinutes ?? 90;
  return {
    date: '2026-07-18',
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

/** Enough flights that the search bar is offered at all. */
async function seed(extra: Partial<NewFlightInput>[] = []) {
  for (let i = 0; i < 6; i += 1) {
    const day = String(i + 1).padStart(2, '0');
    const result = await addFlight(
      input({ date: `2026-03-${day}`, offBlock: '10:00', onBlock: '11:30' }),
    );
    if (!result.ok) throw new Error(result.errors[0].message);
  }
  for (const overrides of extra) {
    const result = await addFlight(input(overrides));
    if (!result.ok) throw new Error(result.errors[0].message);
  }
}

async function setup() {
  const props = {
    onAdd: vi.fn(),
    onEdit: vi.fn(),
    onSettings: vi.fn(),
    onExport: vi.fn(),
    onTotals: vi.fn(),
    onTools: vi.fn(),
    onCount: vi.fn(),
  };
  render(FlightList, { props });
  await screen.findByLabelText('Search flights');
  return { ...props, user: userEvent.setup() };
}

/** How many entry rows the list is rendering. */
function rowCount(): number {
  const table = document.querySelectorAll('table.logbook tbody tr').length;
  return table > 0 ? table : document.querySelectorAll('ul li').length;
}

describe('the search bar', () => {
  it('is not offered for a handful of flights', async () => {
    await addFlight(input());
    render(FlightList, {
      props: {
        onAdd: vi.fn(),
        onEdit: vi.fn(),
        onSettings: vi.fn(),
        onExport: vi.fn(),
        onTotals: vi.fn(),
        onTools: vi.fn(),
        onCount: vi.fn(),
      },
    });
    await screen.findByText(/1 entry/);
    expect(screen.queryByLabelText('Search flights')).toBeNull();
  });

  it('narrows the list as text is typed', async () => {
    await seed([{ date: '2026-04-01', remarks: 'ILS 01 to minimums' }]);
    const { user } = await setup();
    const before = rowCount();

    await user.type(screen.getByLabelText('Search flights'), 'ILS');
    expect(rowCount()).toBe(1);
    expect(rowCount()).toBeLessThan(before);
  });

  it('always says how many of how many are showing', async () => {
    await seed([{ date: '2026-04-01', remarks: 'ILS 01 to minimums' }]);
    const { user } = await setup();
    await user.type(screen.getByLabelText('Search flights'), 'ILS');
    expect(screen.getByText(/Showing 1 of 7 entries/)).toBeInTheDocument();
  });

  it('restores the whole list when the filter is cleared', async () => {
    await seed([{ date: '2026-04-01', remarks: 'ILS 01 to minimums' }]);
    const { user } = await setup();
    const before = rowCount();

    await user.type(screen.getByLabelText('Search flights'), 'ILS');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(rowCount()).toBe(before);
  });
});

describe('a filter that matches nothing', () => {
  it('does not look like data loss', async () => {
    await seed();
    const { user } = await setup();
    await user.type(screen.getByLabelText('Search flights'), 'zzzzzz');

    expect(screen.getByText('No matches')).toBeInTheDocument();
    // The reassurance is the point: the flights are still there.
    expect(screen.getByText(/6 entries are still in the logbook/)).toBeInTheDocument();
    expect(screen.queryByText('No flights yet')).toBeNull();
  });

  it('offers a way straight back out', async () => {
    await seed();
    const { user } = await setup();
    await user.type(screen.getByLabelText('Search flights'), 'zzzzzz');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.queryByText('No matches')).toBeNull();
  });
});

describe('the structured filters', () => {
  it('compose with the free text', async () => {
    await seed([
      { date: '2026-04-01', aircraftType: 'PA28', remarks: 'ILS 01' },
      { date: '2026-04-02', aircraftType: 'C172', remarks: 'ILS 01' },
    ]);
    const { user } = await setup();

    await user.type(screen.getByLabelText('Search flights'), 'ILS');
    expect(rowCount()).toBe(2);

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.type(screen.getByLabelText('Type'), 'PA28');
    expect(rowCount()).toBe(1);
  });

  it('filters by date range', async () => {
    await seed();
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Filters' }));

    const from = screen.getByLabelText('From') as HTMLInputElement;
    await user.type(from, '2026-03-04');
    expect(rowCount()).toBe(3);
  });
});

describe('the simulator toggle and the filter', () => {
  it('a hidden simulator entry stays hidden while filtering', async () => {
    await seed();
    await addFlight({
      entryType: 'fstd',
      date: '2026-04-01',
      depAerodrome: 'SIM',
      arrAerodrome: 'SIM',
      offBlock: '',
      onBlock: '',
      aircraftType: 'FNPT2',
      registration: '',
      picName: '',
      totalMinutes: 0,
      simulatorMinutes: 120,
      remarks: 'ILS practice',
    });
    await setShowSimulatorEntries(false);

    const { user } = await setup();
    await user.type(screen.getByLabelText('Search flights'), 'ILS');

    // The session matches the text but is hidden by the display preference,
    // which the filter runs on top of rather than replacing.
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('finds it once simulator entries are shown', async () => {
    await seed();
    await addFlight({
      entryType: 'fstd',
      date: '2026-04-01',
      depAerodrome: 'SIM',
      arrAerodrome: 'SIM',
      offBlock: '',
      onBlock: '',
      aircraftType: 'FNPT2',
      registration: '',
      picName: '',
      totalMinutes: 0,
      simulatorMinutes: 120,
      remarks: 'ILS practice',
    });

    const { user } = await setup();
    await user.type(screen.getByLabelText('Search flights'), 'ILS');
    expect(rowCount()).toBe(1);
  });
});
