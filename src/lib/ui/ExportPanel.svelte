<script lang="ts">
  import { exportLogbook } from '../export/service';
  import { canShareFile, makeExportFile } from '../export/share';
  import { backupStatus, backupLabel } from '../export/backupStatus';
  import type { ExportKind, ExportWarning } from '../export/types';
  import { settings, refreshSettings } from '../stores/settings.svelte';
  import { readBackup, type BackupSummary } from '../import/restore';
  import { listFlights, getAllAircraft, restoreBackup, type RestoreContents } from '../storage';
  import RestoreConfirmDialog from './RestoreConfirmDialog.svelte';

  interface Props {
    onBack: () => void;
    flightCount: number;
    /** Open the CSV import wizard. It lives on this panel; see the card below. */
    onImport: () => void;
    onPrint: () => void;
  }

  let { onBack, flightCount, onImport, onPrint }: Props = $props();

  let busy = $state<ExportKind | null>(null);
  let message = $state('');
  let messageTone = $state<'ok' | 'warn' | 'error'>('ok');
  let warnings = $state<ExportWarning[]>([]);

  // --- Restore --------------------------------------------------------------
  // The flow is three steps on purpose: read the file, SHOW WHAT WILL HAPPEN,
  // then write. Nothing touches storage until the dialog is confirmed.
  let fileInput = $state<HTMLInputElement | null>(null);
  /**
   * `$state.raw`, not `$state`, and this matters rather than being a
   * micro-optimisation: plain `$state` deep-PROXIES the object it holds, and
   * IndexedDB cannot structured-clone a Proxy — the restore would abort with a
   * DataCloneError. Raw state is also the honest description, since this is
   * always replaced wholesale and never mutated in place.
   */
  let pending = $state.raw<
    | null
    | { fileName: string; contents: RestoreContents; summary: BackupSummary; currentFlights: number; currentAircraft: number }
  >(null);
  let restoring = $state(false);
  let backingUp = $state(false);
  let backupMessage = $state('');
  /** Rejection detail lines, listed under the message. */
  let restoreDetails = $state<string[]>([]);
  /** Set when the file picked for Restore turns out to be a spreadsheet. */
  let offerImport = $state(false);

  function report(tone: 'ok' | 'warn' | 'error', text: string, details: string[] = []) {
    messageTone = tone;
    message = text;
    warnings = [];
    restoreDetails = details;
    offerImport = false;
  }

  async function onFileChosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Clear immediately so choosing the same file twice still fires a change.
    input.value = '';
    if (!file) return;

    message = '';
    restoreDetails = [];
    backupMessage = '';

    let text: string;
    try {
      text = await file.text();
    } catch {
      report('error', 'That file could not be opened.');
      return;
    }

    const result = readBackup(text);
    if (!result.ok) {
      report('error', result.rejection.message, result.rejection.details);
      // Restore has always RECOGNISED a spreadsheet; until the import flow
      // existed there was nowhere to send the pilot. Now there is, so the
      // recognition turns into an offer.
      offerImport = result.rejection.code === 'looks-like-csv';
      return;
    }

    // Counts read at this instant, so the dialog states what is actually here.
    const [flights, aircraft] = await Promise.all([listFlights(), getAllAircraft()]);
    pending = {
      fileName: file.name,
      contents: {
        flights: result.flights,
        aircraft: result.aircraft,
        // `null` when the file said nothing about it, which leaves this
        // device's own brought-forward totals untouched.
        openingBalance: result.openingBalance,
      },
      summary: result.summary,
      currentFlights: flights.length,
      currentAircraft: aircraft.length,
    };
  }

  /** The way out: save what is here before replacing it, without losing the file. */
  async function backupFirst() {
    if (backingUp) return;
    backingUp = true;
    backupMessage = '';
    const outcome = await exportLogbook('json', 'auto');
    backingUp = false;
    await refreshSettings();
    backupMessage = outcome.ok
      ? `Saved ${outcome.filename}.`
      : outcome.cancelled
        ? 'Backup cancelled — nothing was saved.'
        : (outcome.error ?? 'Backup failed.');
  }

  async function confirmRestore() {
    if (!pending || restoring) return;
    restoring = true;
    // Belt to the `$state.raw` braces: hand storage plain objects, never
    // reactive ones. Unproxying is a Svelte concern, so it happens here rather
    // than inside the storage layer.
    const outcome = await restoreBackup($state.snapshot(pending.contents) as RestoreContents);
    restoring = false;

    if (!outcome.ok) {
      report('error', outcome.error ?? 'Restore failed and nothing was changed.');
      pending = null;
      return;
    }
    report(
      'ok',
      `Restored ${outcome.flightCount} ${outcome.flightCount === 1 ? 'flight' : 'flights'} and ` +
        `${outcome.aircraftCount} aircraft ${outcome.aircraftCount === 1 ? 'profile' : 'profiles'}.`,
    );
    pending = null;
  }

  function cancelRestore() {
    if (restoring) return;
    pending = null;
    backupMessage = '';
  }

  /**
   * Feature detection, not user-agent sniffing. Probed once with a
   * representative file — support varies by file type, not just by browser.
   */
  const shareSupported = canShareFile(
    makeExportFile('{}', 'open-pilot-logbook.json', 'application/json'),
  );

  const status = $derived(backupStatus(settings.lastBackupAt, new Date(), flightCount));

  async function run(kind: ExportKind, mode: 'auto' | 'download') {
    if (busy) return;
    busy = kind;
    message = '';
    warnings = [];
    restoreDetails = [];

    const outcome = await exportLogbook(kind, mode);
    busy = null;
    warnings = outcome.warnings;

    if (outcome.ok) {
      await refreshSettings();
      messageTone = outcome.warnings.length > 0 ? 'warn' : 'ok';
      message =
        outcome.route === 'share'
          ? `Shared ${outcome.filename}.`
          : `Saved ${outcome.filename}.`;
      return;
    }
    if (outcome.cancelled) {
      messageTone = 'warn';
      message = 'Export cancelled — nothing was saved, so this does not count as a backup.';
      return;
    }
    messageTone = 'error';
    message = outcome.error ?? 'Export failed.';
  }
