/**
 * The entry form's clock and its entry zone.
 *
 * Two features that both come down to one rule: **whatever is on the screen,
 * the record holds a 24-hour UTC `"HH:MM"`.** The clock changes how those four
 * digits are painted and typed; the zone changes what is subtracted before they
 * are saved. Neither is stored on a flight, and neither may quietly move one.
 *
 * The load-bearing assertions here are the two about the date: a sector that
 * departs after midnight local is logged on the previous day in UTC, and
 * switching the zone selector on a SAVED flight must not move it at all. Both
 * are silent failures — the entry looks entirely plausible either way, and a
 * pilot would find out when they counted their hours for a licence renewal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import FlightForm from './FlightForm.svelte';
import { db } from '../storage/db';
import { addFlight, listFlights } from '../storage';
import { loadSettings } from '../stores/settings.svelte';
import { updateSettings } from '../storage/settings';

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
  await screen.findByRole('button', { name: 'Save flight' });
  return { onDone, onCancel, user: userEvent.setup() };
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

/** The whole field cell — input plus whatever hint sits under it. */
function cellText(key: string): string {
  const cell = document.getElementById(`f-${key}`)?.closest('.form-field');
  return (cell?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function zoneSelect(): HTMLSelectElement | null {
  return document.getElementById('entry-zone') as HTMLSelectElement | null;
}

/** A complete, saveable flight, with block times supplied by the caller. */
async function enterFlight(
  user: ReturnType<typeof userEvent.setup>,
  { date, off, on }: { date: string; off: string; on: string },
) {
  await fill(user, 'date', date);
  await fill(user, 'depAerodrome', 'ENGM');
  await fill(user, 'arrAerodrome', 'ENBR');
  await fill(user, 'offBlock', off);
  await fill(user, 'onBlock', on);
  await fill(user, 'aircraftType', 'C172');
  await fill(user, 'registration', 'LN-AAA');
}

const saveButton = () => screen.getByRole('button', { name: 'Save flight' });

describe('the 24-hour clock', () => {
  it('is a text field, not a native time picker whose clock the browser owns', async () => {
    // The whole reason this component exists: `<input type="time">` renders on
    // the operating system's locale and no attribute can say "24-hour".
    await setup();
    const input = document.getElementById('f-offBlock') as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.inputMode).toBe('numeric');
  });

  it('accepts the four digits a pilot types off a clock', async () => {
    const { user } = await setup();
    await fill(user, 'offBlock', '2336');
    expect(valueOf('offBlock')).toBe('23:36');
  });

  it('pads a three-digit morning time', async () => {
    const { user } = await setup();
    await fill(user, 'offBlock', '936');
    expect(valueOf('offBlock')).toBe('09:36');
  });

  it('says what it cannot read, while it is being typed', async () => {
    const { user } = await setup();
    const input = document.getElementById('f-offBlock') as HTMLInputElement;
    await user.click(input);
    await user.type(input, '99:99');
    expect(cellText('offBlock')).toContain('Use hh:mm');
  });

  it('snaps back to the last time it could read rather than keeping a bad one', async () => {
    // The same contract as `DurationInput`, and for the same reason: the bound
    // value never holds anything unreadable, so nothing unreadable can ever be
    // saved. What the pilot sees on leaving the field is what would be stored.
    const { user } = await setup();
    await fill(user, 'offBlock', '21:30');

    // Replaced in ONE input event, so there are no valid intermediate readings
    // to fall back to — typing it a character at a time would leave the field
    // holding whatever the first keystroke happened to mean.
    const input = document.getElementById('f-offBlock') as HTMLInputElement;
    await user.click(input);
    await user.keyboard('{Control>}a{/Control}');
    await user.paste('99:99');
    await user.tab();

    expect(valueOf('offBlock')).toBe('21:30');
  });

  it('stores the 24-hour string, whatever was typed', async () => {
    const { user, onDone } = await setup();
    await enterFlight(user, { date: '2026-08-29', off: '2130', on: '2245' });
    await user.click(saveButton());
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

    const [saved] = await listFlights();
    expect(saved.offBlock).toBe('21:30');
    expect(saved.onBlock).toBe('22:45');
  });
});

describe('the 12-hour clock, when the pilot asks for it', () => {
  beforeEach(async () => {
    await updateSettings({ clockDisplay: '12h' });
    await loadSettings();
  });

  it('shows a stored time with am/pm', async () => {
    const flight = await addFlight({
      date: '2026-08-29',
      depAerodrome: 'ENGM',
      arrAerodrome: 'ENBR',
      offBlock: '23:36',
      onBlock: '01:10',
      aircraftType: 'C172',
      registration: 'LN-AAA',
      picName: '',
      totalMinutes: 96,
    });
    expect(flight.ok).toBe(true);
    if (!flight.ok) return;

    await setup(flight.flight.id);
    expect(valueOf('offBlock')).toBe('11:36 PM');
    expect(valueOf('onBlock')).toBe('1:10 AM');
  });

  it('still accepts four bare digits, because they are unambiguous', async () => {
    const { user } = await setup();
    await fill(user, 'offBlock', '2336');
    // Read on the 24-hour clock and shown back on the 12-hour one, so a pilot
    // who meant something else can see it before saving.
    expect(valueOf('offBlock')).toBe('11:36 PM');
  });

  it('changes nothing about what is stored', async () => {
    const { user, onDone } = await setup();
    await enterFlight(user, { date: '2026-08-29', off: '11:36 PM', on: '1:10 AM' });
    await user.click(saveButton());
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

    const [saved] = await listFlights();
    expect(saved.offBlock).toBe('23:36');
    expect(saved.onBlock).toBe('01:10');
  });
});

describe('entering block times in local time', () => {
  it('offers UTC by default, and says nothing more', async () => {
    await setup();
    expect(zoneSelect()?.value).toBe('0');
    expect(cellText('offBlock')).not.toContain('local');
  });

  it('states the UTC it will store, under the field, before the save', async () => {
    // The entire safety of the feature. A pilot must be able to see the
    // conversion at the moment they type it, not discover it afterwards.
    const { user } = await setup();
    await user.selectOptions(zoneSelect()!, '120');
    await fill(user, 'offBlock', '23:36');
    expect(cellText('offBlock')).toContain('23:36 local = 21:36 UTC');
  });

  it('converts both block times on the way to storage', async () => {
    const { user, onDone } = await setup();
    await user.selectOptions(zoneSelect()!, '120');
    await enterFlight(user, { date: '2026-08-29', off: '10:00', on: '11:12' });
    await user.click(saveButton());
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

    const [saved] = await listFlights();
    expect(saved.offBlock).toBe('08:00');
    expect(saved.onBlock).toBe('09:12');
    expect(saved.date).toBe('2026-08-29');
  });

  it('logs a flight departing after local midnight on the previous UTC day', async () => {
    const { user, onDone } = await setup();
    await user.selectOptions(zoneSelect()!, '120');
    await enterFlight(user, { date: '2026-03-01', off: '01:30', on: '03:00' });
    await user.click(saveButton());
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

    const [saved] = await listFlights();
    expect(saved.offBlock).toBe('23:30');
    expect(saved.onBlock).toBe('01:00');
    expect(saved.date).toBe('2026-02-28');
  });

  it('warns about that date move on the date field itself', async () => {
    const { user } = await setup();
    await user.selectOptions(zoneSelect()!, '120');
    await fill(user, 'date', '2026-03-01');
    await fill(user, 'offBlock', '01:30');
    expect(cellText('date')).toContain('logged on 2026-02-28');
  });

  it('is remembered, so a pilot who logs local time is not asked twice', async () => {
    const { user } = await setup();
    await user.selectOptions(zoneSelect()!, '120');
    await vi.waitFor(async () => {
      const { getSettings } = await import('../storage/settings');
      expect((await getSettings()).entryTimeZoneOffset).toBe(120);
    });
  });

  it('is hidden for a simulator session, which has no block times', async () => {
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Simulator' }));
    expect(zoneSelect()).toBeNull();
  });
});

describe('switching the zone on a flight already saved', () => {
  /** 21:36Z to 23:10Z on 29 August — stored, as every record is, in UTC. */
  async function savedFlight() {
    const result = await addFlight({
      date: '2026-08-29',
      depAerodrome: 'ENGM',
      arrAerodrome: 'ENBR',
      offBlock: '21:36',
      onBlock: '23:10',
      aircraftType: 'C172',
      registration: 'LN-AAA',
      picName: '',
      totalMinutes: 96,
    });
    if (!result.ok) throw new Error(result.errors[0].message);
    return result.flight;
  }

  it('re-expresses the same instant rather than reinterpreting the digits', async () => {
    const flight = await savedFlight();
    const { user } = await setup(flight.id);
    expect(valueOf('offBlock')).toBe('21:36');

    await user.selectOptions(zoneSelect()!, '120');
    expect(valueOf('offBlock')).toBe('23:36');
    expect(valueOf('onBlock')).toBe('01:10');
  });

  it('MOVES NOTHING when the flight is saved again untouched', async () => {
    // The failure this test exists for: keeping the typed digits and letting
    // the new zone reinterpret them would silently rewrite the record every
    // time a pilot changed the selector to see what zone it was in.
    const flight = await savedFlight();
    const { user, onDone } = await setup(flight.id);
    await user.selectOptions(zoneSelect()!, '120');
    await user.click(saveButton());
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

    const [saved] = await listFlights();
    expect(saved.date).toBe('2026-08-29');
    expect(saved.offBlock).toBe('21:36');
    expect(saved.onBlock).toBe('23:10');
  });

  it('opens a saved flight on the remembered local clock, same instant', async () => {
    await updateSettings({ entryTimeZoneOffset: 120 });
    await loadSettings();
    const flight = await savedFlight();

    await setup(flight.id);
    expect(valueOf('offBlock')).toBe('23:36');
    expect(valueOf('onBlock')).toBe('01:10');
    // 21:36Z on the 29th is 23:36 on the 29th at UTC+2 — the date does not move
    // in this direction, and the form must not pretend it does.
    expect(valueOf('date')).toBe('2026-08-29');
  });
});
