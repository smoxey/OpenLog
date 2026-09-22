<script lang="ts">
  /**
   * The confirmation for deleting everything.
   *
   * Its own component, not `ConfirmDialog` — which focuses its confirm button on
   * mount. That is right for "discard draft?" and catastrophic when Enter would
   * erase a logbook.
   *
   * IT REQUIRES THE WORD TYPED, and this deliberately departs from the restore
   * dialog, which does not. The argument recorded against a typed gate for
   * restore was that its commonest legitimate use is a new phone with an empty
   * logbook and nothing to lose. Deleting has no such case: there is no reason
   * to delete an empty logbook, so every real use of this button destroys
   * something. The friction is the point.
   *
   * Everything else follows the restore dialog, because that reasoning holds
   * here too: concrete counts rather than "your data", the no-undo and
   * no-cloud-copy stated plainly, focus on Cancel, and a way to back up first —
   * made prominent when the logbook has never been exported anywhere.
   */
  import { backupLabel, backupStatus } from '../export/backupStatus';

  interface Props {
    flightCount: number;
    aircraftCount: number;
    lastBackupAt: string | null;
    busy: boolean;
    backingUp: boolean;
    backupMessage: string;
    onConfirm: () => void;
    onCancel: () => void;
    onBackupFirst: () => void;
  }

  let {
    flightCount,
    aircraftCount,
    lastBackupAt,
    busy,
    backingUp,
    backupMessage,
    onConfirm,
    onCancel,
    onBackupFirst,
  }: Props = $props();

  /** The word that has to be typed. Compared case-insensitively after trimming. */
  const REQUIRED = 'DELETE';

  let typed = $state('');
  let cancelButton = $state<HTMLButtonElement | null>(null);

  const confirmed = $derived(typed.trim().toUpperCase() === REQUIRED);
  const status = $derived(backupStatus(lastBackupAt, new Date(), flightCount));
  /** The case where this destroys the only copy in existence. */
  const neverBackedUp = $derived(lastBackupAt === null && flightCount > 0);

  $effect(() => {
    // Focus CANCEL, never the destructive button.
    cancelButton?.focus();
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !busy) onCancel();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay" role="presentation">
  <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" tabindex="-1">
    <h2 id="delete-title">Delete everything?</h2>

    {#if flightCount === 0 && aircraftCount === 0}
      <p class="lead">There is nothing here to delete — your logbook is already empty.</p>
    {:else}
      <p class="lead">
        This will permanently delete
        <strong>{flightCount} {flightCount === 1 ? 'flight' : 'flights'}</strong>
        and
        <strong>{aircraftCount} {aircraftCount === 1 ? 'aircraft' : 'aircraft'}</strong>
        from this device.
      </p>
    {/if}

    <ul class="facts">
      <li><strong>This cannot be undone.</strong></li>
      <li>There is no cloud copy. Your logbook exists only on this device.</li>
      <li>Your display settings are kept. Only the logbook itself is deleted.</li>
    </ul>

    <p class="backup-state" class:bad={neverBackedUp}>
      {backupLabel(status)}
    </p>

    {#if flightCount > 0}
      <div class="way-out">
        <button
          type="button"
          class="btn"
          class:primary={neverBackedUp}
          disabled={backingUp || busy}
          onclick={onBackupFirst}
        >
          {backingUp ? 'Backing up…' : 'Back up first'}
        </button>
        {#if backupMessage}<span class="backup-msg">{backupMessage}</span>{/if}
      </div>
    {/if}

    <label class="gate">
      Type <strong>{REQUIRED}</strong> to confirm
      <input
        type="text"
        bind:value={typed}
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        aria-label={`Type ${REQUIRED} to confirm`}
        disabled={busy}
      />
    </label>

    <div class="actions">
      <button type="button" class="btn" bind:this={cancelButton} disabled={busy} onclick={onCancel}>
        Cancel
      </button>
      <button type="button" class="btn danger" disabled={!confirmed || busy} onclick={onConfirm}>
        {busy ? 'Deleting…' : 'Delete everything'}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgba(9, 18, 24, 0.55);
  }
  .dialog {
    width: 100%;
    max-width: 30rem;
    max-height: 90vh;
    overflow-y: auto;
    padding: 1.15rem;
    border: 2px solid var(--danger);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  h2 {
    margin: 0 0 0.6rem;
    font-size: 1.1rem;
    color: var(--danger);
  }
  .lead {
    margin: 0 0 0.75rem;
    font-size: 0.95rem;
    line-height: 1.5;
  }
  .facts {
    margin: 0 0 0.85rem;
    padding-left: 1.1rem;
    font-size: 0.85rem;
    line-height: 1.55;
    color: var(--text-muted);
  }
  .backup-state {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .backup-state.bad {
    color: var(--danger);
    font-weight: 600;
  }
  .way-out {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.9rem;
  }
  .backup-msg {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .gate {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 1rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .gate input {
    min-height: var(--touch);
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-family: var(--mono);
    letter-spacing: 0.08em;
  }
  .actions {
    display: flex;
    gap: 0.6rem;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
</style>
