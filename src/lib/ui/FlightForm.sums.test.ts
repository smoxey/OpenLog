/**
 * The entry form's "does not fit inside the total" warning.
 *
 * The rule itself is covered exhaustively in `domain/timeSums.test.ts`. What
 * this file covers is the WIRING and the WORDING — and it exists because a
 * click-through found three wording bugs that every one of those unit tests was
 * blind to: the yardstick named as "the simulator", a hardcoded list of four
 * columns on a form showing two of them, and an explanation about PIC and
 * instructor time shown on findings it could not possibly explain.
 *
 * The load-bearing assertions are the two in "the warning never blocks": the new
 * warning is advisory, and the Phase 1 hard caps it sits beside are not.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import FlightForm from './FlightForm.svelte';
import { db } from '../storage/db';
import { listFlights } from '../storage';
import { loadSettings } from '../stores/settings.svelte';

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
  await loadSettings();
});

/**
 * The form reads storage before it renders anything, so every test has to wait
 * for it. Awaiting the Save button is the cheapest proof that `init` finished.
 */
async function setup() {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(FlightForm, { props: { flightId: null, onDone, onCancel } });
  await screen.findByRole('button', { name: 'Save flight' });
  return { onDone, onCancel, user: userEvent.setup() };
}

/** Type into a duration/text input by its registry-derived id. */
async function fill(user: ReturnType<typeof userEvent.setup>, key: string, value: string) {
  const input = document.getElementById(`f-${key}`) as HTMLInputElement;
  expect(input, `no input for ${key}`).toBeTruthy();
  await user.clear(input);
  await user.type(input, value);
  await user.tab();
}

/** The whole warning block, or null when it is not showing. */
function warning(): HTMLElement | null {
  const blocks = Array.from(document.querySelectorAll('.conflict')) as HTMLElement[];
  return blocks.find((b) => /fit inside the/.test(b.textContent ?? '')) ?? null;
}

/**
 * The warning's text with runs of whitespace collapsed.
 *
 * The markup wraps sentences across source lines, so matching raw
 * `textContent` fails on a string that is plainly there — and a `not.toContain`
 * written against raw text passes for the wrong reason, which is worse.
 */
