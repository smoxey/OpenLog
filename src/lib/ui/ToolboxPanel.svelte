<script lang="ts">
  /**
   * The toolbox — bulk operations over a logbook that already exists.
   *
   * Everything in here rewrites records the pilot has already saved, which is
   * why it is behind its own icon rather than sitting among the ordinary
   * actions in the list bar. The shape is a list of cards, so a tool costs a
   * card rather than a rewrite — there are two now: filing time into a column
   * that was never recorded, and working out night time for flights logged
   * before the app could do it.
   *
   * BOTH CARDS ARE THE SAME SHAPE, and deliberately so: a scope, a date range,
   * a count, a reviewable list where every row can be unticked, and a
   * confirmation that states the change in concrete numbers. They make the same
   * promise about rewriting history, so they say it the same way. Each card is
   * a labelled region and its Apply names the tool it belongs to — two buttons
   * both reading "Apply" on one screen is a dead end for anyone not looking at
   * the pointer.
   *
   * The screen reads ONCE and plans against that snapshot: the affected count,
   * the sample and the warnings are all `$derived`, so changing the operation
   * is arithmetic on data already in memory rather than a round trip.
   *
   * Before anything is written the pilot can read the plan entry by entry — the
   * review list — and untick any row they meant to keep. That is why there are
   * two plans in here: `basePlan` is what the sentence selects and is what the
   * list renders, `plan` is that minus the unticked rows and is what the count,
   * the confirmation and the write all speak for.
   *
   * Nothing here decides what an adjustment is — `domain/bulkAdjust` does, and
   * it is pure. Nothing here writes — `storage/bulkAdjust` does, in one
   * transaction. This file decides how the question looks.
   */
  import {
    ADJUSTABLE_FIELDS,
    EMPTY_SPEC,
    excludeFromPlan,
    knownValues,
    planBulkAdjust,
    type BulkAdjustChange,
    type BulkAdjustPlan,
    type BulkAdjustSpec,
    type BulkAdjustTarget,
  } from '../domain/bulkAdjust';
  import {
    EMPTY_NIGHT_SPEC,
    excludeFromNightPlan,
    planBulkNight,
    type BulkNightChange,
    type BulkNightPlan,
    type BulkNightSpec,
  } from '../domain/bulkNight';
  import { applyBulkAdjust, applyBulkNight, getAllFlights, type Flight } from '../storage';
  import { loadAirports, type AirportIndex } from '../airports/lookup';
  import { settings } from '../stores/settings.svelte';
  import { formatDuration } from '../format';

  interface Props {
    onBack: () => void;
    /** Route to the export screen, so "back up first" is one tap rather than advice. */
    onExport: () => void;
  }

  let { onBack, onExport }: Props = $props();

  const mode = $derived(settings.durationDisplay);

  /**
   * `$state.raw`, not `$state`, and this is not a micro-optimisation.
   *
   * These records go back INTO storage — this screen reads the logbook, edits
   * records and writes them again, which no other view does. A deep `$state`
   * would hand `bulkPut` reactive proxies, and IndexedDB's structured clone
   * cannot serialise one. jsdom has no structured clone behind fake-indexeddb,
   * so every component test in this repo would pass while a real browser threw
   * — which is exactly the bug Prompt 3b-1 shipped. The whole array is replaced
   * on load rather than mutated, so raw costs nothing here anyway.
   */
  let flights = $state.raw<Flight[]>([]);
  let loading = $state(true);

  let spec = $state<BulkAdjustSpec>({ ...EMPTY_SPEC });
  /**
   * The date-range toggle is UI state, not part of the spec: an empty `from`
   * and `to` already mean "the whole logbook" to the planner. Keeping the
   * toggle separate lets a pilot flip back to "All entries" and then back again
   * without retyping the dates they had.
   */
  let limitByDate = $state(false);
  const effectiveSpec = $derived<BulkAdjustSpec>(
    limitByDate ? spec : { ...spec, from: '', to: '' },
  );

  let confirming = $state(false);
  let applying = $state(false);
  let error = $state<string | null>(null);
  let done = $state<string | null>(null);

  async function load() {
    loading = true;
    flights = await getAllFlights();
    loading = false;
  }

  $effect(() => {
    load();
  });

  /**
   * The plan the SENTENCE makes — every entry the three toggles select, whether
   * the pilot has since ticked it or not.
   *
   * The review list renders from this one rather than from `plan`, so unticking
   * a row greys it out instead of making it vanish from under the finger that
   * just unticked it, leaving no way to tick it back.
   */
  const basePlan = $derived(planBulkAdjust(flights, effectiveSpec));

  /**
   * The entries the pilot has unticked, by id.
   *
   * A plain `Set` replaced wholesale rather than a reactive one mutated in
   * place: this never goes near storage, and replacing it is the whole update.
   */
  let excluded = $state.raw<ReadonlySet<string>>(new Set());

  /** What will actually be written: the sentence, minus the unticked rows. */
  const plan = $derived(excludeFromPlan(basePlan, excluded));
  const runnable = $derived(!loading && plan.problem === undefined && plan.changes.length > 0);

  /** Whether every affected entry is on screen, or only the first few. */
  let reviewing = $state(false);

  /**
   * Editing the sentence clears the ticks, because they describe the list the
   * pilot was looking at when they made them. Carrying them across would mean a
   * row unticked under one aircraft type staying silently unticked under the
   * next — an entry quietly left out of a run the pilot believes covers all of
   * them, which is the one thing this screen must never do.
   */
  const specKey = $derived(JSON.stringify(effectiveSpec));
  $effect(() => {
    // Reading the key is the dependency; clearing the ticks is the effect.
    void specKey;
    excluded = new Set();
  });

  function toggle(id: string) {
    const next = new Set(excluded);
    // Present means unticked, so removing it is ticking it back on.
    if (!next.delete(id)) next.add(id);
    excluded = next;
  }

  /** Values actually present in the logbook, so an exact match is pickable. */
  const suggestions = $derived(knownValues(flights, spec.target));

  // --- Night time -----------------------------------------------------------
  /**
   * The second tool: work out night for flights already written down.
   *
   * Same three-part shape as the one above — a spec, a plan the sentence makes,
   * and that plan minus the rows the pilot has unticked — because it makes the
   * same promise and a pilot should not have to learn two vocabularies for one
   * idea. The airport list arrives as its own lazy chunk, so the card says so
   * while it is on its way rather than showing an empty plan.
   */
  let nightSpec = $state<BulkNightSpec>({ ...EMPTY_NIGHT_SPEC });
  let nightLimitByDate = $state(false);
  let nightAirports = $state<AirportIndex | null>(null);
  let nightExcluded = $state.raw<ReadonlySet<string>>(new Set());
  let nightReviewing = $state(false);
  let nightConfirming = $state(false);
  let nightApplying = $state(false);
  let nightError = $state<string | null>(null);
  let nightDone = $state<string | null>(null);

  $effect(() => {
    void loadAirports().then((index) => {
      nightAirports = index;
    });
  });

  const effectiveNightSpec = $derived<BulkNightSpec>(
    nightLimitByDate ? nightSpec : { ...nightSpec, from: '', to: '' },
  );

  const baseNightPlan = $derived(
    nightAirports
      ? planBulkNight(flights, effectiveNightSpec, (code) => nightAirports?.get(code))
      : null,
  );

  const nightPlan = $derived(
    baseNightPlan ? excludeFromNightPlan(baseNightPlan, nightExcluded) : null,
  );

  const nightRunnable = $derived(
    !loading &&
      nightPlan !== null &&
      nightPlan.problem === undefined &&
      nightPlan.changes.length > 0,
  );

  /** Editing the sentence clears the ticks — same rule, same reason, as above. */
  const nightSpecKey = $derived(JSON.stringify(effectiveNightSpec));
  $effect(() => {
    void nightSpecKey;
    nightExcluded = new Set();
  });

  function toggleNight(id: string) {
    const next = new Set(nightExcluded);
    if (!next.delete(id)) next.add(id);
    nightExcluded = next;
  }

  const nightVisible = $derived(
    baseNightPlan ? (nightReviewing ? baseNightPlan.changes : baseNightPlan.changes.slice(0, 5)) : [],
  );

  /** What one night tick means, said out loud for a screen reader. */
  function nightTickLabel(change: BulkNightChange): string {
    const { date, depAerodrome, arrAerodrome } = change.flight;
    return `Change night time on ${date} ${depAerodrome}–${arrAerodrome}`;
  }

  function resetNight() {
    nightSpec = { ...EMPTY_NIGHT_SPEC };
    nightLimitByDate = false;
    nightError = null;
  }

  async function runNight() {
    if (!nightPlan) return;
    nightConfirming = false;
    nightApplying = true;
    nightError = null;
    nightDone = null;
    const result = await applyBulkNight($state.snapshot(nightPlan) as BulkNightPlan);
    nightApplying = false;
    if (!result.ok) {
      nightError = result.error ?? 'The night times could not be written and nothing was changed.';
      return;
    }
    nightDone = `Night time written to ${result.changedCount} ${
      result.changedCount === 1 ? 'flight' : 'flights'
    }.`;
    await load();
    resetNight();
  }

  const field = $derived(plan.field);
  const fieldLabel = $derived(field?.label ?? 'time');
  const filling = $derived(spec.operation === 'add');

  /** The affected-entry sentence, which has to name what kind of entries they are. */
  const affectedLabel = $derived.by(() => {
    const parts: string[] = [];
    if (plan.changedFlightCount > 0) {
      parts.push(`${plan.changedFlightCount} flight${plan.changedFlightCount === 1 ? '' : 's'}`);
    }
    if (plan.changedFstdCount > 0) {
      parts.push(
        `${plan.changedFstdCount} simulator session${plan.changedFstdCount === 1 ? '' : 's'}`,
      );
    }
    return parts.join(' and ');
  });

  /** Distinct records carrying a mutually-exclusive clash, not one line per clash. */
  const clashCount = $derived(new Set(plan.exclusivityWarnings.map((w) => w.flight.id)).size);
  const clashLabels = $derived([
    ...new Set(plan.exclusivityWarnings.map((w) => w.otherLabel)),
  ]);

  /** A handful of real rows, so the pilot recognises their own flights. */
  const sample = $derived(basePlan.changes.slice(0, 5));

  /**
   * The rows on screen: the whole affected list while it is open for review,
   * the first few otherwise. Always off `basePlan`, so an unticked row stays
   * put and stays tickable.
   */
  const visible = $derived(reviewing ? basePlan.changes : sample);

  /** How an entry is identified in the list, and to a screen reader. */
  function identifierOf(change: BulkAdjustChange): string {
    return change.flight.registration || change.flight.simulatorRegistration || '—';
  }

  /**
   * What one tick means, said out loud. The row's own text would do as an
   * accessible name, but it would then read the before-and-after minutes as
   * part of the checkbox's label rather than as the change it guards.
   */
  function tickLabel(change: BulkAdjustChange): string {
    const { date, depAerodrome, arrAerodrome } = change.flight;
    return `Change ${date} ${identifierOf(change)} ${depAerodrome}–${arrAerodrome}`;
  }

  function setTarget(target: BulkAdjustTarget) {
    if (spec.target === target) return;
    // The value means a different thing under each target, so carrying "A320"
    // over into the registration box would silently match nothing.
    spec = { ...spec, target, value: '' };
  }

  function reset() {
    spec = { ...EMPTY_SPEC };
    limitByDate = false;
    error = null;
  }

  async function run() {
    confirming = false;
    applying = true;
    error = null;
    done = null;
    // Belt to the `$state.raw` braces: hand storage plain objects, never
    // reactive ones. `spec` IS a deep `$state`, and it rides along on the plan.
    // Unproxying is a Svelte concern, so it happens here rather than inside the
    // storage layer — the same place ImportPanel and ExportPanel do it.
    const result = await applyBulkAdjust($state.snapshot(plan) as BulkAdjustPlan);
    applying = false;
    if (!result.ok) {
      error = result.error ?? 'The adjustment failed and nothing was changed.';
      return;
    }
    done = `${result.changedCount} ${result.changedCount === 1 ? 'entry' : 'entries'} updated.`;
    // Re-read so the counts on this screen describe the logbook as it is now.
    await load();
    reset();
  }
