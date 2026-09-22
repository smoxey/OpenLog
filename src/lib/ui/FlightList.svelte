<script lang="ts">
  import { FIELDS } from '../registry/fields';
  import { listFlights, getTotals, type Flight } from '../storage';
  import { settings, setShowSimulatorEntries } from '../stores/settings.svelte';
  import { backupStatus, backupLabel } from '../export/backupStatus';
  import { applyOpeningBalance, isEmptyOpeningBalance } from '../domain/openingBalance';
  import {
    EMPTY_CRITERIA,
    filterFlights,
    isEmptyCriteria,
    type FilterCriteria,
  } from '../domain/filter';
  import { formatDuration, formatCell } from '../format';

  interface Props {
    onAdd: () => void;
    onEdit: (id: string) => void;
    onSettings: () => void;
    onExport: () => void;
    onTotals: () => void;
    onTools: () => void;
    onCount?: (count: number) => void;
  }

  let {
    onAdd,
    onEdit,
    onSettings,
    onExport,
    onTotals,
    onTools,
    onCount = () => {},
  }: Props = $props();

  const mode = $derived(settings.durationDisplay);
  const clock = $derived(settings.clockDisplay);

  /** Everything in storage. */
  let allFlights = $state<Flight[]>([]);
  let flightTotals = $state<Record<string, number>>({});

  /**
   * What the footer shows: this logbook's flights PLUS anything brought forward
   * from a previous one.
   *
   * The balance is included rather than left out so that the word "Total" means
   * the same thing here as it does in the totals view. It is an ALL-TIME figure,
   * which is the only kind a brought-forward balance can honestly join — see
   * `domain/openingBalance`.
   */
  const totals = $derived(
    isEmptyOpeningBalance(settings.openingBalance)
      ? flightTotals
      : applyOpeningBalance(flightTotals, settings.openingBalance),
  );
  const carriedForward = $derived(!isEmptyOpeningBalance(settings.openingBalance));
  let loading = $state(true);
  let isWide = $state(false);

  const simulatorCount = $derived(allFlights.filter((f) => f.entryType === 'fstd').length);

  // --- Search and filter ----------------------------------------------------
  //
  // Display state, and nothing more. It narrows what this list renders; storage
  // is untouched and the exporters read from storage, so a filtered-out flight
  // is still in every backup. The same rule the simulator toggle follows.
  let criteria = $state<FilterCriteria>({ ...EMPTY_CRITERIA });
  let showFilters = $state(false);
  const filtering = $derived(!isEmptyCriteria(criteria));

  /**
   * What the list SHOWS, in two steps.
   *
   * The simulator toggle first, then the filter ON TOP of it. Deliberately not
   * merged: they are different kinds of thing — one is a persisted preference
   * about what belongs in this list at all, the other is a question the pilot
   * is asking right now — and a filter that silently re-showed hidden simulator
   * entries would be surprising.
   *
   * `allFlights` is untouched by both. See the note on `showSimulatorEntries`.
   */
  const visible = $derived(
    settings.showSimulatorEntries
      ? allFlights
      : allFlights.filter((f) => f.entryType !== 'fstd'),
  );
  const flights = $derived(filtering ? filterFlights(visible, criteria) : visible);
  const totalVisible = $derived(visible.length);

  function clearFilters() {
    criteria = { ...EMPTY_CRITERIA };
  }

  // Re-window whenever the filter changes, so a narrowed list does not open
  // scrolled into a page of results that is no longer there.
  $effect(() => {
    void criteria;
    visibleCount = PAGE;
  });

  /**
   * Backup freshness. The prominent state links straight to the export action —
   * a warning that routes through a settings page is a warning people ignore.
   */
  const backup = $derived(backupStatus(settings.lastBackupAt, new Date(), allFlights.length));

  // Windowing: render a growing slice so 2,000+ flights stay smooth.
  const PAGE = 60;
  let visibleCount = $state(PAGE);
  const visibleFlights = $derived(flights.slice(0, visibleCount));

  async function load() {
    loading = true;
    // listFlights defaults to date descending, then off-block descending.
    const [f, t] = await Promise.all([listFlights(), getTotals()]);
    allFlights = f;
    flightTotals = t;
    visibleCount = PAGE;
    loading = false;
    onCount(f.length);
  }

  $effect(() => {
    const mq = window.matchMedia('(min-width: 720px)');
    isWide = mq.matches;
    const onChange = (e: MediaQueryListEvent) => (isWide = e.matches);
    mq.addEventListener('change', onChange);
    load();
    return () => mq.removeEventListener('change', onChange);
  });

  function loadMore() {
    if (visibleCount < flights.length) {
      visibleCount = Math.min(flights.length, visibleCount + PAGE);
    }
  }

  // Intersection sentinel action for pagination-on-scroll.
  function inview(node: HTMLElement, cb: () => void) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) cb();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }

  function nonzero(flight: Flight): { label: string; cls: string } | null {
    if (flight.nightMinutes > 0) return { label: `${formatDuration(flight.nightMinutes, mode)} night`, cls: 'night' };
    if (flight.picMinutes > 0) return { label: `PIC ${formatDuration(flight.picMinutes, mode)}`, cls: 'pic' };
    return null;
  }

  function onRowKey(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onEdit(id);
    }
  }
