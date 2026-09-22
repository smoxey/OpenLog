<script lang="ts">
  /**
   * The last thing standing between a mis-tap and an unrecoverable loss.
   *
   * Deliberately NOT the generic `ConfirmDialog`. Two differences matter:
   *
   *  1. `ConfirmDialog` focuses its confirm button on mount. That is right for
   *     "discard draft?" and wrong here — a stray Enter or Space would destroy
   *     the logbook. Cancel takes focus instead, and the destructive button is
   *     the one that has to be sought out.
   *  2. It states the situation in CONCRETE NUMBERS on both sides. "Your data
   *     will be replaced" is not something a user can check; "your 412 flights
   *     will be deleted and replaced with 38" is.
   *
   * There is no cloud copy and no undo, so this is the mitigation. It also
   * carries a way out: back up what is here first, without losing the file
   * already chosen.
   */
  import type { BackupSummary } from '../import/restore';
  import { backupLabel, backupStatus } from '../export/backupStatus';

  interface Props {
    fileName: string;
    summary: BackupSummary;
    currentFlightCount: number;
    currentAircraftCount: number;
    lastBackupAt: string | null;
    busy: boolean;
    backingUp: boolean;
    backupMessage: string;
    onConfirm: () => void;
    onCancel: () => void;
    onBackupFirst: () => void;
  }

  let {
    fileName,
    summary,
    currentFlightCount,
    currentAircraftCount,
    lastBackupAt,
    busy,
    backingUp,
    backupMessage,
    onConfirm,
    onCancel,
    onBackupFirst,
  }: Props = $props();

  let cancelBtn = $state<HTMLButtonElement | null>(null);

  // Focus CANCEL, not confirm. See the note above — this is the whole point.
  $effect(() => {
    cancelBtn?.focus();
  });

  const status = $derived(backupStatus(lastBackupAt, new Date(), currentFlightCount));

  /**
   * The case where a restore destroys the only copy of the data in existence:
   * there is something here, and it has never been exported anywhere.
   */
  const atRisk = $derived(currentFlightCount > 0 && lastBackupAt === null);

  /** Nothing to lose — a fresh install or a new phone. Say so plainly. */
  const nothingToLose = $derived(currentFlightCount === 0 && currentAircraftCount === 0);

  function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
  }

  function shortDate(iso: string): string {
    if (!iso) return 'unknown date';
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return 'unknown date';
    return parsed.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) onCancel();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay" role="presentation" onclick={() => !busy && onCancel()}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="dialog"
    role="alertdialog"
    aria-modal="true"
    tabindex="-1"
    aria-labelledby="restore-title"
    onclick={(e) => e.stopPropagation()}
  >
    <h2 id="restore-title">Replace your whole logbook?</h2>

    <!-- The two sides, as counts. The heart of the dialog. -->
    <div class="ledger">
      <div class="side gone">
        <p class="side-head">Deleted from this device</p>
        {#if nothingToLose}
          <p class="side-figure none">Nothing — this logbook is empty</p>
        {:else}
          <p class="side-figure">{plural(currentFlightCount, 'flight', 'flights')}</p>
          <p class="side-sub">{plural(currentAircraftCount, 'aircraft profile', 'aircraft profiles')}</p>
        {/if}
      </div>
      <div class="arrow" aria-hidden="true">↓</div>
      <div class="side coming">
        <p class="side-head">Restored from the file</p>
        <p class="side-figure">{plural(summary.flightCount, 'flight', 'flights')}</p>
        <p class="side-sub">{plural(summary.aircraftCount, 'aircraft profile', 'aircraft profiles')}</p>
      </div>
    </div>

    {#if summary.flightCount === 0}
      <p class="empty-warning">
        This backup contains no flights. Restoring it will leave your logbook empty.
      </p>
    {/if}

    <p class="hard-truth">
      <strong>This cannot be undone.</strong> Your logbook lives only on this device — there is no
      cloud copy and no server to recover it from. Anything not already exported to a file is gone
      for good.
    </p>

    <!-- File identity, so picking last year's backup is visible in time. -->
    <dl class="file">
      <dt>File</dt>
      <dd class="mono">{fileName}</dd>
      <dt>Exported</dt>
      <dd>{shortDate(summary.exportedAt)}</dd>
      <dt>Written by</dt>
      <dd>{summary.appVersion ? `app version ${summary.appVersion}` : 'an unknown app version'}</dd>
    </dl>

    {#if !nothingToLose}
      <div class="escape" class:urgent={atRisk}>
        <p class="escape-line">
          {#if atRisk}
            <strong>This logbook has never been backed up.</strong> If you have not saved a file
            elsewhere, this is the only copy of it.
          {:else}
            {backupLabel(status)}.
          {/if}
        </p>
        <button type="button" class="btn" disabled={busy || backingUp} onclick={onBackupFirst}>
          {backingUp ? 'Backing up…' : 'Back up first'}
        </button>
        {#if backupMessage}
          <p class="escape-result">{backupMessage}</p>
        {/if}
      </div>
    {/if}

    <div class="actions">
      <button type="button" class="btn ghost" bind:this={cancelBtn} disabled={busy} onclick={onCancel}>
        Cancel
      </button>
      <button type="button" class="btn danger" disabled={busy || backingUp} onclick={onConfirm}>
        {busy ? 'Restoring…' : 'Delete and restore'}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    overflow-y: auto;
    background: rgba(6, 14, 19, 0.62);
  }
  /*
    Wider and heavier than ConfirmDialog on purpose. This one should not look
    like the routine confirm the user has already learned to click through.
  */
  .dialog {
    width: 100%;
    max-width: 460px;
    margin: auto;
    background: var(--surface);
    border: 2px solid var(--danger);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow);
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  h2 {
    margin: 0;
    font-size: 1.15rem;
    color: var(--danger);
  }
  .ledger {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.8rem 0.9rem;
    border-radius: var(--radius);
    background: var(--surface-2);
  }
  .side-head {
    margin: 0;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
  }
  .side-figure {
    margin: 0.15rem 0 0;
    font-size: 1.05rem;
    font-weight: 700;
  }
  .side-figure.none {
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--text-muted);
  }
  .side-sub {
    margin: 0.1rem 0 0;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .side.gone .side-figure {
    color: var(--danger);
    text-decoration: line-through;
  }
  .arrow {
    font-size: 1.1rem;
    line-height: 1;
    color: var(--text-faint);
    text-align: center;
  }
  .empty-warning {
    margin: 0;
    padding: 0.55rem 0.7rem;
    border-radius: var(--radius);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 0.88rem;
    font-weight: 600;
  }
  .hard-truth {
    margin: 0;
    font-size: 0.92rem;
    line-height: 1.5;
    color: var(--text);
  }
  .file {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.2rem 0.7rem;
    margin: 0;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 0.82rem;
  }
  .file dt {
    color: var(--text-faint);
  }
  .file dd {
    margin: 0;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  .escape {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.8rem;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
  }
  .escape.urgent {
    border-color: var(--danger);
    background: var(--danger-soft);
  }
  .escape-line {
    flex: 1 1 14rem;
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .escape.urgent .escape-line {
    color: var(--danger);
  }
  .escape-result {
    flex: 1 1 100%;
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-muted);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
    margin-top: 0.2rem;
  }
</style>
