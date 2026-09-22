/**
 * The entry form's automatic night time.
 *
 * The calculation itself is covered in `night/night.test.ts` and the decision
 * about what to suggest in `night/suggest.test.ts`. What this file covers is
 * the WIRING and the WORDING — which is where Phase 4 found three bugs that
 * seven hundred passing unit tests were blind to, because none of them were
 * wrong in the domain, only on the screen.
 *
 * The load-bearing assertions are the two about not overwriting: a value the
 * pilot typed, and a value they saved earlier, are theirs.
 *
 * These run against the real generated airport list, so they use aerodromes the
 * committed seed guarantees (ENGM, EGLL) and an unknown code that no list will
 * ever contain.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import FlightForm from './FlightForm.svelte';
import { db } from '../storage/db';
import { addFlight, listFlights } from '../storage';
import { loadSettings } from '../stores/settings.svelte';
import { updateSettings } from '../storage/settings';
import { loadAirports } from '../airports/lookup';

/**
 * Pull the airport chunk in ONCE, before any test asserts on a night figure.
 *
 * `loadAirports()` is a dynamic `import()` of a 594 kB chunk, cached for the
 * life of the module. `FlightForm` fires it without awaiting — deliberately, so
 * the form opens at once — which means the night suggestion appears only after
 * it lands. Under a full parallel run that import can take well over a second,
 * and `vi.waitFor` defaults to a **one-second** budget that `testTimeout` does
 * not govern. The result was a genuinely correct test failing on a busy machine
 * roughly one full run in four.
 *
 * Warming it here pays the import once, outside anyone's timeout, and leaves
 * every `waitFor` below waiting on the render it is actually about.
 */
beforeAll(async () => {
  await loadAirports();
});

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
  await loadSettings();
});

async function setup(flightId: string | null = null) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(FlightForm, { props: { flightId, onDone, onCancel } });
  // "Save flight" is inside the `{#if ready}` block — the header's own "Save"
  // renders before `init` has finished, so waiting for that one races the load.
  await screen.findByRole('button', { name: 'Save flight' });
  const user = userEvent.setup();
  // Night lives behind the "More" disclosure, per the 15-second entry rule.
  const more = document.querySelector('.more summary') as HTMLElement | null;
  if (more) await user.click(more);
  return { onDone, onCancel, user };
}

async function fill(user: ReturnType<typeof userEvent.setup>, key: string, value: string) {
  const input = document.getElementById(`f-${key}`) as HTMLInputElement;
  expect(input, `no input for ${key}`).toBeTruthy();
  await user.clear(input);
  await user.type(input, value);
  await user.tab();
}

function valueOf(key: string): string {
  return (document.getElementById(`f-${key}`) as HTMLInputElement | null)?.value ?? '';
}