function warningText(): string {
  return (warning()?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Wait for the warning to appear, or to go away.
 *
 * Svelte flushes on a microtask, so reading the DOM synchronously after the
 * last keystroke is a race — one this suite only lost when the whole run was
 * competing for the machine. Waiting is not a workaround for a slow test; it is
 * the correct way to assert on a reactive render.
 */
async function expectWarning(): Promise<void> {
  await vi.waitFor(() => expect(warning()).not.toBeNull());
}

async function expectNoWarning(): Promise<void> {
  await vi.waitFor(() => expect(warning()).toBeNull());
}

describe('a flight', () => {
  it('warns when the function times exceed the total, and says by how much', async () => {
    const { user } = await setup();
    await fill(user, 'totalMinutes', '1.5');
    await fill(user, 'picMinutes', '2.0');

    await expectWarning();
    expect(warningText()).toContain('0.5 more than the total of 1.5');
  });

  it('names the contributing columns from the registry', async () => {
    const { user } = await setup();
    await fill(user, 'totalMinutes', '1.5');
    await fill(user, 'picMinutes', '2.0');

    await expectWarning();
    expect(warningText()).toContain('PIC, Co-Pilot, Dual and Instructor time adds up to');
  });

  it('clears the warning when the entry is corrected', async () => {
    const { user } = await setup();
    await fill(user, 'totalMinutes', '1.5');
    await fill(user, 'picMinutes', '2.0');
    await expectWarning();

    await fill(user, 'picMinutes', '1.5');
    await expectNoWarning();
  });

  it('explains the PIC-and-instructor case on a function-time finding', async () => {
    const { user } = await setup();
    await fill(user, 'totalMinutes', '1.5');
    await fill(user, 'picMinutes', '2.0');

    await expectWarning();
    expect(warningText()).toContain('as both PIC and instructor');
  });

  it('does NOT offer that explanation for an IFR overrun, which it cannot explain', async () => {
    const { user } = await setup();
    await fill(user, 'totalMinutes', '1.5');
    await fill(user, 'ifrMinutes', '3.0');

    await expectWarning();
    expect(warningText()).toContain('IFR time is 3.0');
    expect(warningText()).not.toContain('as both PIC and instructor');
  });

  it('says nothing at all on a form that has barely been started', async () => {
    await setup();
    expect(warning()).toBeNull();
  });
});

describe('a simulator session', () => {
  async function switchToSimulator(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Simulator' }));
  }

  it('measures against session time and says so', async () => {
    const { user } = await setup();
    await switchToSimulator(user);
    await fill(user, 'simulatorMinutes', '2.0');
    await fill(user, 'dualMinutes', '2.0');
    await fill(user, 'instructorMinutes', '2.0');

    await expectWarning();
    expect(warningText()).toContain('session time');
    // "the total" would be wrong here: an FSTD entry's total is always zero.
    expect(warningText()).not.toContain('more than the total');
  });

  it('names only the columns a session actually carries', async () => {
    const { user } = await setup();
    await switchToSimulator(user);
    await fill(user, 'simulatorMinutes', '2.0');
    await fill(user, 'dualMinutes', '2.0');
    await fill(user, 'instructorMinutes', '2.0');

    await expectWarning();
    expect(warningText()).toContain('Dual and Instructor time adds up to');
    expect(warningText()).not.toContain('PIC, Co-Pilot');
  });

  it('does not explain a session with a sentence about a flight', async () => {
    const { user } = await setup();
    await switchToSimulator(user);
    await fill(user, 'simulatorMinutes', '2.0');
    await fill(user, 'dualMinutes', '2.0');
    await fill(user, 'instructorMinutes', '2.0');

    await expectWarning();
    expect(warningText()).not.toContain('as both PIC and instructor');
  });
});

describe('the warning never blocks', () => {
  /*
    PIC alone above the total is NOT the case to test here: `validateFlight`
    has capped `picMinutes` at the total since Phase 1, so that entry is
    refused by a hard rule this step deliberately left alone. The case that
    proves the new warning is advisory is a SUM that overruns while every
    individual column stays inside the total — 1.0 PIC plus 1.0 dual in a
    1.5-hour flight, which nothing in the app blocks.
  */
  it('saves a flight that is showing one', async () => {
    const { user, onDone } = await setup();
    await fill(user, 'date', '2026-07-18');
    await fill(user, 'depAerodrome', 'ENGM');
    await fill(user, 'offBlock', '10:00');
    await fill(user, 'arrAerodrome', 'ENBR');
    await fill(user, 'onBlock', '11:30');
    await fill(user, 'aircraftType', 'C172');
    await fill(user, 'registration', 'LN-ABC');
    await fill(user, 'totalMinutes', '1.5');
    await fill(user, 'picMinutes', '1.0');
    await fill(user, 'dualMinutes', '1.0');

    await expectWarning();
    expect(warningText()).toContain('adds up to 2.0');

    await user.click(screen.getByRole('button', { name: 'Save flight' }));

    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    const stored = await listFlights();
    expect(stored).toHaveLength(1);
    // Saved exactly as typed. The warning advises; it never corrects.
    expect(stored[0]).toMatchObject({ totalMinutes: 90, picMinutes: 60, dualMinutes: 60 });
  });

  it('leaves the Phase 1 hard caps in place — they still refuse a save', async () => {
    /*
      Asserted so the overlap is deliberate rather than discovered later. PIC
      above the total produces BOTH the new advisory warning and the old hard
      error, and the hard error is what stops the save.
    */
    const { user, onDone } = await setup();
    await fill(user, 'date', '2026-07-18');
    await fill(user, 'depAerodrome', 'ENGM');
    await fill(user, 'offBlock', '10:00');
    await fill(user, 'arrAerodrome', 'ENBR');
    await fill(user, 'onBlock', '11:30');
    await fill(user, 'aircraftType', 'C172');
    await fill(user, 'registration', 'LN-ABC');
    await fill(user, 'totalMinutes', '1.5');
    await fill(user, 'picMinutes', '2.0');

    await user.click(screen.getByRole('button', { name: 'Save flight' }));

    await screen.findByText(/cannot exceed/i);
    expect(onDone).not.toHaveBeenCalled();
    expect(await listFlights()).toHaveLength(0);
  });
});
