<script lang="ts">
  /**
   * The totals view.
   *
   * Reads storage ONCE and computes everything from that snapshot: the range
   * selector, both breakdowns and the simulator figure are all `$derived`, so
   * switching range is arithmetic on data already in memory rather than a
   * round trip to IndexedDB.
   *
   * Every figure comes from `domain/totals`, which is pure and registry-driven.
   * Nothing here decides what a total is; this file decides how one looks.
   */
  import { SUMMABLE_FIELDS } from '../registry/fields';
  import { getAllFlights, type Flight } from '../storage';
  import {
    computeTotals,
    groupTotals,
    RANGE_KEYS,
    RANGE_LABELS,
    type RangeKey,
    type TotalsSet,
  } from '../domain/totals';
  import { applyOpeningBalance, isEmptyOpeningBalance } from '../domain/openingBalance';
  import {
    REQUIRED_LANDINGS,
    currencyReport,
    type CurrencyGroup,
  } from '../domain/currency';
  import { settings } from '../stores/settings.svelte';
  import { formatDuration } from '../format';

  interface Props {
    onBack: () => void;
    onSettings: () => void;
  }

  let { onBack, onSettings }: Props = $props();

  const mode = $derived(settings.durationDisplay);

  let flights = $state<Flight[]>([]);
  let loading = $state(true);
  let range = $state<RangeKey>('allTime');
  let showByType = $state(false);
  let showByRegistration = $state(false);

  /**
   * "Now" is read once when the view opens rather than on every recompute, so
   * a range cannot shift under the pilot while they are reading it.
   */
  let now = $state.raw(new Date());

  $effect(() => {
    let cancelled = false;
    (async () => {
      const all = await getAllFlights();
      if (cancelled) return;
      flights = all;
      now = new Date();
      loading = false;
    })();
    return () => {
      cancelled = true;
    };
  });

  const balance = $derived(settings.openingBalance);
  const hasBalance = $derived(!isEmptyOpeningBalance(balance));

  /** All time is the ONLY range a brought-forward figure can honestly join. */
  const showsBalance = $derived(range === 'allTime' && hasBalance);

  const computed = $derived(computeTotals(flights, range, now));

  /*
    Currency is NOT scoped by the range selector. FCL.060(b)(1) is a 90-day
    rule and nothing else; letting the selector change it would produce a
    figure that looks like a currency and is not one.
  */
  const currency = $derived(currencyReport(flights, now));

  /** What to call a currency group on screen. */
  function currencyLabel(group: CurrencyGroup): string {
    switch (group.kind) {
      case 'SE':
        return 'Single-engine';
      case 'ME':
        return 'Multi-engine';
      case 'MP':
        return `${group.typeDesignator || 'Unknown type'} (multi-pilot)`;
      default:
        return 'Entries with no clear class';
    }
  }

  /** What the flights themselves add up to, before anything is carried forward. */
  const flightTotals = $derived(computed.totals);

  /** What the pilot's logbook says in total — brought forward included. */
  const grandTotals = $derived(
    showsBalance ? applyOpeningBalance(flightTotals, balance) : flightTotals,
  );

  const byType = $derived(showByType ? groupTotals(inRangeFlights(), 'aircraftType') : []);
  const byRegistration = $derived(
    showByRegistration ? groupTotals(inRangeFlights(), 'registration') : [],
  );

  /** The records the current range covers — the same set every figure above uses. */
  function inRangeFlights(): Flight[] {
    const { from, to } = computed.window;
    if (from === null && to === null) return flights;
    return flights.filter((f) => {
      const date = f.date;
      if (typeof date !== 'string') return false;
      if (from !== null && date < from) return false;
      if (to !== null && date > to) return false;
      return true;
    });
  }

  /** Format one figure the way its registry type asks for. */
  function show(totals: TotalsSet, key: string, type: string): string {
    const value = totals[key] ?? 0;
    return type === 'count' ? String(value) : formatDuration(value, mode);
  }

  const isEmptyLogbook = $derived(!loading && flights.length === 0 && !hasBalance);
</script>

