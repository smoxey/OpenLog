/**
 * The first component test in the project.
 *
 * Its real job is to prove the harness works against Svelte 5 — runes, `$props`,
 * `$effect`, `<svelte:window>` — before anything is built on top of it. The
 * assertions themselves are about `ConfirmDialog`, which was chosen because it
 * is small and because one of its behaviours (focusing its confirm button on
 * mount) is the exact reason `RestoreConfirmDialog` had to be a separate
 * component: right for "discard draft?", catastrophic when Enter would destroy
 * a logbook.
 *
 * NOTE what this harness still cannot see. jsdom has no structured clone behind
 * IndexedDB, so a Svelte proxy reaching storage — the only bug Prompt 3b-1
 * shipped — would pass every test here. Component tests are not a substitute
 * for the click-through.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ConfirmDialog from './ConfirmDialog.svelte';

function setup(overrides: Record<string, unknown> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(ConfirmDialog, {
    props: { title: 'Discard draft?', message: 'This cannot be undone.', onConfirm, onCancel, ...overrides },
  });
  return { onConfirm, onCancel };
}

describe('ConfirmDialog', () => {
  it('renders its title and message', () => {
    setup();
    expect(screen.getByText('Discard draft?')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
  });

  it('calls onConfirm when the confirm button is pressed', async () => {
    const { onConfirm } = setup({ confirmLabel: 'Discard' });
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel when the cancel button is pressed', async () => {
    const { onCancel } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('cancels on Escape', async () => {
    const { onCancel } = setup();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('focuses its CONFIRM button on mount', async () => {
    // Documented here because it is a hazard, not a feature to copy. Any dialog
    // whose confirm button destroys data must focus Cancel instead — which is
    // why RestoreConfirmDialog exists separately, and why the import wizard's
    // conflict pause focuses its safest option.
    setup({ confirmLabel: 'Discard' });
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Discard' })).toHaveFocus();
    });
  });
});
