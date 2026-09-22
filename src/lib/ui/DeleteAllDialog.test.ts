/**
 * The delete-everything confirmation.
 *
 * What these defend is the FRICTION. This is the only control in the app whose
 * whole purpose is destruction, with no undo and no cloud copy behind it, so
 * every guard here is load-bearing: the typed word, the focus on Cancel, the
 * concrete counts, and the way out.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import DeleteAllDialog from './DeleteAllDialog.svelte';

function setup(overrides: Record<string, unknown> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const onBackupFirst = vi.fn();
  render(DeleteAllDialog, {
    props: {
      flightCount: 250,
      aircraftCount: 78,
      lastBackupAt: null,
      busy: false,
      backingUp: false,
      backupMessage: '',
      onConfirm,
      onCancel,
      onBackupFirst,
      ...overrides,
    },
  });
  return { onConfirm, onCancel, onBackupFirst };
}

const deleteButton = () => screen.getByRole('button', { name: /Delete everything/i });
const gate = () => screen.getByRole('textbox', { name: /Type DELETE to confirm/i });

describe('what it tells you', () => {
  it('states the damage in concrete counts, not as "your data"', () => {
    setup();
    expect(screen.getByText('250 flights')).toBeInTheDocument();
    expect(screen.getByText('78 aircraft')).toBeInTheDocument();
  });

  it('says plainly that there is no undo and no cloud copy', () => {
    setup();
    expect(screen.getByText(/This cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/no cloud copy/i)).toBeInTheDocument();
  });

  it('says what survives, so the action is not more frightening than it is', () => {
    setup();
    expect(screen.getByText(/display settings are kept/i)).toBeInTheDocument();
  });

  it('handles the singular', () => {
    setup({ flightCount: 1, aircraftCount: 1 });
    expect(screen.getByText('1 flight')).toBeInTheDocument();
    expect(screen.getByText('1 aircraft')).toBeInTheDocument();
  });

  it('says so when there is nothing to delete', () => {
    setup({ flightCount: 0, aircraftCount: 0 });
    expect(screen.getByText(/already empty/i)).toBeInTheDocument();
  });
});

describe('the typed gate', () => {
  it('keeps the delete button disabled until the word is typed', async () => {
    // Restore has no typed gate, deliberately — its commonest legitimate use is
    // a new phone with nothing to lose. Deleting has no such case: there is no
    // reason to delete an empty logbook, so every real use destroys something.
    setup();
    expect(deleteButton()).toBeDisabled();

    await userEvent.type(gate(), 'DELET');
    expect(deleteButton()).toBeDisabled();

    await userEvent.type(gate(), 'E');
    expect(deleteButton()).toBeEnabled();
  });

  it('accepts the word in any case, after trimming', async () => {
    setup();
    await userEvent.type(gate(), '  delete  ');
    expect(deleteButton()).toBeEnabled();
  });

  it('does not accept a near miss', async () => {
    setup();
    await userEvent.type(gate(), 'delete everything');
    expect(deleteButton()).toBeDisabled();
  });

  it('only calls onConfirm once the gate is satisfied', async () => {
    const { onConfirm } = setup();
    await userEvent.type(gate(), 'DELETE');
    await userEvent.click(deleteButton());
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

describe('the ways out', () => {
  it('focuses CANCEL, never the destructive button', async () => {
    // The reason this is not the generic ConfirmDialog, which focuses its
    // confirm button — right for "discard draft?", catastrophic here.
    setup();
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });
  });

  it('cancels on Escape', async () => {
    const { onCancel } = setup();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('offers a backup first, made prominent when nothing was ever exported', () => {
    // The case where this destroys the only copy in existence.
    const { onBackupFirst } = setup({ lastBackupAt: null });
    const button = screen.getByRole('button', { name: /Back up first/i });
    expect(button.className).toContain('primary');
    expect(onBackupFirst).not.toHaveBeenCalled();
  });

  it('leaves the backup offer ordinary when a backup exists', () => {
    setup({ lastBackupAt: '2026-08-20T10:00:00.000Z' });
    expect(screen.getByRole('button', { name: /Back up first/i }).className).not.toContain(
      'primary',
    );
  });

  it('does not offer a backup when there is nothing to back up', () => {
    setup({ flightCount: 0, aircraftCount: 0 });
    expect(screen.queryByRole('button', { name: /Back up first/i })).not.toBeInTheDocument();
  });

  it('reports how the backup went without closing the dialog', () => {
    setup({ backupMessage: 'Saved open-pilot-logbook.json.' });
    expect(screen.getByText('Saved open-pilot-logbook.json.')).toBeInTheDocument();
    expect(deleteButton()).toBeInTheDocument();
  });
});

describe('while it is working', () => {
  it('disables everything, so nothing can be pressed twice', () => {
    setup({ busy: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Deleting…/i })).toBeDisabled();
    expect(gate()).toBeDisabled();
  });

  it('ignores Escape mid-delete', async () => {
    const { onCancel } = setup({ busy: true });
    await userEvent.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
  });
});