</script>

<section class="export-view">
  <header class="bar">
    <button type="button" class="btn ghost back" onclick={onBack}>← Back</button>
    <h1>Back up, restore &amp; import</h1>
    <span class="spacer"></span>
  </header>

  <div class="body">
    <p class="status-line" class:warn={status.urgency === 'gentle'} class:bad={status.urgency === 'never' || status.urgency === 'prominent'}>
      {backupLabel(status)}
      {#if settings.lastBackupFormat}<span class="dim">({settings.lastBackupFormat.toUpperCase()})</span>{/if}
    </p>

    <!-- JSON first: it is the canonical format, and the layout should say so. -->
    <section class="card primary-card">
      <div class="card-head">
        <h2>JSON backup</h2>
        <span class="tag recommended">Recommended</span>
      </div>
      <p class="desc">
        The complete logbook: every flight, every custom field, and your aircraft
        list. This is the file to keep — restoring from it gives you back exactly
        what you had.
      </p>
      <div class="actions">
        {#if shareSupported}
          <button type="button" class="btn primary" disabled={busy !== null} onclick={() => run('json', 'auto')}>
            {busy === 'json' ? 'Working…' : 'Share JSON'}
          </button>
          <button type="button" class="btn" disabled={busy !== null} onclick={() => run('json', 'download')}>
            Download
          </button>
        {:else}
          <button type="button" class="btn primary" disabled={busy !== null} onclick={() => run('json', 'download')}>
            {busy === 'json' ? 'Working…' : 'Download JSON'}
          </button>
        {/if}
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>CSV for spreadsheets</h2>
        <span class="tag">Interchange</span>
      </div>
      <p class="desc">
        For opening in Excel or Google Sheets, or moving your logbook into
        another app. <strong>Not a full backup.</strong> CSV is one flat table, so
        it leaves out your aircraft list and anything stored as a list or a
        group of values, and it writes times as decimal hours rather than the
        exact minutes held in the app. Spreadsheet programs may also reformat
        dates and drop leading zeros from registrations when they open the file.
      </p>
      <div class="actions">
        {#if shareSupported}
          <button type="button" class="btn" disabled={busy !== null} onclick={() => run('csv', 'auto')}>
            {busy === 'csv' ? 'Working…' : 'Share CSV'}
          </button>
          <button type="button" class="btn" disabled={busy !== null} onclick={() => run('csv', 'download')}>
            Download
          </button>
        {:else}
          <button type="button" class="btn" disabled={busy !== null} onclick={() => run('csv', 'download')}>
            {busy === 'csv' ? 'Working…' : 'Download CSV'}
          </button>
        {/if}
      </div>
      <p class="fineprint">
        Spreadsheet format: <strong>{settings.spreadsheetFormat === 'european' ? 'European' : 'Standard'}</strong>
        — change it in Settings.
      </p>
    </section>

    {#if message}
      <p class="result" class:warn={messageTone === 'warn'} class:error={messageTone === 'error'} role="status">
        {message}
      </p>
    {/if}

    {#if restoreDetails.length > 0}
      <ul class="details">
        {#each restoreDetails as detail, i (i)}
          <li>{detail}</li>
        {/each}
      </ul>
    {/if}

    {#if offerImport}
      <div class="offer">
        <p>
          Spreadsheets are handled by Import instead, which <strong>adds</strong> to
          your logbook rather than replacing it.
        </p>
        <button type="button" class="btn primary" onclick={onImport}>
          Go to Import from another logbook
        </button>
      </div>
    {/if}

    {#if warnings.length > 0}
      <div class="warnings" role="alert">
        <p class="w-head">Left out of the CSV:</p>
        <ul>
          {#each warnings as warning (warning.key)}
            <li>{warning.message}</li>
          {/each}
        </ul>
      </div>
    {/if}

    <!--
      Import. Between the exports and the restore, because that is where it sits
      on the risk scale: it changes the logbook, but only by ADDING. It shares
      this screen with restore so the "did you mean the other one?" offer each
      flow makes has somewhere to send the pilot.
    -->
    <!--
      Printing. A different KIND of export from the two above: those are for
      machines and this one is for a human, an inspector or a filing cabinet.
      It produces no file of its own — the browser's print dialog does, which is
      what keeps it working offline with no dependency.
    -->
    <section class="card">
      <div class="card-head">
        <h2>Print an EASA logbook</h2>
      </div>
      <p class="card-body">
        A facsimile of the official EASA logbook page, laid out to be printed and
        signed. Two landscape sheets per logbook page, eight flights each, with
        running totals carried forward. Save it as a PDF from your browser's print
        dialog if you want a file.
      </p>
      <button type="button" class="btn" disabled={busy !== null || restoring} onclick={onPrint}>
        Print logbook…
      </button>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Import from another logbook</h2>
        <span class="tag">Adds to your logbook</span>
      </div>
      <p class="desc">
        Bring in a CSV exported from a different logbook app. This
        <strong>adds</strong> to what you already have — nothing is replaced or
        removed. You choose what each column means, then see exactly what will be
        imported before anything is written.
      </p>
      <div class="actions">
        <button type="button" class="btn" disabled={busy !== null || restoring} onclick={onImport}>
          Import a CSV…
        </button>
      </div>
    </section>

    <!--
      Restore. Last, separated, and danger-toned: it belongs on this screen
      because it is the other half of the backup story, but it must never be
      mistaken for one of the export buttons above it.
    -->
    <section class="card danger-card">
      <div class="card-head">
        <h2>Restore from backup</h2>
        <span class="tag destructive">Replaces everything</span>
      </div>
      <p class="desc">
        Load a JSON backup written by this app — on a new phone, or after your
        browser cleared its storage. This <strong>replaces</strong> the logbook
        on this device rather than adding to it, and it cannot be undone. You
        will be shown exactly what is about to happen before anything changes.
      </p>
      <div class="actions">
        <input
          type="file"
          accept=".json,application/json"
          class="visually-hidden"
          bind:this={fileInput}
          onchange={onFileChosen}
        />
        <button
          type="button"
          class="btn danger"
          disabled={busy !== null || restoring}
          onclick={() => fileInput?.click()}
        >
          Choose a backup file…
        </button>
      </div>
    </section>

    <p class="note">
      Everything here happens on this device. Nothing is uploaded, and it works offline.
    </p>
  </div>
</section>

{#if pending}
  <RestoreConfirmDialog
    fileName={pending.fileName}
    summary={pending.summary}
    currentFlightCount={pending.currentFlights}
    currentAircraftCount={pending.currentAircraft}
    lastBackupAt={settings.lastBackupAt}
    busy={restoring}
    {backingUp}
    {backupMessage}
    onConfirm={confirmRestore}
    onCancel={cancelRestore}
    onBackupFirst={backupFirst}
  />
{/if}

<style>
  .export-view {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    min-height: 100dvh;
  }
  .bar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 0.6rem 0.9rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .bar h1 {
    margin: 0;
    font-size: 1.05rem;
    text-align: center;
    white-space: nowrap;
  }
  .bar .back {
    justify-self: start;
  }
  .body {
    width: 100%;
    max-width: 560px;
    margin: 0 auto;
    padding: 1.25rem 0.9rem 3rem;
  }
  .status-line {
    margin: 0 0 1rem;
    font-size: 0.9rem;
    color: var(--text-muted);
  }
  .status-line.warn {
    color: var(--night);
  }
  .status-line.bad {
    color: var(--danger);
    font-weight: 600;
  }
  .dim {
    color: var(--text-faint);
  }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1rem;
    background: var(--surface);
  }
  .card + .card {
    margin-top: 1rem;
  }
  .primary-card {
    border-color: var(--accent);
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.4rem;
  }
  .card h2 {
    margin: 0;
    font-size: 1rem;
  }
  .tag {
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-faint);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .tag.recommended {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .desc {
    margin: 0 0 0.9rem;
    color: var(--text-muted);
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .fineprint {
    margin: 0.8rem 0 0;
    font-size: 0.8rem;
    color: var(--text-faint);
  }
  .result {
    margin: 1rem 0 0;
    padding: 0.6rem 0.8rem;
    border-radius: var(--radius);
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 0.9rem;
  }
  .result.warn {
    background: color-mix(in srgb, var(--night) 14%, transparent);
    color: var(--night);
  }
  .result.error {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .warnings {
    margin-top: 0.8rem;
    padding: 0.7rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
  }
  .w-head {
    margin: 0 0 0.4rem;
    font-size: 0.85rem;
    font-weight: 650;
  }
  .warnings ul {
    margin: 0;
    padding-left: 1.1rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .offer {
    margin: 0 0 1rem;
    padding: 0.85rem;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: var(--accent-soft);
  }
  .offer p {
    margin: 0 0 0.6rem;
    font-size: 0.9rem;
  }
  .details {
    margin: 0.6rem 0 0;
    padding-left: 1.1rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  /* Restore sits apart from the export cards — a different kind of action. */
  .danger-card {
    margin-top: 2rem;
    border-color: var(--danger);
  }
  .tag.destructive {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  .note {
    margin: 1.5rem 0 0;
    color: var(--text-faint);
    font-size: 0.85rem;
    text-align: center;
  }
</style>