</script>

<section class="toolbox">
  <header class="bar">
    <button type="button" class="btn ghost back" onclick={onBack}>← Back</button>
    <h1>Toolbox</h1>
    <span class="spacer"></span>
  </header>

  <div class="body">
    <p class="preamble">
      Bulk changes to a logbook you have already written. These rewrite saved entries,
      and there is no undo — <button type="button" class="linkish" onclick={onExport}>
        back up first
      </button>.
    </p>

    <section class="tool" aria-labelledby="tool-adjust">
      <h2 id="tool-adjust">Bulk adjust time</h2>
      <p class="muted small">
        Files an aircraft's flights into a time column that was never recorded — the
        multi-pilot and multi-engine time missing from an imported logbook, for example.
      </p>

      {#if loading}
        <p class="muted">Reading the logbook…</p>
      {:else}
        <!-- 1. What to do, and to which column. -->
        <div class="row">
          <div class="seg" role="group" aria-label="Operation">
            <button
              type="button"
              class="seg-btn"
              class:on={filling}
              aria-pressed={filling}
              onclick={() => (spec = { ...spec, operation: 'add' })}
            >
              Add
            </button>
            <button
              type="button"
              class="seg-btn"
              class:on={!filling}
              aria-pressed={!filling}
              onclick={() => (spec = { ...spec, operation: 'remove' })}
            >
              Remove
            </button>
          </div>

          <label class="pick">
            <span class="sr-only">Time column</span>
            <select bind:value={spec.fieldKey} aria-label="Time column">
              <option value="">Choose a time…</option>
              {#each ADJUSTABLE_FIELDS as f (f.key)}
                <option value={f.key}>{f.label}</option>
              {/each}
            </select>
          </label>
        </div>

        <!--
          What the two words mean, spelled out. An EASA logbook asks which
          column a flight's time belongs in, so "add" fills the column with the
          flight's own total rather than adding an amount to it — and a pilot
          should never have to infer that from a count.
        -->
        <p class="explain">
          {#if filling}
            <strong>Add</strong> puts each entry's whole time into the {fieldLabel} column.
          {:else}
            <strong>Remove</strong> sets the {fieldLabel} column to zero. The entry's total time
            is not touched.
          {/if}
        </p>

        <!--
          VFR is not an EASA logbook column and this app stores no such field.
          Saying so here is better than inventing one: a flight with no IFR time
          logged IS the VFR flight.
        -->
        <p class="muted small">
          There is no VFR column in an EASA logbook — time not logged as IFR is VFR. To mark
          flights as VFR, remove their IFR time.
        </p>

        <!-- 2. Which aircraft. -->
        <div class="row">
          <div class="seg" role="group" aria-label="Match by">
            <button
              type="button"
              class="seg-btn"
              class:on={spec.target === 'aircraftType'}
              aria-pressed={spec.target === 'aircraftType'}
              onclick={() => setTarget('aircraftType')}
            >
              Aircraft type
            </button>
            <button
              type="button"
              class="seg-btn"
              class:on={spec.target === 'registration'}
              aria-pressed={spec.target === 'registration'}
              onclick={() => setTarget('registration')}
            >
              Registration
            </button>
          </div>

          <label class="pick">
            <span class="sr-only">
              {spec.target === 'aircraftType' ? 'Aircraft type' : 'Registration'}
            </span>
            <input
              type="text"
              list="bulk-adjust-values"
              autocomplete="off"
              spellcheck="false"
              placeholder={spec.target === 'aircraftType' ? 'A320' : 'LN-ABC'}
              aria-label={spec.target === 'aircraftType' ? 'Aircraft type' : 'Registration'}
              bind:value={spec.value}
            />
            <datalist id="bulk-adjust-values">
              {#each suggestions as value (value)}
                <option {value}></option>
              {/each}
            </datalist>
          </label>
        </div>
        {#if spec.target === 'aircraftType'}
          <p class="explain">Every registration of that type is included.</p>
        {/if}

        <!-- 3. Over what period. -->
        <div class="row">
          <div class="seg" role="group" aria-label="Date range">
            <button
              type="button"
              class="seg-btn"
              class:on={!limitByDate}
              aria-pressed={!limitByDate}
              onclick={() => (limitByDate = false)}
            >
              All entries
            </button>
            <button
              type="button"
              class="seg-btn"
              class:on={limitByDate}
              aria-pressed={limitByDate}
              onclick={() => (limitByDate = true)}
            >
              Date range
            </button>
          </div>

          {#if limitByDate}
            <div class="dates">
              <label class="d">
                <span>From</span>
                <input type="date" bind:value={spec.from} />
              </label>
              <label class="d">
                <span>To</span>
                <input type="date" bind:value={spec.to} />
              </label>
            </div>
          {/if}
        </div>
        {#if limitByDate}
          <p class="explain">
            Only entries inside these dates are changed. Both ends are included, and an
            empty end is unbounded.
          </p>
        {/if}

        <!--
          The count, always. This is the whole safety mechanism of the tool: the
          pilot sees how much of their logbook the sentence they just built is
          about, before they can act on it.

          The guard is `basePlan.problem`, not `plan.problem`. Unticking every
          row is a problem too, but it is a problem whose fix is the list itself
          — hiding the list to report it would take away the ticks the pilot
          needs to get back.
        -->
        <div class="outcome" role="status" aria-label="Adjustment summary">
          {#if basePlan.problem !== undefined}
            <p class="muted">{basePlan.problem}</p>
          {:else}
            {#if plan.changes.length === 0}
              <p class="count">
                <strong>Nothing will change</strong>
                <span class="muted">— every entry below is unticked.</span>
              </p>
            {:else}
              <p class="count">
                <strong>{plan.changes.length}</strong>
                {plan.changes.length === 1 ? 'entry' : 'entries'} will change
                <span class="muted">({affectedLabel})</span>
              </p>
              <p class="muted small">
                {fieldLabel}: {formatDuration(plan.minutesBefore, mode)} → {formatDuration(
                  plan.minutesAfter,
                  mode,
                )}
                {#if plan.unchangedCount > 0}
                  · {plan.unchangedCount} matching
                  {plan.unchangedCount === 1 ? 'entry' : 'entries'} already read that way and
                  {plan.unchangedCount === 1 ? 'is' : 'are'} left alone
                {/if}
              </p>
            {/if}

            <!--
              The affected entries themselves, each behind a tick.

              Ticked from the start, because the sentence the pilot built IS the
              request — the ticks are there to take an entry out of it, not to
              make them build it twice. Unticking greys the row rather than
              removing it, and the row stays exactly where it was in the list.
            -->
            {#if visible.length > 0}
              <ul class="sample" class:reviewing>
                {#each visible as change (change.flight.id)}
                  {@const included = !excluded.has(change.flight.id)}
                  <li class:off={!included}>
                    <label class="tick">
                      <input
                        type="checkbox"
                        checked={included}
                        aria-label={tickLabel(change)}
                        onchange={() => toggle(change.flight.id)}
                      />
                      <span class="s-date">{change.flight.date}</span>
                      <span class="s-ac">{identifierOf(change)}</span>
                      <span class="s-route">
                        {change.flight.depAerodrome}–{change.flight.arrAerodrome}
                      </span>
                      <span class="s-val">
                        {formatDuration(change.before, mode)} → {formatDuration(
                          change.after,
                          mode,
                        )}
                      </span>
                    </label>
                  </li>
                {/each}
              </ul>

              <div class="review-bar">
                <!--
                  The whole list, on demand. Five rows tell a pilot the tool
                  found the right flights; only all of them tell them it found
                  no wrong ones, and that is the check worth having before a
                  write with no undo.
                -->
                <button
                  type="button"
                  class="linkish"
                  aria-expanded={reviewing}
                  onclick={() => (reviewing = !reviewing)}
                >
                  {reviewing
                    ? 'Show fewer'
                    : `Review all ${basePlan.changes.length} ${
                        basePlan.changes.length === 1 ? 'entry' : 'entries'
                      }`}
                </button>
                {#if !reviewing && basePlan.changes.length > visible.length}
                  <span class="muted small">
                    …and {basePlan.changes.length - visible.length} more.
                  </span>
                {/if}
                <span class="spacer"></span>
                {#if plan.excludedCount > 0}
                  <span class="muted small">
                    {plan.excludedCount} unticked and left
                    {plan.excludedCount === 1 ? 'as it is' : 'as they are'}
                  </span>
                  <button type="button" class="linkish" onclick={() => (excluded = new Set())}>
                    Tick all
                  </button>
                {/if}
              </div>
            {/if}

            <!--
              Advisory, never blocking. SE, ME and Multi-Pilot are three ways of
              filing one flight's time and a flight is only ever one of them —
              but this is the pilot's logbook and their claim to make.
            -->
            {#if clashCount > 0}
              <p class="warn">
                {clashCount}
                {clashCount === 1 ? 'entry' : 'entries'} would then hold both {fieldLabel} and
                {clashLabels.join(' / ')} time. An EASA logbook files a flight's time in one of
                those columns, not two — check that is what you mean.
              </p>
            {/if}
          {/if}
        </div>

        {#if error}
          <p class="error" role="alert">{error}</p>
        {/if}
        {#if done}
          <p class="done" role="status">{done}</p>
        {/if}

        <div class="actions">
          <button type="button" class="btn ghost" onclick={reset} disabled={applying} aria-label="Reset adjustment">
            Reset
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={!runnable || applying}
            onclick={() => (confirming = true)}
          >
            {applying ? 'Applying…' : 'Apply adjustment'}
          </button>
        </div>
      {/if}
    </section>

    <!--
      The second card: night time for flights already written down.

      Deliberately the same shape as the card above — scope, dates, a count, a
      reviewable list of ticks, a confirmation — because it makes the same
      promise about rewriting history and a pilot should not have to learn it
      twice.
    -->
    <section class="tool" aria-labelledby="tool-night">
      <h2 id="tool-night">Work out night time</h2>
      <p class="muted small">
        Works out night time from each flight's route and block times, the same way the entry
        form does — for the flights you logged before this app could. Every flight is shown
        with what it says now beside what the calculation makes it, and you decide one by one.
      </p>

      {#if loading}
        <p class="muted">Reading the logbook…</p>
      {:else if !baseNightPlan || !nightPlan}
        <p class="muted">Loading the airport list…</p>
      {:else}
        <!-- 1. Which flights. -->
        <div class="row">
          <div class="seg" role="group" aria-label="Which flights">
            <button
              type="button"
              class="seg-btn"
              class:on={nightSpec.scope === 'missing'}
              aria-pressed={nightSpec.scope === 'missing'}
              onclick={() => (nightSpec = { ...nightSpec, scope: 'missing' })}
            >
              Only flights with no night
            </button>
            <button
              type="button"
              class="seg-btn"
              class:on={nightSpec.scope === 'all'}
              aria-pressed={nightSpec.scope === 'all'}
              onclick={() => (nightSpec = { ...nightSpec, scope: 'all' })}
            >
              All flights
            </button>
          </div>
        </div>

        <p class="explain">
          {#if nightSpec.scope === 'missing'}
            <strong>Only flights with no night</strong> fills in blanks. A flight that already
            carries a night figure is never offered, so nothing you logged is overwritten.
          {:else}
            <strong>All flights</strong> also offers the flights that already have a night
            figure, so you can see where the calculation disagrees with what was logged — and
            keep whichever you want, flight by flight.
          {/if}
        </p>

        <!-- 2. Over what period. -->
        <div class="row">
          <div class="seg" role="group" aria-label="Night date range">
            <button
              type="button"
              class="seg-btn"
              class:on={!nightLimitByDate}
              aria-pressed={!nightLimitByDate}
              onclick={() => (nightLimitByDate = false)}
            >
              All entries
            </button>
            <button
              type="button"
              class="seg-btn"
              class:on={nightLimitByDate}
              aria-pressed={nightLimitByDate}
              onclick={() => (nightLimitByDate = true)}
            >
              Date range
            </button>
          </div>

          {#if nightLimitByDate}
            <div class="dates">
              <label class="d">
                <span>From</span>
                <input type="date" aria-label="Night from" bind:value={nightSpec.from} />
              </label>
              <label class="d">
                <span>To</span>
                <input type="date" aria-label="Night to" bind:value={nightSpec.to} />
              </label>
            </div>
          {/if}
        </div>

        <p class="muted small">
          Night time only. The day and night landing columns are not touched — that is a
          separate claim about a flight, and the entry form is where it belongs.
        </p>

        <div class="outcome" role="status" aria-label="Night time summary">
          {#if baseNightPlan.problem !== undefined}
            <p class="muted">{baseNightPlan.problem}</p>
          {:else}
            {#if nightPlan.changes.length === 0}
              <p class="count">
                <strong>Nothing will change</strong>
                <span class="muted">— every flight below is unticked.</span>
              </p>
            {:else}
              <p class="count">
                <strong>{nightPlan.changes.length}</strong>
                {nightPlan.changes.length === 1 ? 'flight' : 'flights'} will change
              </p>
              <p class="muted small">
                Night: {formatDuration(nightPlan.minutesBefore, mode)} → {formatDuration(
                  nightPlan.minutesAfter,
                  mode,
                )}
                {#if nightPlan.unchangedCount > 0}
                  · {nightPlan.unchangedCount}
                  {nightPlan.unchangedCount === 1 ? 'flight' : 'flights'} already
                  {nightPlan.unchangedCount === 1 ? 'reads' : 'read'} that way
                {/if}
              </p>
            {/if}

            {#if nightVisible.length > 0}
              <ul class="sample" class:reviewing={nightReviewing}>
                {#each nightVisible as change (change.flight.id)}
                  {@const included = !nightExcluded.has(change.flight.id)}
                  <li class:off={!included}>
                    <label class="tick">
                      <input
                        type="checkbox"
                        checked={included}
                        aria-label={nightTickLabel(change)}
                        onchange={() => toggleNight(change.flight.id)}
                      />
                      <span class="s-date">{change.flight.date}</span>
                      <span class="s-ac">
                        {change.flight.registration || change.flight.aircraftType || '—'}
                      </span>
                      <span class="s-route">
                        {change.flight.depAerodrome}–{change.flight.arrAerodrome}
                      </span>
                      <span class="s-val">
                        {formatDuration(change.before, mode)} → {formatDuration(change.after, mode)}
                        {#if change.grazing}
                          <span class="graze" title="The sun sat close to the horizon">·&nbsp;close</span>
                        {/if}
                      </span>
                    </label>
                  </li>
                {/each}
              </ul>

              <div class="review-bar">
                <button
                  type="button"
                  class="linkish"
                  aria-expanded={nightReviewing}
                  onclick={() => (nightReviewing = !nightReviewing)}
                >
                  {nightReviewing
                    ? 'Show fewer'
                    : `Review all ${baseNightPlan.changes.length} ${
                        baseNightPlan.changes.length === 1 ? 'flight' : 'flights'
                      }`}
                </button>
                {#if !nightReviewing && baseNightPlan.changes.length > nightVisible.length}
                  <span class="muted small">
                    …and {baseNightPlan.changes.length - nightVisible.length} more.
                  </span>
                {/if}
                <span class="spacer"></span>
                {#if nightPlan.excludedCount > 0}
                  <span class="muted small">
                    {nightPlan.excludedCount} unticked and
                    {nightPlan.excludedCount === 1 ? 'kept as it is' : 'kept as they are'}
                  </span>
                  <button
                    type="button"
                    class="linkish"
                    onclick={() => (nightExcluded = new Set())}
                  >
                    Tick all
                  </button>
                {/if}
              </div>
            {/if}

            <!--
              Overwriting a figure that is already there is the thing worth
              saying out loud, because it is the one case where accepting the
              calculation destroys something the pilot recorded.
            -->
            {#if nightPlan.overwriteCount > 0}
              <p class="warn">
                {nightPlan.overwriteCount}
                {nightPlan.overwriteCount === 1 ? 'flight' : 'flights'}
                already {nightPlan.overwriteCount === 1 ? 'has' : 'have'} a night figure that
                would be replaced. Untick any you want to keep.
              </p>
            {/if}
            {#if nightPlan.grazingCount > 0}
              <p class="muted small">
                On {nightPlan.grazingCount}
                {nightPlan.grazingCount === 1 ? 'flight' : 'flights'} the sun sat close to the
                horizon, where a minute either way is a judgement call. Marked
                <em>close</em> in the list.
              </p>
            {/if}
          {/if}

          <!--
            What it could NOT work out, always shown — a flight silently left
            out is indistinguishable from one worked out as zero.
          -->
          {#if baseNightPlan.skipped.length > 0}
            <p class="muted small skipped">
              {baseNightPlan.skipped.length}
              {baseNightPlan.skipped.length === 1 ? 'flight was' : 'flights were'} left out
              because night could not be worked out for
              {baseNightPlan.skipped.length === 1 ? 'it' : 'them'}.
              {#if baseNightPlan.missingAerodromes.length > 0}
                Not in the airport list: {baseNightPlan.missingAerodromes.slice(0, 8).join(', ')}{baseNightPlan
                  .missingAerodromes.length > 8
                  ? ` and ${baseNightPlan.missingAerodromes.length - 8} more`
                  : ''}.
              {/if}
            </p>
          {/if}
        </div>

        {#if nightError}
          <p class="error" role="alert">{nightError}</p>
        {/if}
        {#if nightDone}
          <p class="done" role="status">{nightDone}</p>
        {/if}

        <div class="actions">
          <button type="button" class="btn ghost" onclick={resetNight} disabled={nightApplying} aria-label="Reset night time">
            Reset
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={!nightRunnable || nightApplying}
            onclick={() => (nightConfirming = true)}
          >
            {nightApplying ? 'Applying…' : 'Apply night time'}
          </button>
        </div>
      {/if}
    </section>
  </div>
</section>

<!--
  The confirmation. Deliberately not the generic ConfirmDialog, for the same
  reason the restore dialog is not: it has to state the change in CONCRETE
  numbers, say plainly that there is no undo, and focus Cancel rather than the
  button that rewrites the logbook.
-->
{#if confirming}
  <div class="overlay" role="presentation" onclick={() => (confirming = false)}>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="dialog"
      role="alertdialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Confirm bulk adjustment"
      onclick={(e) => e.stopPropagation()}
    >
      <h2>Change {plan.changes.length} {plan.changes.length === 1 ? 'entry' : 'entries'}?</h2>
      <p>
        {#if filling}
          Each of {affectedLabel} on {spec.target === 'aircraftType' ? 'type' : ''}
          <strong>{spec.value.trim().toUpperCase()}</strong>
          will have its whole time filed as <strong>{fieldLabel}</strong>.
        {:else}
          <strong>{fieldLabel}</strong> will be set to zero on {affectedLabel} on
          {spec.target === 'aircraftType' ? 'type' : ''}
          <strong>{spec.value.trim().toUpperCase()}</strong>.
        {/if}
      </p>
      <p>
        {fieldLabel} across those entries goes from
        <strong>{formatDuration(plan.minutesBefore, mode)}</strong> to
        <strong>{formatDuration(plan.minutesAfter, mode)}</strong>.
        {#if limitByDate}
          Only entries between {spec.from || 'the start'} and {spec.to || 'the end'} are
          affected.
        {/if}
      </p>
      {#if plan.excludedCount > 0}
        <p>
          The {plan.excludedCount}
          {plan.excludedCount === 1 ? 'entry' : 'entries'} you unticked
          {plan.excludedCount === 1 ? 'is' : 'are'} not part of this and
          {plan.excludedCount === 1 ? 'stays' : 'stay'} exactly as
          {plan.excludedCount === 1 ? 'it is' : 'they are'}.
        </p>
      {/if}
      <p class="dialog-warn">
        This rewrites saved entries. There is no undo and no cloud copy — the only way back
        is a backup file.
      </p>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" onclick={onExport}>Back up first</button>
        <span class="spacer"></span>
        <!-- svelte-ignore a11y_autofocus -->
        <button type="button" class="btn ghost" autofocus onclick={() => (confirming = false)}>
          Cancel
        </button>
        <button type="button" class="btn primary" onclick={run}>Change them</button>
      </div>
    </div>
  </div>
{/if}

<!-- The same confirmation, for the night tool. Concrete numbers, no undo, Cancel focused. -->
{#if nightConfirming && nightPlan}
  <div class="overlay" role="presentation" onclick={() => (nightConfirming = false)}>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="dialog"
      role="alertdialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Confirm night time"
      onclick={(e) => e.stopPropagation()}
    >
      <h2>
        Write night time to {nightPlan.changes.length}
        {nightPlan.changes.length === 1 ? 'flight' : 'flights'}?
      </h2>
      <p>
        Night time worked out from each flight's route and block times will replace what those
        {nightPlan.changes.length === 1 ? 'flight holds' : 'flights hold'} now. Night across them
        goes from <strong>{formatDuration(nightPlan.minutesBefore, mode)}</strong> to
        <strong>{formatDuration(nightPlan.minutesAfter, mode)}</strong>.
        {#if nightLimitByDate}
          Only flights between {nightSpec.from || 'the start'} and {nightSpec.to || 'the end'} are
          affected.
        {/if}
      </p>
      {#if nightPlan.overwriteCount > 0}
        <p>
          <strong>{nightPlan.overwriteCount}</strong> of them already
          {nightPlan.overwriteCount === 1 ? 'carries a night figure' : 'carry a night figure'}
          that will be replaced.
        </p>
      {/if}
      {#if nightPlan.excludedCount > 0}
        <p>
          The {nightPlan.excludedCount}
          {nightPlan.excludedCount === 1 ? 'flight' : 'flights'} you unticked
          {nightPlan.excludedCount === 1 ? 'keeps' : 'keep'} what
          {nightPlan.excludedCount === 1 ? 'it holds' : 'they hold'} now.
        </p>
      {/if}
      <p>The day and night landing columns are not touched.</p>
      <p class="dialog-warn">
        This rewrites saved entries. There is no undo and no cloud copy — the only way back
        is a backup file.
      </p>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" onclick={onExport}>Back up first</button>
        <span class="spacer"></span>
        <!-- svelte-ignore a11y_autofocus -->
        <button
          type="button"
          class="btn ghost"
          autofocus
          onclick={() => (nightConfirming = false)}
        >
          Cancel
        </button>
        <button type="button" class="btn primary" onclick={runNight}>Write them</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .toolbox {
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
  }
  .preamble {
    margin: 0;
    font-size: 0.88rem;
    color: var(--text-muted);
  }
  .tool {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    padding: 1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .tool h2 {
    margin: 0;
    font-size: 1rem;
  }
  .muted {
    margin: 0;
    color: var(--text-muted);
  }
  .small {
    font-size: 0.82rem;
  }
  .explain {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .explain strong {
    color: var(--text);
  }
  /* Each decision is one row: the toggle, then what it applies to. Wrapping
     rather than a grid, so a narrow phone stacks the pair instead of squeezing
     a date input to nothing. */
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.7rem;
  }
  .pick {
    flex: 1 1 11rem;
    min-width: 0;
    display: flex;
  }
  .pick select,
  .pick input {
    width: 100%;
    min-height: var(--touch);
  }
  .dates {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .d {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .d input {
    min-height: var(--touch);
  }
  /* Same segmented control as the entry form's mode toggle: one recessed track
     carrying a raised thumb. */
  .seg {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
  }
  .seg-btn {
    min-height: 36px;
    padding: 0 0.9rem;
    border: none;
    border-radius: calc(var(--radius) - 3px);
    background: transparent;
    color: var(--text-muted);
    font-size: 0.875rem;
    font-weight: 600;
    transition:
      background var(--speed) ease,
      color var(--speed) ease,
      box-shadow var(--speed) ease;
  }
  .seg-btn:hover:not(.on) {
    color: var(--text);
  }
  .seg-btn.on {
    background: var(--surface);
    color: var(--accent);
    box-shadow: var(--shadow-sm);
  }
  @media (pointer: coarse) {
    .seg-btn {
      min-height: var(--touch);
    }
  }
  .outcome {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.75rem;
    background: var(--surface-2);
    border-radius: var(--radius);
  }
  .count {
    margin: 0;
    font-size: 0.95rem;
  }
  .count strong {
    font-size: 1.1rem;
  }
  .sample {
    margin: 0.2rem 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.8rem;
    font-family: var(--mono);
    color: var(--text-muted);
  }
  /* Open for review the list can run to hundreds of rows, so it scrolls inside
     its own box rather than pushing Apply off the bottom of the screen. The
     height is capped in vh so a phone keeps the buttons in reach. */
  .sample.reviewing {
    max-height: min(52vh, 26rem);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.35rem;
    gap: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .sample li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
  }
  .sample.reviewing li + li {
    border-top: 1px solid var(--border);
  }
  /* The whole row is the target — a 0.8rem checkbox is not a touch target. */
  .tick {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    min-height: 2rem;
    padding: 0.15rem 0.2rem;
    border-radius: calc(var(--radius) - 2px);
    cursor: pointer;
  }
  .tick:hover {
    background: var(--surface-2);
  }
  .tick input {
    flex: 0 0 auto;
    width: 1.05rem;
    height: 1.05rem;
    margin: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }
  @media (pointer: coarse) {
    .tick {
      min-height: var(--touch);
    }
    .tick input {
      width: 1.3rem;
      height: 1.3rem;
    }
  }
  /* Unticked: still legible, plainly not part of the run. Struck through rather
     than merely faded, so it reads the same way on a washed-out phone screen in
     sunlight as it does here. */
  .sample li.off .tick {
    opacity: 0.55;
  }
  .sample li.off .s-val {
    color: var(--text-muted);
    text-decoration: line-through;
  }
  .s-val {
    color: var(--text);
  }
  .review-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.1rem;
    font-size: 0.8rem;
  }
  .review-bar .spacer {
    flex: 1;
  }
  .warn {
    margin: 0.2rem 0 0;
    padding: 0.5rem 0.6rem;
    border-radius: var(--radius);
    background: var(--danger-soft);
    color: var(--text);
    font-size: 0.82rem;
  }
  /*
    The flights the calculation could not speak for. Set apart with a rule
    rather than coloured as a warning: nothing is wrong, but a pilot has to be
    able to see that the tool did not cover their whole logbook.
  */
  .skipped {
    margin-top: 0.4rem;
    padding-top: 0.4rem;
    border-top: 1px solid var(--line);
  }
  /* The sun sat near the threshold on this row — a judgement call, not a fact. */
  .graze {
    color: var(--night);
    font-weight: 600;
    white-space: nowrap;
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-size: 0.88rem;
  }
  .done {
    margin: 0;
    color: var(--accent);
    font-size: 0.88rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
    margin-top: 0.2rem;
  }
  .linkish {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: rgba(6, 14, 19, 0.5);
  }
  .dialog {
    width: 100%;
    max-width: 420px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow);
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .dialog h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .dialog p {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.92rem;
  }
  .dialog-warn {
    padding: 0.5rem 0.6rem;
    border-radius: var(--radius);
    background: var(--danger-soft);
  }
  .dialog-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.4rem;
  }
</style>
