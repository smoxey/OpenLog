<script lang="ts">
  /**
   * The print screen: choose what to print, see it, print it.
   *
   * The toolbar carries `no-print`, so what reaches the paper is the facsimile
   * and nothing else. Printing is `window.print()` — the browser's own PDF
   * writer does the rest, which is why this works offline and adds no
   * dependency.
   *
   * THE RANGE IS THIS SCREEN'S OWN STATE, deliberately. It is not read from the
   * list's filter or the totals view's range selector: "export never depends on
   * a display setting" (`Claude Context/HOW_IT_WORKS.md`), and a printed logbook that quietly
   * inherited whatever the list happened to be filtered to would be exactly
   * that bug.
   */
  import { getAllFlights, type Flight } from '../storage';
  import { settings } from '../stores/settings.svelte';
  import { planLogbookPrint } from '../export/easaLayout';
  import EasaPrintView from './EasaPrintView.svelte';

  interface Props {
    onBack: () => void;
  }

  let { onBack }: Props = $props();

  // App version, injected at build time by Vite and declared globally in
  // `vite-env.d.ts`, so no local `declare` is needed (and Svelte forbids one).
  const appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

  let flights = $state<Flight[]>([]);
  let loading = $state(true);
  let from = $state('');
  let to = $state('');
  /** Printed on the cover if given. NEVER stored — the app holds no identity. */
  let pilotName = $state('');

  $effect(() => {
    let cancelled = false;
    (async () => {
      const all = await getAllFlights();
      if (cancelled) return;
      flights = all;
      loading = false;
    })();
    return () => {
      cancelled = true;
    };
  });

  const options = $derived({ from, to, openingBalance: settings.openingBalance });
  const plan = $derived(loading ? null : planLogbookPrint(flights, options));

  function clearRange() {
    from = '';
    to = '';
  }
</script>

<div class="print-screen">
  <header class="bar no-print">
    <button type="button" class="btn ghost back" onclick={onBack}>← Back</button>
    <h1>Print logbook</h1>
    <span class="spacer"></span>
    <button type="button" class="btn primary" disabled={loading} onclick={() => window.print()}>
      Print…
    </button>
  </header>

  <div class="controls no-print">
    <div class="row">
      <label class="f">
        <span>From</span>
        <input type="date" bind:value={from} />
      </label>
      <label class="f">
        <span>To</span>
        <input type="date" bind:value={to} />
      </label>
      <label class="f grow">
        <span>Name on the cover (optional)</span>
        <input type="text" placeholder="Left blank if you leave it empty" bind:value={pilotName} />
      </label>
      {#if from !== '' || to !== ''}
        <button type="button" class="btn ghost" onclick={clearRange}>Whole logbook</button>
      {/if}
    </div>

    {#if plan}
      <p class="summary" role="status">
        {plan.flightCount}
        {plan.flightCount === 1 ? 'entry' : 'entries'} over {plan.spreads.length}
        {plan.spreads.length === 1 ? 'logbook page' : 'logbook pages'} —
        {plan.spreads.length * 2 + 1} sheets including the cover.
        {#if plan.hasOpeningBalance}
          Your previous logbook total opens page 1 as “Total from previous page”.
        {/if}
      </p>
    {/if}

    <p class="note">
      Each logbook page is <strong>two landscape sheets</strong>, A and B, read side by
      side — that is how the EASA form is laid out. Print A4 landscape at 100%, with
      margins set to none, and turn off your browser’s headers and footers.
    </p>
    <p class="note">
      <strong>The take-off columns are left blank.</strong> This app records landings and
      not take-offs, and this is a page you sign, so it will not fill in a number it does
      not have. Complete them by hand.
    </p>
    <p class="note">
      Your name is printed on the cover only if you type it here, and is not saved.
    </p>
  </div>

  {#if loading}
    <p class="status no-print">Laying out the pages…</p>
  {:else}
    <EasaPrintView {flights} {options} {pilotName} {appVersion} />
  {/if}
</div>

<style>
  .print-screen {
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
    z-index: 3;
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

  .controls {
    padding: 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.6rem;
  }
  .f {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .f.grow {
    flex: 1 1 14rem;
  }
  .f span {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .f input {
    min-height: var(--touch);
    padding: 0 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.9rem;
  }
  .summary {
    margin: 0;
    font-size: 0.88rem;
    color: var(--text);
  }
  .note {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-muted);
    max-width: 60ch;
  }
  .status {
    padding: 1rem 0.9rem;
    color: var(--text-muted);
  }

  @media print {
    .no-print {
      display: none !important;
    }
    .print-screen {
      background: #fff;
    }
  }
</style>