</script>

<section class="list-view">
  <header class="bar">
    <div class="title">
      <h1>Logbook</h1>
      {#if !loading}
        <span class="count">
          {flights.length} entr{flights.length === 1 ? 'y' : 'ies'}{!settings.showSimulatorEntries &&
          simulatorCount > 0
            ? ` · ${simulatorCount} simulator hidden`
            : ''}
        </span>
      {/if}
    </div>
    <div class="bar-actions">
      <!--
        Simulator visibility. Offered only once there is something to hide.
        This is a VIEW filter: hidden entries are still stored and still land in
        every JSON and CSV export.
      -->
      {#if !loading && simulatorCount > 0}
        <button
          type="button"
          class="btn ghost sim-toggle"
          class:off={!settings.showSimulatorEntries}
          aria-pressed={settings.showSimulatorEntries}
          title={settings.showSimulatorEntries
            ? `Hide ${simulatorCount} simulator ${simulatorCount === 1 ? 'entry' : 'entries'} from this list`
            : `Show ${simulatorCount} hidden simulator ${simulatorCount === 1 ? 'entry' : 'entries'}`}
          onclick={() => setShowSimulatorEntries(!settings.showSimulatorEntries)}
        >
          SIM
        </button>
      {/if}
      <button type="button" class="btn ghost" onclick={onTotals} aria-label="Totals and currency">Σ</button>
      <!--
        The toolbox: bulk changes to entries already written. Its own icon
        rather than a place in Settings, because everything behind it rewrites
        the logbook rather than changing how it is shown.
      -->
      <button type="button" class="btn ghost" onclick={onTools} aria-label="Toolbox">🔧</button>
      <button type="button" class="btn ghost" onclick={onExport} aria-label="Back up and export">⤓</button>
      <button type="button" class="btn ghost" onclick={onSettings} aria-label="Settings">⚙︎</button>
    </div>
  </header>

  <!--
    Backup indicator. Quiet under 7 days, gentle at 7-30, prominent past 30, and
    a distinct never-backed-up state once there is data worth losing. The whole
    strip is the button, and it goes straight to export.
  -->
  {#if !loading && backup.visible && backup.urgency !== 'quiet'}
    <button
      type="button"
      class="backup-strip"
      class:gentle={backup.urgency === 'gentle'}
      class:urgent={backup.urgency === 'never' || backup.urgency === 'prominent'}
      onclick={onExport}
    >
      <span class="b-text">
        {backupLabel(backup)}{backup.urgency === 'never' ? ' — your logbook exists only on this device' : ''}
      </span>
      <span class="b-cta">Back up →</span>
    </button>
  {/if}

  <!--
    Search. Offered only once there is enough to search through — a filter bar
    above three flights is furniture, not a feature.
  -->
  {#if !loading && totalVisible > 5}
    <div class="search">
      <div class="search-row">
        <input
          class="search-box"
          type="search"
          inputmode="search"
          autocomplete="off"
          placeholder="Search remarks, aerodromes, registration, type"
          aria-label="Search flights"
          bind:value={criteria.text}
        />
        <button
          type="button"
          class="btn ghost filters-toggle"
          class:on={showFilters || filtering}
          aria-expanded={showFilters}
          onclick={() => (showFilters = !showFilters)}
        >
          Filters
        </button>
      </div>

      {#if showFilters}
        <div class="filter-grid">
          <label class="f">
            <span>From</span>
            <input type="date" bind:value={criteria.from} />
          </label>
          <label class="f">
            <span>To</span>
            <input type="date" bind:value={criteria.to} />
          </label>
          <label class="f">
            <span>Type</span>
            <input type="text" placeholder="C172" bind:value={criteria.aircraftType} />
          </label>
          <label class="f">
            <span>Registration</span>
            <input type="text" placeholder="LN-ABC" bind:value={criteria.registration} />
          </label>
          <label class="f">
            <span>Aerodrome</span>
            <input type="text" placeholder="ENBR" bind:value={criteria.aerodrome} />
          </label>
        </div>
      {/if}

      <!--
        The count is always visible while filtering, so an over-narrow filter
        reads as a filter rather than as a logbook that has lost its flights.
      -->
      {#if filtering}
        <div class="filter-state" role="status">
          <span>
            Showing {flights.length} of {totalVisible}
            {totalVisible === 1 ? 'entry' : 'entries'}
          </span>
          <!--
            Offered here only while there is still a list to un-narrow. When
            nothing matched, the empty state below carries the way out, and two
            buttons with the same name on one screen is one too many.
          -->
          {#if flights.length > 0}
            <button type="button" class="linkish" onclick={clearFilters}>Clear filters</button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if loading}
    <p class="status">Loading…</p>
  {:else if flights.length === 0 && filtering}
    <!--
      Nothing MATCHED — which is a different thing from an empty logbook, and
      must never look like one.
    -->
    <div class="empty">
      <p class="big">No matches</p>
      <p class="sub">
        Nothing here matches that. Your {totalVisible}
        {totalVisible === 1 ? 'entry is' : 'entries are'} still in the logbook.
      </p>
      <button type="button" class="btn primary" onclick={clearFilters}>Clear filters</button>
    </div>
  {:else if flights.length === 0}
    <div class="empty">
      <p class="big">No flights yet</p>
      <p class="sub">Your logbook lives on this device. Start with your most recent flight.</p>
      <button type="button" class="btn primary" onclick={onAdd}>Add your first flight</button>
    </div>
  {:else}
    <div class="scroll">
      {#if isWide}
        <table class="logbook">
          <thead>
            <tr>
              {#each FIELDS as field (field.key)}
                <th class:num={field.type === 'durationMinutes' || field.type === 'count'}>
                  {field.label}
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each visibleFlights as flight (flight.id)}
              <tr
                role="button"
                tabindex="0"
                onclick={() => onEdit(flight.id)}
                onkeydown={(e) => onRowKey(e, flight.id)}
              >
                {#each FIELDS as field (field.key)}
                  <td
                    class:num={field.type === 'durationMinutes' || field.type === 'count'}
                    class:icao={field.type === 'icao'}
                    class:remarks={field.type === 'remarks'}
                  >
                    {formatCell(flight, field, mode, clock)}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <ul class="cards">
          {#each visibleFlights as flight (flight.id)}
            {@const badge = nonzero(flight)}
            {@const fstd = flight.entryType === 'fstd'}
            <li>
              <button type="button" class="card" onclick={() => onEdit(flight.id)}>
                <span class="c-date mono">{flight.date}</span>
                <!--
                  A simulator session has no route and no registration, so the
                  card shows what it does have: the device and its type.
                -->
                <span class="c-route mono">
                  {#if fstd}<b>Simulator</b>{:else}<b>{flight.depAerodrome}</b> → <b>{flight.arrAerodrome}</b>{/if}
                </span>
                <span class="c-reg mono">{fstd ? flight.simulatorRegistration : flight.registration}</span>
                <span class="c-total mono">
                  {formatDuration(fstd ? flight.simulatorMinutes : flight.totalMinutes, mode)}
                </span>
                {#if fstd}
                  <span class="c-badge sim">SIM</span>
                {:else if badge}
                  <span class="c-badge {badge.cls}">{badge.label}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if visibleCount < flights.length}
        <div class="sentinel" use:inview={loadMore}>Loading more…</div>
      {/if}
    </div>

    <footer class="totals" aria-label="Totals" title={carriedForward
      ? 'Includes hours brought forward from a previous logbook'
      : undefined}>
      {#if carriedForward}
        <!-- Said out loud, not implied. A figure a pilot cannot account for is
             worse than one they have to read a note about. -->
        <span class="bf" aria-label="Includes brought-forward hours">+bf</span>
      {/if}
      <div class="t"><span class="k">Total</span><span class="v mono">{formatDuration(totals.totalMinutes ?? 0, mode)}</span></div>
      <div class="t"><span class="k">PIC</span><span class="v mono">{formatDuration(totals.picMinutes ?? 0, mode)}</span></div>
      <div class="t"><span class="k">Multi</span><span class="v mono">{formatDuration(totals.multiPilotMinutes ?? 0, mode)}</span></div>
      <div class="t"><span class="k">Night</span><span class="v mono night">{formatDuration(totals.nightMinutes ?? 0, mode)}</span></div>
      <div class="t"><span class="k">Ldg D/N</span><span class="v mono">{totals.landingsDay ?? 0}/{totals.landingsNight ?? 0}</span></div>
    </footer>
  {/if}

  <button type="button" class="fab" onclick={onAdd} aria-label="Add flight">+</button>
</section>

<style>
  /* App shell: fixed-height column so .scroll is the only scrolling region.
     The bar and totals are flex items outside it, so they stay put without
     needing position: sticky. */
  .list-view {
    display: flex;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
  }
  .bar {
    flex: 0 0 auto;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 0.9rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .title {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
  }
  .bar h1 {
    margin: 0;
    font-size: 1.15rem;
  }
  .count {
    color: var(--text-faint);
    font-size: 0.85rem;
  }
  .bar-actions {
    display: flex;
    gap: 0.15rem;
  }
  .bar .btn.ghost {
    min-width: var(--touch);
    padding: 0;
    font-size: 1.2rem;
  }

  .search {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.55rem 0.9rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .search-row {
    display: flex;
    gap: 0.5rem;
  }
  .search-box {
    flex: 1;
    min-height: var(--touch);
    padding: 0 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.92rem;
  }
  .filters-toggle {
    flex: 0 0 auto;
  }
  .filters-toggle.on {
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 650;
  }
  .filter-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 9.5rem), 1fr));
    gap: 0.5rem;
  }
  .filter-grid .f {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .filter-grid .f span {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .filter-grid .f input {
    min-height: var(--touch);
    padding: 0 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.9rem;
  }
  .filter-state {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    font-size: 0.83rem;
    color: var(--text-muted);
  }
  .linkish {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
  }

  .backup-strip {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    width: 100%;
    min-height: var(--touch);
    padding: 0.5rem 0.9rem;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-muted);
    font-size: 0.85rem;
    text-align: left;
    transition: background var(--speed) ease;
  }
  .backup-strip.gentle {
    background: color-mix(in srgb, var(--night) 12%, transparent);
    color: var(--night);
  }
  .backup-strip.urgent {
    background: var(--danger-soft);
    color: var(--danger);
    font-weight: 600;
  }
  .backup-strip:hover {
    filter: brightness(0.98);
  }
  .b-text {
    min-width: 0;
  }
  .b-cta {
    flex: 0 0 auto;
    white-space: nowrap;
    text-decoration: underline;
  }
  .status {
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
  }
  .empty {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    padding: 2rem;
    text-align: center;
  }
  .empty .big {
    margin: 0;
    font-size: 1.4rem;
    font-weight: 650;
  }
  .empty .sub {
    margin: 0 0 0.6rem;
    max-width: 34ch;
    color: var(--text-muted);
  }

  .scroll {
    flex: 1 1 auto;
    /* Without min-height: 0 a flex item refuses to shrink below its content,
       so the container would grow instead of scrolling. */
    min-height: 0;
    overflow: auto;
    padding-bottom: 0.5rem;
  }

  /* Wide: paper-logbook table */
  table.logbook {
    border-collapse: collapse;
    width: 100%;
    min-width: 900px;
    font-size: 0.85rem;
  }
  .logbook thead th {
    position: sticky;
    /* Sticks to the top of .scroll, which starts below the app bar. */
    top: 0;
    z-index: 5;
    text-align: left;
    background: var(--surface-2);
    color: var(--text-muted);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .logbook th.num,
  .logbook td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-family: var(--mono);
  }
  .logbook td {
    padding: 0.55rem 0.6rem;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .logbook td.icao {
    font-family: var(--mono);
    font-weight: 600;
  }
  .logbook td.remarks {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-muted);
  }
  .logbook tbody tr {
    cursor: pointer;
    transition: background var(--speed) ease;
  }
  .logbook tbody tr:hover {
    background: var(--surface-2);
  }

  /* Narrow: compact cards */
  ul.cards {
    list-style: none;
    margin: 0;
    padding: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .card {
    width: 100%;
    display: grid;
    grid-template-columns: auto 1fr auto;
    grid-template-areas:
      'date route total'
      'reg  route badge';
    align-items: center;
    gap: 0.15rem 0.7rem;
    text-align: left;
    padding: 0.7rem 0.85rem;
    min-height: var(--touch);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    transition: background var(--speed) ease;
  }
  .card:hover {
    background: var(--surface-2);
  }
  .c-date {
    grid-area: date;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .c-route {
    grid-area: route;
    font-size: 1.05rem;
  }
  .c-reg {
    grid-area: reg;
    font-size: 0.8rem;
    color: var(--text-faint);
  }
  .c-total {
    grid-area: total;
    justify-self: end;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .c-badge {
    grid-area: badge;
    justify-self: end;
    font-size: 0.72rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .c-badge.night {
    color: var(--night);
    background: color-mix(in srgb, var(--night) 16%, transparent);
  }
  /* Deliberately muted rather than accent-coloured: a simulator session is not
     flight time, and the card should not compete with real flights for
     attention. */
  .c-badge.sim {
    color: var(--text-faint);
    background: color-mix(in srgb, var(--text-faint) 14%, transparent);
    letter-spacing: 0.04em;
  }

  .sim-toggle {
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    padding-inline: 0.5rem;
  }
  .sim-toggle.off {
    opacity: 0.45;
    text-decoration: line-through;
  }

  .sentinel {
    padding: 1rem;
    text-align: center;
    color: var(--text-faint);
    font-size: 0.85rem;
  }

  .totals {
    flex: 0 0 auto;
    z-index: 8;
    display: flex;
    gap: 0.4rem;
    overflow-x: auto;
    padding: 0.55rem 0.8rem;
    background: var(--surface);
    border-top: 1px solid var(--border);
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.05);
  }
  .totals .t {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    padding-right: 0.9rem;
    border-right: 1px solid var(--border);
    white-space: nowrap;
  }
  .totals .t:last-child {
    border-right: none;
  }
  .totals .bf {
    align-self: center;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--text-faint);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.1rem 0.3rem;
    margin-right: 0.2rem;
  }
  .totals .k {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-faint);
  }
  .totals .v {
    font-size: 1rem;
    font-weight: 650;
  }
  .totals .v.night {
    color: var(--night);
  }

  .fab {
    position: fixed;
    right: max(1rem, env(safe-area-inset-right));
    bottom: calc(3.6rem + env(safe-area-inset-bottom));
    z-index: 20;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: var(--accent-text);
    font-size: 2rem;
    line-height: 1;
    box-shadow: var(--shadow);
    transition: transform var(--speed) ease;
  }
  .fab:hover {
    transform: scale(1.05);
  }
  .fab:active {
    transform: scale(0.97);
  }
</style>
