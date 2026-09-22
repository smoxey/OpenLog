/**
 * The toolbox's night-time card, on screen.
 *
 * The planning is covered in `domain/bulkNight.test.ts` and the writing in
 * `storage/bulkNight.test.ts`. What this file covers is what the SCREEN says
 * and does — the Phase 4 lesson again: a tool can be right in the domain and
 * still lie on the page, and this one rewrites a logbook with no undo.
 *
 * The four things worth holding still:
 *
 *  - the pilot sees WHAT IT SAYS NOW beside WHAT IT WOULD BECOME, per flight,
 *    before anything can be applied;
 *  - every flight can be individually refused, and refusing keeps the logged
 *    figure exactly as it was;
 *  - Apply asks first, and Cancel leaves the logbook alone;
 *  - flights it cannot work out are reported, never silently dropped.
 *
 * These use the real airport list, because the card does: the aerodromes below
 * are real places and the night figures are the ones the sun actually gives.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ToolboxPanel from './ToolboxPanel.svelte';
import { db } from '../storage/db';
import { addFlight, getAllFlights, type NewFlightInput } from '../storage';
import { loadSettings } from '../stores/settings.svelte';
import { loadAirports } from '../airports/lookup';

/**
 * Pull the airport chunk in ONCE, before any test asserts on the card.
 *
 * `ToolboxPanel` fires `loadAirports()` without awaiting, and the night card
 * does not render until it lands. That import is a 594 kB dynamic `import()`
 * which, under a full parallel run, can take longer than the **one-second**
 * default `vi.waitFor` and `findBy*` allow — a budget `testTimeout` does not
 * govern. Warming it here pays the import once, outside anyone's timeout.
 *
 * The same guard sits in `FlightForm.night.test.ts` and
 * `FlightForm.landings.test.ts`, for the same reason.
 */
beforeAll(async () => {
  await loadAirports();
});

/** A Norwegian January evening: dark from off-block to on-block. */
function input(overrides: Partial<NewFlightInput> = {}): NewFlightInput {
  return {
    date: '2026-01-15',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '20:00',
    onBlock: '21:00',
    aircraftType: 'A320',
    registration: 'LN-ABC',
    picName: '',
    totalMinutes: 60,
    ...overrides,
  } as NewFlightInput;
}

const noop = () => {};

function text(node: HTMLElement): string {
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The night card's own summary region, so the other tool's cannot be read by mistake. */
const summary = () => screen.findByRole('status', { name: 'Night time summary' });

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
  await loadSettings();
});

function open() {
  render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
  return userEvent.setup();
}

describe('what the card offers', () => {
  it('counts the flights it would change before anything can be applied', async () => {
    await addFlight(input());
    await addFlight(input({ date: '2026-01-16' }));
    open();

    expect(text(await summary())).toMatch(/2\s*flights will change/);
  });

  it('shows each flight with what it says now beside what it would become', async () => {
    await addFlight(input());
    open();

    const row = await screen.findByRole('checkbox', { name: /2026-01-15 ENGM–ENBR/ });
    // The whole hour was dark, so a flight logging no night becomes 1.0.
    expect(text(row.closest('li') as HTMLElement)).toMatch(/0\.0\s*→\s*1\.0/);
  });

  it('says plainly that the landing columns are not touched', async () => {
    await addFlight(input());
    open();

    // Wait for the airport chunk to land — until it does the card says so and
    // renders none of its own copy.
    await summary();
    const card = (await screen.findByRole('heading', { name: 'Work out night time' }))
      .closest('section') as HTMLElement;
    expect(text(card)).toMatch(/landing columns are not touched/i);
  });
});

