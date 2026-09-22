/**
 * The settings panel's danger zone.
 *
 * The dialog's own guards are covered in `DeleteAllDialog.test.ts`. What this
 * file covers is the WIRING: that the button is separated and marked as
 * dangerous, that nothing is deleted until the dialog is confirmed, and that
 * confirming it actually empties the logbook.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import SettingsPanel from './SettingsPanel.svelte';
import { db } from '../storage/db';
import { addFlight, getSettings, listFlights, updateSettings, upsertAircraft } from '../storage';
import { loadSettings } from '../stores/settings.svelte';

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
  await loadSettings();
});

async function seed() {
  await addFlight({
    date: '2024-01-01',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '08:00',
    onBlock: '09:00',
    aircraftType: 'C172',
    registration: 'LN-ABC',
    picName: 'SELF',
    totalMinutes: 60,
  });
  await upsertAircraft({ registration: 'LN-ABC', type: 'C172', class: 'SE', multiPilot: false });
}

function setup() {
  const onBack = vi.fn();
  const onExport = vi.fn();
  const onDataDeleted = vi.fn();
  render(SettingsPanel, { props: { onBack, onExport, onDataDeleted } });
  return { onBack, onExport, onDataDeleted };
}

const openDialog = async () => {
  await userEvent.click(screen.getByRole('button', { name: /Delete all data/i }));
  return screen.findByRole('textbox', { name: /Type DELETE to confirm/i });
};

describe('the danger zone', () => {
  it('is marked as dangerous, and says what it does before you touch it', () => {
    setup();
    expect(screen.getByText('Danger zone')).toBeInTheDocument();
    expect(screen.getByText(/no undo/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete all data/i }).className).toContain('danger');
  });

  it('sits last, below every ordinary setting', () => {
    // So it can never be mistaken for one of them. The same reasoning that puts
    // Restore at the bottom of the export panel.
    setup();
    const groups = [...document.querySelectorAll('fieldset.group legend')].map(
      (l) => l.textContent,
    );
    expect(groups[groups.length - 1]).toBe('Danger zone');
  });

  it('says that display settings survive', () => {
    setup();
    expect(screen.getByText(/display settings are kept/i)).toBeInTheDocument();
  });
});

describe('nothing happens without confirmation', () => {
  it('opens a dialog rather than deleting on the first click', async () => {
    await seed();
    setup();
    await openDialog();
    expect(await listFlights()).toHaveLength(1);
  });

  it('states the real counts, read when the dialog opens', async () => {
    await seed();
    setup();
    await openDialog();
    expect(screen.getByText('1 flight')).toBeInTheDocument();
    expect(screen.getByText('1 aircraft')).toBeInTheDocument();
  });

  it('cancelling leaves everything exactly as it was', async () => {
    await seed();
    setup();
    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await listFlights()).toHaveLength(1);
    expect(screen.queryByRole('textbox', { name: /Type DELETE/i })).not.toBeInTheDocument();
  });
});

describe('confirming it', () => {
  it('empties the logbook and reports what went', async () => {
    await seed();
    const { onDataDeleted } = setup();
    const gate = await openDialog();

    await userEvent.type(gate, 'DELETE');
    await userEvent.click(screen.getByRole('button', { name: /Delete everything/i }));

    await vi.waitFor(async () => {
      expect(await listFlights()).toHaveLength(0);
    });
    expect(await screen.findByText(/Deleted 1 flight and 1 aircraft/i)).toBeInTheDocument();
    expect(onDataDeleted).toHaveBeenCalledOnce();
  });

  it('keeps the display preferences', async () => {
    await seed();
    await updateSettings({ durationDisplay: 'hhmm', defaultAircraftClass: 'SE' });
    await loadSettings();
    setup();

    const gate = await openDialog();
    await userEvent.type(gate, 'DELETE');
    await userEvent.click(screen.getByRole('button', { name: /Delete everything/i }));

    await vi.waitFor(async () => {
      expect(await listFlights()).toHaveLength(0);
    });
    const after = await getSettings();
    expect(after.durationDisplay).toBe('hhmm');
    expect(after.defaultAircraftClass).toBe('SE');
  });

  it('clears the backup stamp, because an empty logbook was never backed up', async () => {
    await seed();
    await updateSettings({ lastBackupAt: '2026-01-01T00:00:00.000Z', lastBackupFormat: 'json' });
    await loadSettings();
    setup();

    const gate = await openDialog();
    await userEvent.type(gate, 'DELETE');
    await userEvent.click(screen.getByRole('button', { name: /Delete everything/i }));

    await vi.waitFor(async () => {
      expect((await getSettings()).lastBackupAt).toBeNull();
    });
  });
});

describe('the night-time setting', () => {
  it('is on by default, because the point of it is not having to think', async () => {
    setup();
    const on = await screen.findByRole('radio', { name: /Work it out for me/ });
    expect(on).toBeChecked();
  });

  it('says what it assumes, rather than only what it does', async () => {
    // Sea level and the great circle are assumptions the app makes and the
    // pilot did not. A calculation whose method is invisible is one nobody can
    // disagree with.
    setup();
    await screen.findByRole('radio', { name: /Work it out for me/ });
    const text = document.body.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('civil twilight');
    expect(text).toContain('sea level');
    expect(text).toContain('great circle');
  });

  it('persists being turned off, and says the button still works', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(await screen.findByRole('radio', { name: /I will enter it/ }));
    await vi.waitFor(async () => expect((await getSettings()).autoNight).toBe(false));

    const text = document.body.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('leaves the button on the night field');
  });
});