<section class="totals-view">
  <header class="bar">
    <button type="button" class="btn ghost back" onclick={onBack}>← Back</button>
    <h1>Totals</h1>
    <span class="spacer"></span>
  </header>

  <div class="body">
    {#if loading}
      <p class="muted">Adding it up…</p>
    {:else if isEmptyLogbook}
      <!--
        A new logbook. Zeros would be honest but unhelpful; what a pilot in this
        position actually needs is the way to enter what they already have.
      -->
      <div class="empty">
        <p>No flights logged yet, so every total here is zero.</p>
        <p class="muted">
          Already flying? Enter the hours from your previous logbook and they will be
          included in your all-time totals.
        </p>
        <button type="button" class="btn primary" onclick={onSettings}>
          Add a previous logbook total
        </button>
      </div>
    {:else}
      <!--
        Currency first: it is the question a pilot opens this screen to answer,
        and it is the only figure here with a real-world consequence.
      -->
      <section class="currency">
        <h2>Passenger-carrying currency</h2>
        {#if currency.groups.length === 0}
          <p class="muted small">
            No landings in the last 90 days, so no currency is held.
          </p>
        {:else}
          <ul class="cur-list">
            {#each currency.groups as group (group.key)}
              <li class="cur" class:is-current={group.current} class:unclear={group.kind === 'unclassified'}>
                <span class="cur-name">{currencyLabel(group)}</span>
                {#if group.kind === 'unclassified'}
                  <span class="cur-state">
                    {group.landings}
                    {group.landings === 1 ? 'landing' : 'landings'} that count toward nothing
                  </span>
                  <span class="cur-note">
                    These entries do not say clearly whether they were single-engine,
                    multi-engine or multi-pilot, so they cannot be counted. Open them and set
                    the time columns to fix it.
                  </span>
                {:else if group.current}
                  <span class="cur-state">
                    Current · {group.landings} landings · until
                    <span class="mono">{group.currentUntil}</span>
                  </span>
                {:else}
                  <span class="cur-state">
                    Not current · {group.landings} of {REQUIRED_LANDINGS} ·
                    {group.shortfall} more needed
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        {#if currency.skipped.simulator > 0}
          <p class="muted small">
            {currency.skipped.simulator} simulator
            {currency.skipped.simulator === 1 ? 'session' : 'sessions'} in this period counted
            toward nothing. Simulator landings do not satisfy the rule.
          </p>
        {/if}
        {#if currency.skipped.future > 0}
          <p class="muted small">
            {currency.skipped.future}
            {currency.skipped.future === 1 ? 'entry is' : 'entries are'} dated in the future and
            counted toward nothing.
          </p>
        {/if}
        <!--
          The disclaimer is not boilerplate. An app that says "current" when the
          regulation says otherwise is a flight-safety problem, and the pilot is
          the one who carries that responsibility.
        -->
        <p class="disclaimer">
          Calculated from what you have logged: 3 take-offs and landings in the last 90 days
          in the same class or type (EASA FCL.060(b)(1)). <strong
            >Take-offs are counted from your landings</strong
          >, since a logbook records only landings. This is a convenience, not an
          authority — you remain responsible for your own currency.
        </p>
      </section>

      <div class="ranges" role="group" aria-label="Date range">
        {#each RANGE_KEYS as key (key)}
          <button
            type="button"
            class="range"
            class:selected={range === key}
            aria-pressed={range === key}
            onclick={() => (range = key)}
          >
            {RANGE_LABELS[key]}
          </button>
        {/each}
      </div>

      <p class="scope muted">
        {computed.flightCount}
        {computed.flightCount === 1 ? 'flight' : 'flights'}
        {#if computed.window.from !== null}
          from <span class="mono">{computed.window.from}</span> to
          <span class="mono">{computed.window.to}</span>
        {:else}
          in the whole logbook
        {/if}
      </p>

      <!--
        The figures. Three columns when a brought-forward balance is in play, so
        a pilot can always see which part of a number came from where — one
        column would be a figure they cannot check against anything.
      -->
      <table class="figures">
        <thead>
          <tr>
            <th scope="col" class="name">Column</th>
            {#if showsBalance}
              <th scope="col" class="num">Brought forward</th>
              <th scope="col" class="num">This logbook</th>
            {/if}
            <th scope="col" class="num total-col">Total</th>
          </tr>
        </thead>
        <tbody>
          {#each SUMMABLE_FIELDS as field (field.key)}
            <tr>
              <th scope="row" class="name">{field.label}</th>
              {#if showsBalance}
                <td class="num mono faint">{show(balance, field.key, field.type)}</td>
                <td class="num mono faint">{show(flightTotals, field.key, field.type)}</td>
              {/if}
              <td class="num mono total-col">{show(grandTotals, field.key, field.type)}</td>
            </tr>
          {/each}
        </tbody>
      </table>

      {#if hasBalance && range !== 'allTime'}
        <p class="note muted">
          Your previous logbook total is not included here. Brought-forward hours have no
          dates, so they can only be counted in the all-time figures.
        </p>
      {/if}

      <!--
        Simulator time. Its own block, outside the table, because it is NOT
        flight time and must never look like a line of one. See the entry-type
        rule in `Claude Context/HOW_IT_WORKS.md`.
      -->
      {#if computed.simulator.sessionCount > 0}
        <section class="sim">
          <h2>Simulator</h2>
          <p class="sim-figure">
            <span class="mono">{formatDuration(computed.simulator.sessionMinutes, mode)}</span>
            across {computed.simulator.sessionCount}
            {computed.simulator.sessionCount === 1 ? 'session' : 'sessions'}
          </p>
          <p class="muted small">
            Simulator time is never flight time. It is not part of any figure above, and it
            counts toward no currency.
          </p>
        </section>
      {/if}

      <!-- Breakdowns, collapsed: useful, and not what the screen is for. -->
      <details class="breakdown" bind:open={showByType}>
        <summary>By aircraft type</summary>
        {#if byType.length === 0}
          <p class="muted small">Nothing in this range.</p>
        {:else}
          <table class="figures compact">
            <thead>
              <tr>
                <th scope="col" class="name">Type</th>
                <th scope="col" class="num">Flights</th>
                <th scope="col" class="num">Total</th>
                <th scope="col" class="num">PIC</th>
              </tr>
            </thead>
            <tbody>
              {#each byType as group (group.key)}
                <tr>
                  <th scope="row" class="name mono">{group.key || '—'}</th>
                  <td class="num mono">{group.flightCount}</td>
                  <td class="num mono">{formatDuration(group.totals.totalMinutes ?? 0, mode)}</td>
                  <td class="num mono">{formatDuration(group.totals.picMinutes ?? 0, mode)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </details>

      <details class="breakdown" bind:open={showByRegistration}>
        <summary>By registration</summary>
        {#if byRegistration.length === 0}
          <p class="muted small">Nothing in this range.</p>
        {:else}
          <table class="figures compact">
            <thead>
              <tr>
                <th scope="col" class="name">Registration</th>
                <th scope="col" class="num">Flights</th>
                <th scope="col" class="num">Total</th>
                <th scope="col" class="num">PIC</th>
              </tr>
            </thead>
            <tbody>
              {#each byRegistration as group (group.key)}
                <tr>
                  <th scope="row" class="name mono">{group.key || '—'}</th>
                  <td class="num mono">{group.flightCount}</td>
                  <td class="num mono">{formatDuration(group.totals.totalMinutes ?? 0, mode)}</td>
                  <td class="num mono">{formatDuration(group.totals.picMinutes ?? 0, mode)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </details>

      {#if !hasBalance}
        <p class="note muted">
          Flown before this logbook began? <button type="button" class="linkish" onclick={onSettings}
            >Add your previous totals</button
          > and they will be included in the all-time figures.
        </p>
      {/if}
    {/if}
  </div>
</section>

<style>
  .totals-view {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    background: var(--bg);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--gap);
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    position: sticky;
    top: 0;
    z-index: 2;
  }
  .bar h1 {
    margin: 0;
    font-size: 1.05rem;
  }
  .spacer {
    flex: 1;
  }
  .back {
    flex: 0 0 auto;
  }
  .body {
    padding: 1rem 0.9rem 3rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 46rem;
    width: 100%;
    margin: 0 auto;
  }

  .ranges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .range {
    flex: 1 1 auto;
    min-height: var(--touch);
    padding: 0 0.8rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font-size: 0.9rem;
    cursor: pointer;
  }
  .range.selected {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
    font-weight: 650;
  }

  .scope {
    margin: 0;
    font-size: 0.85rem;
  }

  .currency {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    padding: 0.8rem 0.9rem;
  }
  .currency h2 {
    margin: 0 0 0.6rem;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .cur-list {
    margin: 0 0 0.6rem;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .cur {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding-left: 0.7rem;
    border-left: 3px solid var(--danger);
  }
  .cur.is-current {
    border-left-color: var(--accent);
  }
  .cur.unclear {
    border-left-color: var(--night);
  }
  .cur-name {
    font-weight: 650;
    font-size: 0.93rem;
  }
  .cur-state {
    font-size: 0.87rem;
    color: var(--text-muted);
  }
  .cur-note {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .disclaimer {
    margin: 0;
    font-size: 0.78rem;
    line-height: 1.45;
    color: var(--text-muted);
    border-top: 1px solid var(--border);
    padding-top: 0.55rem;
  }

  .figures {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .figures th,
  .figures td {
    padding: 0.5rem 0.7rem;
    text-align: left;
    font-size: 0.9rem;
    border-bottom: 1px solid var(--border);
  }
  .figures tbody tr:last-child th,
  .figures tbody tr:last-child td {
    border-bottom: none;
  }
  .figures thead th {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    background: var(--surface-2);
  }
  .figures .name {
    font-weight: 600;
  }
  .figures .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .figures .faint {
    color: var(--text-muted);
  }
  .figures .total-col {
    font-weight: 650;
  }
  .figures.compact th,
  .figures.compact td {
    padding: 0.4rem 0.6rem;
    font-size: 0.85rem;
  }

  .sim {
    border: 1px dashed var(--border);
    border-radius: var(--radius-lg);
    padding: 0.7rem 0.85rem;
    background: var(--surface-2);
  }
  .sim h2 {
    margin: 0 0 0.3rem;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .sim-figure {
    margin: 0 0 0.35rem;
    font-size: 0.95rem;
  }

  .breakdown {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    padding: 0.5rem 0.7rem;
  }
  .breakdown summary {
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 600;
    min-height: 1.8rem;
    display: flex;
    align-items: center;
  }
  .breakdown .figures {
    margin-top: 0.5rem;
    border: none;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 1.2rem 0;
  }
  .empty p {
    margin: 0;
  }

  .note {
    margin: 0;
    font-size: 0.83rem;
  }
  .muted {
    color: var(--text-muted);
  }
  .small {
    font-size: 0.8rem;
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
</style>