describe('keeping what was logged', () => {
  it('never offers a flight that already has a night figure, by default', async () => {
    await addFlight(input({ nightMinutes: 42 }));
    open();

    expect(text(await summary())).toMatch(/already has a night figure/i);
  });

  it('offers it under "All flights", and warns that it would be replaced', async () => {
    await addFlight(input({ nightMinutes: 42 }));
    const user = open();

    await user.click(await screen.findByRole('button', { name: 'All flights' }));

    const region = await summary();
    expect(text(region)).toMatch(/1\s*flight will change/);
    expect(text(region)).toMatch(/would be replaced/i);
  });

  it('leaves an unticked flight exactly as it was, and changes the rest', async () => {
    await addFlight(input({ registration: 'LN-KEEP' }));
    await addFlight(input({ date: '2026-01-16', registration: 'LN-CHANGE' }));
    const user = open();

    await user.click(await screen.findByRole('checkbox', { name: /2026-01-15/ }));
    await user.click(await screen.findByRole('button', { name: 'Apply night time' }));
    await user.click(await screen.findByRole('button', { name: 'Write them' }));

    await screen.findByText(/Night time written to 1 flight\./);
    const flights = await getAllFlights();
    expect(flights.find((f) => f.registration === 'LN-KEEP')?.nightMinutes).toBe(0);
    expect(flights.find((f) => f.registration === 'LN-CHANGE')?.nightMinutes).toBe(60);
  });

  it('keeps an unticked flight on screen so it can be ticked back on', async () => {
    await addFlight(input());
    const user = open();

    const tick = await screen.findByRole('checkbox', { name: /2026-01-15/ });
    await user.click(tick);

    expect(text(await summary())).toMatch(/Nothing will change/);
    // Still there, and still tickable — the list is the way back.
    const again = await screen.findByRole('checkbox', { name: /2026-01-15/ });
    expect(again).not.toBeChecked();
    await user.click(again);
    expect(text(await summary())).toMatch(/1\s*flight will change/);
  });

  it('will not run once everything is unticked', async () => {
    await addFlight(input());
    const user = open();

    await user.click(await screen.findByRole('checkbox', { name: /2026-01-15/ }));

    expect(screen.getByRole('button', { name: 'Apply night time' })).toBeDisabled();
  });
});

describe('before it writes', () => {
  it('asks first, and Cancel leaves the logbook alone', async () => {
    await addFlight(input());
    const user = open();

    await user.click(await screen.findByRole('button', { name: 'Apply night time' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm night time' });
    expect(text(dialog)).toMatch(/no undo/i);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect((await getAllFlights())[0].nightMinutes).toBe(0);
  });

  it('writes only once confirmed, and reports how many changed', async () => {
    await addFlight(input());
    const user = open();

    await user.click(await screen.findByRole('button', { name: 'Apply night time' }));
    await user.click(await screen.findByRole('button', { name: 'Write them' }));

    await screen.findByText(/Night time written to 1 flight\./);
    expect((await getAllFlights())[0].nightMinutes).toBe(60);
  });

  it('does not touch the landing columns', async () => {
    await addFlight(input({ landingsDay: 1, landingsNight: 0 }));
    const user = open();

    await user.click(await screen.findByRole('button', { name: 'Apply night time' }));
    await user.click(await screen.findByRole('button', { name: 'Write them' }));
    await screen.findByText(/Night time written to 1 flight\./);

    const [flight] = await getAllFlights();
    expect(flight.landingsDay).toBe(1);
    expect(flight.landingsNight).toBe(0);
  });
});

describe('what it cannot work out', () => {
  it('reports the flights it left out and names the aerodrome it lacks', async () => {
    await addFlight(input());
    await addFlight(input({ date: '2026-01-16', arrAerodrome: 'ZZZZ' }));
    open();

    const region = await summary();
    expect(text(region)).toMatch(/1 flight was left out/i);
    expect(text(region)).toMatch(/ZZZZ/);
  });

  it('still changes the flights it can', async () => {
    await addFlight(input({ registration: 'LN-OK' }));
    await addFlight(input({ date: '2026-01-16', arrAerodrome: 'ZZZZ', registration: 'LN-NO' }));
    const user = open();

    await user.click(await screen.findByRole('button', { name: 'Apply night time' }));
    await user.click(await screen.findByRole('button', { name: 'Write them' }));
    await screen.findByText(/Night time written to 1 flight\./);

    const flights = await getAllFlights();
    expect(flights.find((f) => f.registration === 'LN-OK')?.nightMinutes).toBe(60);
    expect(flights.find((f) => f.registration === 'LN-NO')?.nightMinutes).toBe(0);
  });
});
