<script lang="ts">
  import {
    settings,
    setDurationDisplay,
    setDefaultAircraftClass,
    setSpreadsheetFormat,
    setOpeningBalance,
    setAutoNight,
    setClockDisplay,
  } from '../stores/settings.svelte';
  import { SUMMABLE_FIELDS } from '../registry/fields';
  import { isEmptyOpeningBalance } from '../domain/openingBalance';
  import DurationInput from './DurationInput.svelte';
  import CountStepper from './CountStepper.svelte';
  import type { AircraftClass } from '../domain/aircraft';
  import type { SpreadsheetFormat } from '../export/types';
  import type { DurationDisplay } from '../format';
  import type { ClockDisplay } from '../time/timeOfDay';

  import { refreshSettings } from '../stores/settings.svelte';
  import { deleteAllData, getAllAircraft, listFlights } from '../storage';
  import { exportLogbook } from '../export/service';
  import DeleteAllDialog from './DeleteAllDialog.svelte';

  interface Props {
    onBack: () => void;
    onExport: () => void;
    /** Called after a deletion so the list and its counts refresh. */
    onDataDeleted?: () => void;
  }

  let { onBack, onExport, onDataDeleted }: Props = $props();

  // --- Delete everything ----------------------------------------------------
  // Three steps, like restore: read the counts, SHOW WHAT WILL HAPPEN, then
  // write. Nothing is touched until the dialog is confirmed.
  let showDelete = $state(false);
  let deleting = $state(false);
  let deleteMessage = $state('');
  let backingUp = $state(false);
  let backupMessage = $state('');
  /** Counts read when the dialog opens, so it states what is actually here. */
  let pendingCounts = $state.raw({ flights: 0, aircraft: 0 });

  async function openDeleteDialog() {
    const [flights, aircraft] = await Promise.all([listFlights(), getAllAircraft()]);
    pendingCounts = { flights: flights.length, aircraft: aircraft.length };
    deleteMessage = '';
    backupMessage = '';
    showDelete = true;
  }

  /** The way out: save what is here before destroying it, without losing the dialog. */
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

  async function confirmDelete() {
    if (deleting) return;
    deleting = true;
    const outcome = await deleteAllData();
    deleting = false;
    showDelete = false;

    if (!outcome.ok) {
      deleteMessage = outcome.error ?? 'Nothing was deleted.';
      return;
    }
    await refreshSettings();
    deleteMessage =
      `Deleted ${outcome.flightCount} ${outcome.flightCount === 1 ? 'flight' : 'flights'} ` +
      `and ${outcome.aircraftCount} ${outcome.aircraftCount === 1 ? 'aircraft' : 'aircraft'}.`;
    onDataDeleted?.();
  }

  // --- Opening balance ------------------------------------------------------
  //
  // One input per SUMMABLE field, in registry order — the same set every total
  // is built from, so a future column appears here without an edit. Values are
  // integer minutes and integer counts, exactly as the records hold them.
  const balanceFields = SUMMABLE_FIELDS;

  /**
   * A working copy, seeded from the stored balance.
   *
   * Absent keys read as zero, and zeros are dropped again on save, so an empty
   * balance keeps its single representation in storage.
   */
  let balanceDraft = $state<Record<string, number>>(
    Object.fromEntries(balanceFields.map((f) => [f.key, settings.openingBalance[f.key] ?? 0])),
  );
  let balanceSaved = $state(false);
  const hasBalance = $derived(!isEmptyOpeningBalance(settings.openingBalance));

  async function saveBalance() {
    await setOpeningBalance($state.snapshot(balanceDraft));
    balanceSaved = true;
  }

  function clearBalance() {
    for (const field of balanceFields) balanceDraft[field.key] = 0;
    balanceSaved = false;
  }

  const formatOptions: { value: SpreadsheetFormat; label: string; example: string }[] = [
    { value: 'standard', label: 'Standard', example: '1,234  2.3' },
    { value: 'european', label: 'European', example: '1;234  2,3' },
  ];

  const options: { value: DurationDisplay; label: string; example: string }[] = [
    { value: 'decimal', label: 'Decimal hours', example: '2.3' },
    { value: 'hhmm', label: 'Hours : minutes', example: '2:18' },
  ];

  const clockOptions: { value: ClockDisplay; label: string; example: string }[] = [
    { value: '24h', label: '24-hour', example: '23:36' },
    { value: '12h', label: '12-hour (am/pm)', example: '11:36 PM' },
  ];

  const classOptions: { value: AircraftClass; label: string; example: string }[] = [
    { value: 'SE', label: 'Single-engine', example: 'SE' },
    { value: 'ME', label: 'Multi-engine', example: 'ME' },
  ];

  const nightOptions: { value: boolean; label: string; example: string }[] = [
    { value: true, label: 'Work it out for me', example: 'Filled in' },
    { value: false, label: 'I will enter it', example: 'Left blank' },
  ];
</script>