/** The whole night field cell, whitespace collapsed. */
function nightCellText(): string {
  const input = document.getElementById('f-nightMinutes');
  const cell = input?.closest('.form-field');
  return (cell?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * A midwinter evening sector out of Oslo: takes off in daylight, lands at
 * Heathrow in the dark. About 1.3 hours of night in a 2.0 hour block.
 */
async function enterEveningSector(user: ReturnType<typeof userEvent.setup>) {
  await fill(user, 'date', '2026-12-21');
  await fill(user, 'depAerodrome', 'ENGM');
  await fill(user, 'arrAerodrome', 'EGLL');
  await fill(user, 'offBlock', '15:00');
  await fill(user, 'onBlock', '17:00');
}

describe('working night time out by itself', () => {
  it('fills the night field in once the route and the times are there', async () => {
    const { user } = await setup();
    expect(valueOf('nightMinutes')).toBe('0.0');

    await enterEveningSector(user);

    await vi.waitFor(() => expect(valueOf('nightMinutes')).toBe('1.3'));
  });

  it('says what it concluded about the two ends of the flight', async () => {
    // The part the pilot can check against their own memory: a night landing
    // is a thing you remember. The sea-level caveat is an assumption the app
    // made and the pilot did not, so it is stated.
    const { user } = await setup();
    await enterEveningSector(user);

    await vi.waitFor(() => expect(nightCellText()).toContain('take-off day, landing night'));
    expect(nightCellText()).toContain('sea level');
  });

  it('moves the landing into the night column when the arrival is in the dark', async () => {
    const { user } = await setup();
    expect(valueOf('landingsDay')).toBe('1');

    await enterEveningSector(user);

    await vi.waitFor(() => expect(valueOf('landingsNight')).toBe('1'));
    expect(valueOf('landingsDay')).toBe('0');
  });

  it('moves it back when the flight turns out to be in daylight after all', async () => {
    const { user } = await setup();
    await enterEveningSector(user);
    await vi.waitFor(() => expect(valueOf('landingsNight')).toBe('1'));

    // Same sector six months later: broad daylight at both ends.
    await fill(user, 'date', '2026-06-21');

    await vi.waitFor(() => expect(valueOf('landingsDay')).toBe('1'));
    expect(valueOf('landingsNight')).toBe('0');
    expect(valueOf('nightMinutes')).toBe('0.0');
  });

  it('suggests nothing at all until it has everything it needs', async () => {
    const { user } = await setup();
    await fill(user, 'date', '2026-12-21');
    await fill(user, 'depAerodrome', 'ENGM');
    await fill(user, 'offBlock', '15:00');

    // No arrival aerodrome, no on-block: nothing to say, and nothing said.
    expect(valueOf('nightMinutes')).toBe('0.0');
    expect(nightCellText()).not.toContain('airport list');
  });
});

describe('when it cannot work it out', () => {
  it('names the aerodrome it does not have, rather than quietly logging zero', async () => {
    const { user } = await setup();
    await fill(user, 'date', '2026-12-21');
    await fill(user, 'depAerodrome', 'ENGM');
    await fill(user, 'arrAerodrome', 'ZZZZ');
    await fill(user, 'offBlock', '15:00');
    await fill(user, 'onBlock', '17:00');

    await vi.waitFor(() => expect(nightCellText()).toContain('ZZZZ'));
    expect(nightCellText()).toContain('not in the airport list');
    expect(valueOf('nightMinutes')).toBe('0.0');
  });

  it('withdraws a figure whose route has changed under it', async () => {
    // Found in a browser, invisible to every test in this file until it was
    // written: type a route that works, then change an aerodrome to one with
    // no coordinates. The night field kept the figure worked out for the OLD
    // route, and the explanation stayed hidden behind the suggestion hint —
    // so the form showed a calculated-looking number for a flight it no
    // longer described.
    const { user } = await setup();
    await enterEveningSector(user);
    await vi.waitFor(() => expect(valueOf('nightMinutes')).toBe('1.3'));
    expect(valueOf('landingsNight')).toBe('1');

    await fill(user, 'arrAerodrome', 'ZZZZ');

    await vi.waitFor(() => expect(valueOf('nightMinutes')).toBe('0.0'));
    expect(nightCellText()).toContain('not in the airport list');
    // The landing goes back where the form put it, too.
    expect(valueOf('landingsDay')).toBe('1');
    expect(valueOf('landingsNight')).toBe('0');
  });

  it('works it out again when the route becomes known again', async () => {
    const { user } = await setup();
    await enterEveningSector(user);
    await vi.waitFor(() => expect(valueOf('nightMinutes')).toBe('1.3'));

    await fill(user, 'arrAerodrome', 'ZZZZ');
    await vi.waitFor(() => expect(valueOf('nightMinutes')).toBe('0.0'));

    await fill(user, 'arrAerodrome', 'EGLL');
    await vi.waitFor(() => expect(valueOf('nightMinutes')).toBe('1.3'));
  });

  it('disables the button and says why, rather than failing silently when pressed', async () => {
    const { user } = await setup();
    await fill(user, 'depAerodrome', 'ENGM');
    await fill(user, 'arrAerodrome', 'ZZZZ');
    await fill(user, 'offBlock', '15:00');
    await fill(user, 'onBlock', '17:00');

    const button = screen.getByRole('button', { name: 'Work out night time' });
    await vi.waitFor(() => expect(button).toBeDisabled());
    expect(button.getAttribute('title')).toContain('ZZZZ');
  });
});

describe('what it will not overwrite', () => {
  it('leaves a figure the pilot typed alone, even when it disagrees', async () => {
    const { user } = await setup();
    await fill(user, 'date', '2026-12-21');
    await fill(user, 'depAerodrome', 'ENGM');
    await fill(user, 'offBlock', '15:00');
    await fill(user, 'nightMinutes', '0.5');
    // Completing the route would otherwise produce 1.3.
    await fill(user, 'arrAerodrome', 'EGLL');
    await fill(user, 'onBlock', '17:00');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(valueOf('nightMinutes')).toBe('0.5');
  });

  it('leaves the landing columns alone once the pilot has set them', async () => {
    const { user } = await setup();
    await fill(user, 'landingsDay', '3');
    await enterEveningSector(user);

    await vi.waitFor(() => expect(valueOf('nightMinutes')).toBe('1.3'));
    expect(valueOf('landingsDay')).toBe('3');
    expect(valueOf('landingsNight')).toBe('0');
  });

  it('never rewrites a flight that was saved earlier', async () => {
    // Opening a saved entry to fix a remark must not quietly restate what the
    // pilot logged about the flight itself.
    const saved = await addFlight({
      date: '2026-12-21',
      depAerodrome: 'ENGM',
      arrAerodrome: 'EGLL',
      offBlock: '15:00',
      onBlock: '17:00',
      aircraftType: 'A320',
      registration: 'LN-ABC',
      totalMinutes: 120,
      nightMinutes: 0,
      landingsDay: 1,
      landingsNight: 0,
    } as never);
    expect(saved.ok).toBe(true);

    const [flight] = await listFlights();
    await setup(flight.id);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(valueOf('nightMinutes')).toBe('0.0');
    expect(valueOf('landingsDay')).toBe('1');
  });
});

describe('asking for it on purpose', () => {
  it('fills the field when the button is pressed', async () => {
    await updateSettings({ autoNight: false });
    await loadSettings();

    const { user } = await setup();
    await enterEveningSector(user);

    // Nothing offered, because the setting is off.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(valueOf('nightMinutes')).toBe('0.0');

    await user.click(screen.getByRole('button', { name: 'Work out night time' }));
    await vi.waitFor(() => expect(valueOf('nightMinutes')).toBe('1.3'));
  });

  it('takes a field the pilot had typed back under the calculation', async () => {
    const { user } = await setup();
    await enterEveningSector(user);
    await vi.waitFor(() => expect(valueOf('nightMinutes')).toBe('1.3'));

    await fill(user, 'nightMinutes', '0.5');
    await user.click(screen.getByRole('button', { name: 'Work out night time' }));
    await vi.waitFor(() => expect(valueOf('nightMinutes')).toBe('1.3'));

    // …and it stays maintained: correcting a block time updates it again.
    // An hour longer over the same route is more than an hour more night — the
    // aircraft now spends longer in the east, where it is already dark.
    await fill(user, 'onBlock', '18:00');
    await vi.waitFor(() => expect(valueOf('nightMinutes')).toBe('2.7'));
  });
});

describe('a simulator session', () => {
  it('is not offered night time at all', async () => {
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: /simulator/i }));

    expect(document.getElementById('f-nightMinutes')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Work out night time' })).toBeNull();
  });
});

