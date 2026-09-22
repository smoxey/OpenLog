/**
 * The landing block on the entry form: who was flying, which column the
 * landing goes in, and what the form does when it cannot tell.
 *
 * The domain half of this is covered in `night/night.test.ts` — which taxi
 * windows make the answer a guess — and the passthrough in
 * `night/suggest.test.ts`. What this file covers is the part a pilot touches:
 * a toggle that sets a count, two counts that stay editable underneath it, and
 * a question that is asked once and then stays answered.
 *
 * Like the night tests, these run against the real generated airport list, so
 * they use aerodromes the committed seed guarantees (ENGM, EGLL).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import FlightForm from './FlightForm.svelte';
import { db } from '../storage/db';
import { addFlight, listFlights } from '../storage';
import { loadSettings } from '../stores/settings.svelte';
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
  render(FlightForm, { props: { flightId, onDone: vi.fn(), onCancel: vi.fn() } });
  await screen.findByRole('button', { name: 'Save flight' });
  return { user: userEvent.setup() };
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

/** The whole landing block — toggle, both counts and any question under them. */
function landingBlockText(): string {
  const block = document.querySelector('.landings');
  return (block?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const role = (name: 'Pilot Flying' | 'Pilot Monitoring') => screen.getByRole('button', { name });

/** A midwinter evening sector: takes off in daylight, lands at Heathrow dark. */
async function enterEveningSector(user: ReturnType<typeof userEvent.setup>) {
  await fill(user, 'date', '2026-12-21');
  await fill(user, 'depAerodrome', 'ENGM');
  await fill(user, 'arrAerodrome', 'EGLL');
  await fill(user, 'offBlock', '15:00');
  await fill(user, 'onBlock', '17:00');
}

/** The same route in daylight at both ends. */
async function enterDaylightSector(user: ReturnType<typeof userEvent.setup>) {
  await fill(user, 'date', '2026-06-21');
  await fill(user, 'depAerodrome', 'ENGM');
  await fill(user, 'arrAerodrome', 'EGLL');
  await fill(user, 'offBlock', '10:00');
  await fill(user, 'onBlock', '12:00');
}

/**
 * Blocks in eight minutes after civil twilight ends at Heathrow, with an
 * unrecorded taxi in between — so the landing may have been on either side.
 */
async function enterCloseCallSector(user: ReturnType<typeof userEvent.setup>) {
  await fill(user, 'date', '2027-09-21');
  await fill(user, 'depAerodrome', 'ENGM');
  await fill(user, 'arrAerodrome', 'EGLL');
  await fill(user, 'offBlock', '16:55');
  await fill(user, 'onBlock', '18:45');
}

describe('both landing columns, side by side', () => {
  it('shows Ldg Night inline, not behind the More disclosure', async () => {
    await setup();

    expect(document.getElementById('f-landingsDay')).toBeTruthy();
    expect(document.getElementById('f-landingsNight')).toBeTruthy();
    expect(document.querySelector('.more')?.hasAttribute('open')).toBe(false);
    expect(document.querySelector('.landing-fields')?.children.length).toBe(2);
  });

  it('opens on one day landing, which is what pilot flying means', async () => {
    await setup();

    expect(valueOf('landingsDay')).toBe('1');
    expect(valueOf('landingsNight')).toBe('0');
    expect(role('Pilot Flying').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('who was flying', () => {
  it('logs no landing at all for the pilot monitoring', async () => {
    const { user } = await setup();
    await enterDaylightSector(user);
    await vi.waitFor(() => expect(valueOf('landingsDay')).toBe('1'));

    await user.click(role('Pilot Monitoring'));

    expect(valueOf('landingsDay')).toBe('0');
    expect(valueOf('landingsNight')).toBe('0');
    expect(role('Pilot Monitoring').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps it at nothing when the arrival is in the dark', async () => {
    const { user } = await setup();
    await enterEveningSector(user);
    await vi.waitFor(() => expect(valueOf('landingsNight')).toBe('1'));

    await user.click(role('Pilot Monitoring'));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(valueOf('landingsDay')).toBe('0');
    expect(valueOf('landingsNight')).toBe('0');
    // Night TIME is not a landing: the pilot monitoring still flew in the dark.
    expect(valueOf('nightMinutes')).toBe('1.3');
  });

  it('puts the landing back, in the column the route says, on the way back', async () => {
    const { user } = await setup();
    await enterEveningSector(user);
    await user.click(role('Pilot Monitoring'));
    await vi.waitFor(() => expect(valueOf('landingsNight')).toBe('0'));

    await user.click(role('Pilot Flying'));

    expect(valueOf('landingsNight')).toBe('1');
    expect(valueOf('landingsDay')).toBe('0');
  });

  it('hands the column back to the calculation after the role changes', async () => {
    // Pilot flying on a daylight sector, then the date moves into midwinter:
    // the landing has to follow the sun, not stay where the toggle put it.
    const { user } = await setup();
    await enterDaylightSector(user);
    await user.click(role('Pilot Monitoring'));
    await user.click(role('Pilot Flying'));
    await vi.waitFor(() => expect(valueOf('landingsDay')).toBe('1'));

    await fill(user, 'date', '2026-12-21');
    await fill(user, 'offBlock', '15:00');
    await fill(user, 'onBlock', '17:00');

    await vi.waitFor(() => expect(valueOf('landingsNight')).toBe('1'));
    expect(valueOf('landingsDay')).toBe('0');
  });

  it('leaves a count the pilot typed alone — touch-and-goes are theirs', async () => {
    const { user } = await setup();
    await fill(user, 'landingsDay', '4');
    await enterEveningSector(user);

    await vi.waitFor(() => expect(valueOf('nightMinutes')).toBe('1.3'));
    expect(valueOf('landingsDay')).toBe('4');
  });

  it('reads the role back off a saved entry with no landing in it', async () => {
    const saved = await addFlight({
      date: '2026-12-21',
      depAerodrome: 'ENGM',
      arrAerodrome: 'EGLL',
      offBlock: '15:00',
      onBlock: '17:00',
      aircraftType: 'A320',
      registration: 'LN-ABC',
      totalMinutes: 120,
      nightMinutes: 78,
      landingsDay: 0,
      landingsNight: 0,
    } as never);
    expect(saved.ok).toBe(true);

    const [flight] = await listFlights();
    await setup(flight.id);

    expect(role('Pilot Monitoring').getAttribute('aria-pressed')).toBe('true');
    expect(valueOf('landingsDay')).toBe('0');
  });
});

describe('when the sun was on the horizon at block-in', () => {
  it('asks whether the column it picked is right, and says why it cannot tell', async () => {
    const { user } = await setup();
    await enterCloseCallSector(user);

    await vi.waitFor(() => expect(landingBlockText()).toContain('Sun close to the horizon'));
    const text = landingBlockText();
    expect(text).toContain('EGLL');
    expect(text).toContain('Taxi time is not logged');
    // It still picked one. The question is never a blank field.
    expect(valueOf('landingsNight')).toBe('1');
  });

  it('says nothing when the landing is well clear of twilight', async () => {
    const { user } = await setup();
    await enterEveningSector(user);

    await vi.waitFor(() => expect(valueOf('landingsNight')).toBe('1'));
    expect(landingBlockText()).not.toContain('Sun close to the horizon');
  });

  it('stops asking once the pilot says the column is right', async () => {
    const { user } = await setup();
    await enterCloseCallSector(user);
    await vi.waitFor(() => expect(landingBlockText()).toContain('Sun close to the horizon'));

    await user.click(screen.getByRole('button', { name: 'Yes — night landing' }));

    expect(landingBlockText()).not.toContain('Sun close to the horizon');
    expect(valueOf('landingsNight')).toBe('1');
  });

  it('moves the landing across when the pilot says it is not, and leaves it there', async () => {
    const { user } = await setup();
    await enterCloseCallSector(user);
    await vi.waitFor(() => expect(landingBlockText()).toContain('Sun close to the horizon'));

    await user.click(screen.getByRole('button', { name: 'No — it was day' }));

    expect(valueOf('landingsDay')).toBe('1');
    expect(valueOf('landingsNight')).toBe('0');
    expect(landingBlockText()).not.toContain('Sun close to the horizon');

    // …and the calculation does not put it back on the next keystroke.
    await fill(user, 'aircraftType', 'A320');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(valueOf('landingsDay')).toBe('1');
    expect(valueOf('landingsNight')).toBe('0');
  });

  it('asks again when the verdict itself changes under a confirmed answer', async () => {
    const { user } = await setup();
    await enterCloseCallSector(user);
    await vi.waitFor(() => expect(landingBlockText()).toContain('Sun close to the horizon'));
    await user.click(screen.getByRole('button', { name: 'Yes — night landing' }));
    expect(landingBlockText()).not.toContain('Sun close to the horizon');

    // Ten minutes earlier off the blocks: now it is a DAY landing, still a
    // close call — and what they agreed to was about the other one.
    await fill(user, 'offBlock', '16:35');
    await fill(user, 'onBlock', '18:35');

    await vi.waitFor(() => expect(valueOf('landingsDay')).toBe('1'));
    expect(landingBlockText()).toContain('Sun close to the horizon');
  });

  it('does not ask the pilot monitoring about a landing they did not make', async () => {
    const { user } = await setup();
    await enterCloseCallSector(user);
    await vi.waitFor(() => expect(landingBlockText()).toContain('Sun close to the horizon'));

    await user.click(role('Pilot Monitoring'));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(landingBlockText()).not.toContain('Sun close to the horizon');
  });

  it('never blocks the save', async () => {
    const { user } = await setup();
    await enterCloseCallSector(user);
    await fill(user, 'aircraftType', 'A320');
    await fill(user, 'registration', 'LN-ABC');
    await vi.waitFor(() => expect(landingBlockText()).toContain('Sun close to the horizon'));

    await user.click(screen.getByRole('button', { name: 'Save flight' }));

    await vi.waitFor(async () => expect((await listFlights()).length).toBe(1));
    const [flight] = await listFlights();
    expect(flight.landingsNight).toBe(1);
    expect(flight.landingsDay).toBe(0);
  });
});