<section class="settings-view">
  <header class="bar">
    <button type="button" class="btn ghost back" onclick={onBack}>← Back</button>
    <h1>Settings</h1>
    <span class="spacer"></span>
  </header>

  <div class="body">
    <fieldset class="group">
      <legend>Duration display</legend>
      <p class="desc">How flight times are shown across the logbook.</p>
      <div class="options">
        {#each options as opt (opt.value)}
          <label class="option" class:selected={settings.durationDisplay === opt.value}>
            <input
              type="radio"
              name="durationDisplay"
              value={opt.value}
              checked={settings.durationDisplay === opt.value}
              onchange={() => setDurationDisplay(opt.value)}
            />
            <span class="label">{opt.label}</span>
            <span class="example mono">{opt.example}</span>
          </label>
        {/each}
      </div>
    </fieldset>

    <fieldset class="group">
      <legend>Clock</legend>
      <p class="desc">
        How times of day are shown, and how you type them into the entry form.
        Aviation runs on the 24-hour clock, and so does everything this app
        stores — the 12-hour option changes only what you read and write.
      </p>
      <div class="options">
        {#each clockOptions as opt (opt.value)}
          <label class="option" class:selected={settings.clockDisplay === opt.value}>
            <input
              type="radio"
              name="clockDisplay"
              value={opt.value}
              checked={settings.clockDisplay === opt.value}
              onchange={() => setClockDisplay(opt.value)}
            />
            <span class="label">{opt.label}</span>
            <span class="example mono">{opt.example}</span>
          </label>
        {/each}
      </div>
      <p class="desc footnote">
        Every record holds a 24-hour UTC time whatever this says, and both
        exports and the printed EASA page write it that way — a logbook page is
        a document other people read, not a view of your settings. The entry
        form accepts either spelling either way: type <span class="mono">2336</span>
        and it will land as 23:36.
      </p>
    </fieldset>

    <fieldset class="group">
      <legend>Assumed aircraft class</legend>
      <p class="desc">
        Used only when an aircraft's class is unknown and you skip the
        single/multi-engine prompt. A known aircraft always uses its own class.
      </p>
      <div class="options">
        {#each classOptions as opt (opt.value)}
          <label class="option" class:selected={settings.defaultAircraftClass === opt.value}>
            <input
              type="radio"
              name="defaultAircraftClass"
              value={opt.value}
              checked={settings.defaultAircraftClass === opt.value}
              onchange={() => setDefaultAircraftClass(opt.value)}
            />
            <span class="label">{opt.label}</span>
            <span class="example mono">{opt.example}</span>
          </label>
        {/each}
      </div>
      <p class="desc footnote">
        Changing this affects future entries only. Flights already logged keep
        the times they were saved with.
      </p>
    </fieldset>

    <fieldset class="group">
      <legend>Night time</legend>
      <p class="desc">
        Work night time out from the date, the block times and the two
        aerodromes, and put the landing in the day or night column to match.
        Night is the period between the end of evening civil twilight and the
        beginning of morning civil twilight, worked out along the great circle
        between the aerodromes and at sea level.
      </p>
      <div class="options">
        {#each nightOptions as opt (opt.value)}
          <label class="option" class:selected={settings.autoNight === opt.value}>
            <input
              type="radio"
              name="autoNight"
              value={String(opt.value)}
              checked={settings.autoNight === opt.value}
              onchange={() => setAutoNight(opt.value)}
            />
            <span class="label">{opt.label}</span>
            <span class="example">{opt.example}</span>
          </label>
        {/each}
      </div>
      <p class="desc footnote">
        A suggestion, never a decision: whatever the field holds when you save
        is what gets logged. Turning this off leaves the button on the night
        field, and changes nothing already in the logbook.
      </p>
    </fieldset>

    <fieldset class="group">
      <legend>Spreadsheet format</legend>
      <p class="desc">
        How CSV files are written, so they open correctly in your spreadsheet
        program. Standard uses a comma between columns and a dot for decimals;
        European uses a semicolon and a comma. This affects CSV only — JSON
        backups never change.
      </p>
      <div class="options">
        {#each formatOptions as opt (opt.value)}
          <label class="option" class:selected={settings.spreadsheetFormat === opt.value}>
            <input
              type="radio"
              name="spreadsheetFormat"
              value={opt.value}
              checked={settings.spreadsheetFormat === opt.value}
              onchange={() => setSpreadsheetFormat(opt.value)}
            />
            <span class="label">{opt.label}</span>
            <span class="example mono">{opt.example}</span>
          </label>
        {/each}
      </div>
    </fieldset>

    <!--
      Brought-forward totals. Behind a disclosure because most pilots enter it
      once and never open it again, and the settings page should not be long.
    -->
    <fieldset class="group">
      <legend>Previous logbook</legend>
      <p class="desc">
        Hours flown before this logbook began. Entered once, added to your
        <strong>all-time</strong> totals only — never to a date range, a breakdown by
        aircraft, or a currency calculation, because brought-forward hours have no
        dates to place them on.
      </p>
      {#if hasBalance}
        <p class="desc small" role="status">
          A previous logbook total is set. Your all-time figures include it.
        </p>
      {/if}
      <details class="balance">
        <summary>{hasBalance ? 'Edit brought-forward totals' : 'Add brought-forward totals'}</summary>
        <div class="balance-grid">
          {#each balanceFields as field (field.key)}
            <div class="balance-row">
              <label class="balance-label" for={`ob-${field.key}`}>{field.label}</label>
              {#if field.type === 'count'}
                <CountStepper id={`ob-${field.key}`} bind:value={balanceDraft[field.key]} />
              {:else}
                <DurationInput
                  id={`ob-${field.key}`}
                  mode={settings.durationDisplay}
                  bind:value={balanceDraft[field.key]}
                  onUserEdit={() => (balanceSaved = false)}
                />
              {/if}
            </div>
          {/each}
        </div>
        <div class="balance-actions">
          <button type="button" class="btn primary" onclick={saveBalance}>Save totals</button>
          <button type="button" class="btn ghost" onclick={clearBalance}>Clear</button>
          {#if balanceSaved}
            <span class="balance-saved" role="status">Saved.</span>
          {/if}
        </div>
        <p class="desc footnote">
          This travels in your JSON backup, so it survives a restore on a new device.
          It is not written to CSV.
        </p>
      </details>
    </fieldset>

    <fieldset class="group">
      <legend>Backup</legend>
      <p class="desc">
        Your logbook lives only on this device. Export a JSON backup regularly
        and keep it somewhere safe.
      </p>
      <button type="button" class="btn primary wide" onclick={onExport}>Back up &amp; export</button>
    </fieldset>

    <!--
      Danger zone. LAST on the screen, visually separated and danger-toned, so
      it can never be mistaken for one of the settings above it. The same
      reasoning that puts Restore at the bottom of the export panel.
    -->
    <fieldset class="group danger-group">
      <legend>Danger zone</legend>
      <p class="desc">
        <strong>Delete everything</strong> removes every flight and every aircraft
        from this device. There is no cloud copy and <strong>no undo</strong> — once
        it is gone, the only way back is a backup file you saved yourself.
      </p>
      <p class="desc small">
        Your display settings are kept. Only the logbook itself is deleted.
      </p>
      <button
        type="button"
        class="btn danger wide"
        disabled={deleting}
        onclick={openDeleteDialog}
      >
        Delete all data…
      </button>
      {#if deleteMessage}
        <p class="delete-result" role="status">{deleteMessage}</p>
      {/if}
    </fieldset>

    <p class="note">All data stays on this device. Nothing is uploaded.</p>
  </div>
</section>

{#if showDelete}
  <DeleteAllDialog
    flightCount={pendingCounts.flights}
    aircraftCount={pendingCounts.aircraft}
    lastBackupAt={settings.lastBackupAt}
    busy={deleting}
    {backingUp}
    {backupMessage}
    onConfirm={confirmDelete}
    onCancel={() => (showDelete = false)}
    onBackupFirst={backupFirst}
  />
{/if}

<style>
  .balance summary {
    cursor: pointer;
    font-size: 0.92rem;
    font-weight: 600;
    padding: 0.3rem 0;
  }
  .balance-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
    gap: 0.6rem 1rem;
    margin: 0.6rem 0 0.9rem;
  }
  .balance-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
  }
  .balance-label {
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .balance-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .balance-saved {
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .settings-view {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
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
  }
  .bar .back {
    justify-self: start;
  }
  .body {
    width: 100%;
    max-width: 560px;
    margin: 0 auto;
    padding: 1.25rem 0.9rem;
  }
  .group {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1rem;
    background: var(--surface);
  }
  .group + .group {
    margin-top: 1.25rem;
  }
  .desc.footnote {
    margin: 0.8rem 0 0;
    font-size: 0.82rem;
    color: var(--text-faint);
  }
  .btn.wide {
    width: 100%;
  }
  legend {
    padding: 0 0.4rem;
    font-weight: 650;
  }
  .desc {
    margin: 0 0 0.8rem;
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    min-height: var(--touch);
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    transition: border-color var(--speed) ease, background var(--speed) ease;
  }
  .option.selected {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .option .label {
    flex: 1 1 auto;
  }
  .option .example {
    color: var(--text-muted);
  }
  /*
    The danger zone reads as a warning before it is read at all: red border,
    red heading, extra separation from the settings above it.
  */
  .danger-group {
    margin-top: 2rem;
    border-color: var(--danger);
    background: var(--danger-soft);
  }
  .danger-group legend {
    color: var(--danger);
    font-weight: 700;
  }
  .desc.small {
    font-size: 0.78rem;
  }
  .delete-result {
    margin: 0.7rem 0 0;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--danger);
  }
  .note {
    margin: 1rem 0 0;
    color: var(--text-faint);
    font-size: 0.85rem;
    text-align: center;
  }
</style>