describe('keeping what was logged, or taking what the route says', () => {
  /**
   * A saved evening sector out of Oslo logging one hour of night, where the
   * route and the clock say 1.3. That disagreement is the whole point of these
   * tests: it is the shape a real import arrives in, where the night
   * column came from another tool that reads twilight differently.
   */
  async function savedSectorLogging(nightMinutes: number) {
    const saved = await addFlight({
      date: '2026-12-21',
      depAerodrome: 'ENGM',
      arrAerodrome: 'EGLL',
      offBlock: '15:00',
      onBlock: '17:00',
      aircraftType: 'A320',
      registration: 'LN-ABC',
      totalMinutes: 120,
      nightMinutes,
      landingsDay: 1,
      landingsNight: 0,
    } as never);
    expect(saved.ok).toBe(true);
    const [flight] = await listFlights();
    return setup(flight.id);
  }

  const offer = () => screen.queryByRole('button', { name: /^(Use|Keep) / });

  it('offers the calculated figure beside the one that was logged', async () => {
    await savedSectorLogging(60);

    const button = await screen.findByRole('button', { name: /Use 1\.3 from the route/ });
    // The field still holds what the pilot logged — the offer is an offer.
    expect(valueOf('nightMinutes')).toBe('1.0');
    expect(button).toBeTruthy();
    // …and it says what the calculation was based on, not just a bare number.
    expect(nightCellText()).toContain('take-off day, landing night');
  });

  it('takes the calculated figure when the pilot asks for it', async () => {
    const { user } = await savedSectorLogging(60);

    await user.click(await screen.findByRole('button', { name: /Use 1\.3 from the route/ }));

    expect(valueOf('nightMinutes')).toBe('1.3');
  });

  it('then offers the logged figure back, so the choice is reversible', async () => {
    const { user } = await savedSectorLogging(60);

    await user.click(await screen.findByRole('button', { name: /Use 1\.3 from the route/ }));
    const back = await screen.findByRole('button', { name: /Keep the 1\.0 you logged/ });
    await user.click(back);

    expect(valueOf('nightMinutes')).toBe('1.0');
  });

  it('does not work it out again after the logged figure is restored', async () => {
    // Choosing their own number IS touching the field. Nudging a block time
    // afterwards must not quietly overwrite the choice they just made.
    const { user } = await savedSectorLogging(60);

    await user.click(await screen.findByRole('button', { name: /Use 1\.3 from the route/ }));
    await user.click(await screen.findByRole('button', { name: /Keep the 1\.0 you logged/ }));
    await fill(user, 'onBlock', '17:30');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(valueOf('nightMinutes')).toBe('1.0');
  });

  it('offers nothing when the logged figure and the calculation already agree', async () => {
    await savedSectorLogging(78);

    await vi.waitFor(() => expect(valueOf('nightMinutes')).toBe('1.3'));
    expect(offer()).toBeNull();
  });

  it('offers nothing on a new entry, where there is nothing to keep', async () => {
    const { user } = await setup();

    await enterEveningSector(user);

    await vi.waitFor(() => expect(valueOf('nightMinutes')).toBe('1.3'));
    // The suggestion filled an empty field; typing over it is the whole choice.
    expect(offer()).toBeNull();
  });

  it('offers nothing when the route cannot be worked out', async () => {
    const saved = await addFlight({
      date: '2026-12-21',
      depAerodrome: 'ENGM',
      arrAerodrome: 'ZZZZ',
      offBlock: '15:00',
      onBlock: '17:00',
      aircraftType: 'A320',
      registration: 'LN-ABC',
      totalMinutes: 120,
      nightMinutes: 60,
      landingsDay: 1,
      landingsNight: 0,
    } as never);
    expect(saved.ok).toBe(true);
    const [flight] = await listFlights();
    await setup(flight.id);

    await vi.waitFor(() => expect(nightCellText()).toContain('not in the airport list'));
    expect(offer()).toBeNull();
    expect(valueOf('nightMinutes')).toBe('1.0');
  });
});
