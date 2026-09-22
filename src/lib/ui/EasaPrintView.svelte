<script lang="ts">
  /**
   * The EASA logbook facsimile, laid out for printing.
   *
   * A print stylesheet and `window.print()`. No dependency, no library, nothing
   * fetched — it works in airplane mode, which a PDF generator pulled off a CDN
   * would not.
   *
   * The geometry is the reference file's own, measured from its content streams:
   * the same columns
   * in the same order, on an A4 landscape sheet with 40pt (~14.1mm) margins.
   *
   * COLUMN WIDTHS DELIBERATELY DEPART FROM THE REFERENCE, and only they. The
   * reference gives more than half of sheet B to twelve duration half-cells
   * that never hold more than two digits each, and leaves the remarks column
   * too narrow for the certification block it has to carry. So each duration
   * column here is sized by the widest thing it must ever print — the totals
   * figure beneath it — and the width that frees goes to the columns holding
   * dates and free text. The stylesheet's width block spells out the numbers.
   *
   * What it does NOT do: name the pilot from stored data, because the app
   * stores no pilot identity, and never will without a deliberate decision (see
   * the licence/medical expiry decision). A name typed here
   * is used for this print and is not saved.
   */
  import { FIELDS } from '../registry/fields';
  import {
    countCell,
    joinDuration,
    planLogbookPrint,
    splitDuration,
    type PrintOptions,
    type Spread,
  } from '../export/easaLayout';
  import type { TotalsSet } from '../domain/totals';
  import type { Flight } from '../domain/flight';

  interface Props {
    flights: readonly Flight[];
    options: PrintOptions;
    /** Optional, never stored. Printed on the cover only. */
    pilotName?: string;
    appVersion?: string;
  }

  let { flights, options, pilotName = '', appVersion = '' }: Props = $props();

  const plan = $derived(planLogbookPrint(flights, options));

  /** A duration cell's two halves, from a flight and a registry key. */
  function dur(flight: Flight | null, key: string) {
    if (!flight) return { hours: '', minutes: '' };
    const raw = (flight as unknown as Record<string, unknown>)[key];
    return splitDuration(typeof raw === 'number' ? raw : 0);
  }

  function text(flight: Flight | null, key: string): string {
    if (!flight) return '';
    const raw = (flight as unknown as Record<string, unknown>)[key];
    return raw == null ? '' : String(raw);
  }

  function count(flight: Flight | null, key: string): string {
    if (!flight) return '';
    return countCell((flight as unknown as Record<string, unknown>)[key]);
  }

  /** A flight's aerodrome, blank on a simulator session — SIM is not a place. */
  function aerodrome(flight: Flight | null, key: 'depAerodrome' | 'arrAerodrome'): string {
    if (!flight || flight.entryType === 'fstd') return '';
    return text(flight, key);
  }

  /** Block time, blank on a simulator session, which has none. */
  function blockTime(flight: Flight | null, key: 'offBlock' | 'onBlock'): string {
    if (!flight || flight.entryType === 'fstd') return '';
    return text(flight, key);
  }

  /** The three totals rows, in the order the form rules them. */
  function totalsRows(spread: Spread): { label: string; totals: TotalsSet; sim: number }[] {
    return [
      { label: 'Total this page', totals: spread.totals.thisPage, sim: spread.simulator.thisPage },
      {
        label: 'Total from previous page',
        totals: spread.totals.broughtForward,
        sim: spread.simulator.broughtForward,
      },
      { label: 'Total time', totals: spread.totals.cumulative, sim: spread.simulator.cumulative },
    ];
  }

  /** Column labels come from the registry, so a relabelling flows through. */
  function label(key: string, fallback: string): string {
    return FIELDS.find((f) => f.key === key)?.label ?? fallback;
  }
</script>

<div class="print-root">
  <!-- Cover. One sheet, and the only place any free text appears. -->
  <section class="sheet cover">
    <div class="cover-inner">
      <h1>Open Pilot Logbook</h1>
      <p class="cover-sub">EASA Logbook Report</p>
      {#if plan.flightCount > 0}
        <p class="cover-range">
          Entries from <span class="mono">{plan.firstDate}</span> to
          <span class="mono">{plan.lastDate}</span>
        </p>
      {:else}
        <p class="cover-range">No entries in this range</p>
      {/if}
      {#if pilotName.trim() !== ''}
        <p class="cover-name">{pilotName.trim()}</p>
      {/if}
      <p class="cover-foot">
        {plan.flightCount}
        {plan.flightCount === 1 ? 'entry' : 'entries'} · {plan.spreads.length}
        {plan.spreads.length === 1 ? 'page' : 'pages'}{appVersion ? ` · v${appVersion}` : ''}
      </p>
    </div>
  </section>

  {#each plan.spreads as spread (spread.number)}
    <!-- =============== Sheet A — EASA columns 1 to 8 =============== -->
    <section class="sheet">
      <table class="grid a">
        <!--
          THE COLUMN RULING, and it has to live here rather than on the data
          cells. Under `table-layout: fixed` a browser takes column widths from
          a `<colgroup>` or from the table's FIRST row, and ignores any width
          set in `<tbody>` — so the measured spans, applied to the data cells,
          were silently dropped and every column took an equal share instead.
          Widths are in the stylesheet below.
        -->
        <colgroup>
          <col /><!-- 1  Date -->
          <col /><col /><!-- 2  Departure: place, time -->
          <col /><col /><!-- 3  Arrival: place, time -->
          <col /><col /><!-- 4  Aircraft: make/model, registration -->
          <col /><col /><col /><col /><!-- 5  Single-pilot: SE hh|mm, ME hh|mm -->
          <col /><col /><!-- 5  Multi-pilot hh|mm -->
          <col /><col /><!-- 6  Total time of flight hh|mm -->
          <col /><!-- 7  Name PIC -->
          <col /><col /><!-- 8  Take-offs: day, night -->
          <col /><col /><!-- 8  Landings: day, night -->
        </colgroup>
        <thead>
          <tr class="numbers">
            <th colspan="1">1</th>
            <th colspan="2">2</th>
            <th colspan="2">3</th>
            <th colspan="2">4</th>
            <th colspan="6">5</th>
            <th colspan="2">6</th>
            <th colspan="1">7</th>
            <th colspan="4">8</th>
          </tr>
          <tr class="groups">
            <th rowspan="2">Date<br /><span class="fine">(yyyy-MM-dd)</span></th>
            <th colspan="2">Departure</th>
            <th colspan="2">Arrival</th>
            <th colspan="2">Aircraft</th>
            <!-- Four half-cells: SE hours|minutes and ME hours|minutes. -->
            <th colspan="4">Single-pilot time</th>
            <th colspan="2">Multi-pilot time</th>
            <th colspan="2">Total time of flight</th>
            <th rowspan="2">Name PIC</th>
            <th colspan="2">Take-offs</th>
            <th colspan="2">Landings</th>
          </tr>
          <tr class="subs">
            <th>Place</th>
            <th>Time</th>
            <th>Place</th>
            <th>Time</th>
            <th>Make, model, variant</th>
            <th>Registration</th>
            <th colspan="2">{label('singlePilotSeMinutes', 'SE')}</th>
            <th colspan="2">{label('singlePilotMeMinutes', 'ME')}</th>
            <th colspan="2"></th>
            <th colspan="2"></th>
            <th class="vert"><span>DAY</span></th>
            <th class="vert"><span>NIGHT</span></th>
            <th class="vert"><span>DAY</span></th>
            <th class="vert"><span>NIGHT</span></th>
          </tr>
        </thead>
        <tbody>
          {#each spread.rows as row, i (i)}
            <tr class="entry">
              <td class="date mono">{row ? row.date : ''}</td>
              <td class="mono">{aerodrome(row, 'depAerodrome')}</td>
              <td class="mono">{blockTime(row, 'offBlock')}</td>
              <td class="mono">{aerodrome(row, 'arrAerodrome')}</td>
              <td class="mono">{blockTime(row, 'onBlock')}</td>
              <!--
                Blank on a simulator session. Column 4 is "Aircraft", and a
                simulator is not one — its device type belongs in column 11,
                where it already is. Filling both would put an FSTD into the
                aircraft column of a flight record.
              -->
              <td class="type">{row && row.entryType === 'fstd' ? '' : text(row, 'aircraftType')}</td>
              <td class="mono">{text(row, 'registration')}</td>
              <td class="hh mono">{dur(row, 'singlePilotSeMinutes').hours}</td>
              <td class="mm mono">{dur(row, 'singlePilotSeMinutes').minutes}</td>
              <td class="hh mono">{dur(row, 'singlePilotMeMinutes').hours}</td>
              <td class="mm mono">{dur(row, 'singlePilotMeMinutes').minutes}</td>
              <td class="hh mono">{dur(row, 'multiPilotMinutes').hours}</td>
              <td class="mm mono">{dur(row, 'multiPilotMinutes').minutes}</td>
              <td class="hh mono">{dur(row, 'totalMinutes').hours}</td>
              <td class="mm mono">{dur(row, 'totalMinutes').minutes}</td>
              <td class="pic">{text(row, 'picName')}</td>
              <!--
                TAKE-OFFS ARE LEFT BLANK, and this is the one place the app
                refuses to be helpful. It stores landings and not take-offs.
                Currency infers one from the other as a disclosed convenience,
                but this is a document the pilot SIGNS — "I certify the entries
                on this page are correct" — and certifying a number the app
                invented is a different thing entirely. The column is ruled and
                empty, to be completed by hand like any paper logbook.
              -->
              <td class="mono"></td>
              <td class="mono"></td>
              <td class="mono">{count(row, 'landingsDay')}</td>
              <td class="mono">{count(row, 'landingsNight')}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          {#each totalsRows(spread) as row (row.label)}
            <tr class="totals">
              <td colspan="7" class="tlabel">{row.label}</td>
              <td colspan="2" class="tval mono">{joinDuration(row.totals.singlePilotSeMinutes ?? 0)}</td>
              <td colspan="2" class="tval mono">{joinDuration(row.totals.singlePilotMeMinutes ?? 0)}</td>
              <td colspan="2" class="tval mono">{joinDuration(row.totals.multiPilotMinutes ?? 0)}</td>
              <td colspan="2" class="tval mono">{joinDuration(row.totals.totalMinutes ?? 0)}</td>
              <td class="tval"></td>
              <td class="tval"></td>
              <td class="tval"></td>
              <td class="tval mono">{row.totals.landingsDay ?? 0}</td>
              <td class="tval mono">{row.totals.landingsNight ?? 0}</td>
            </tr>
          {/each}
        </tfoot>
      </table>
      <p class="folio">Page {spread.number}A</p>
    </section>

    <!-- =============== Sheet B — EASA columns 9 to 12 =============== -->
    <section class="sheet">
      <table class="grid b">
        <!-- As on sheet A: widths belong to the colgroup, not the data cells. -->
        <colgroup>
          <col /><col /><!-- 9  Night hh|mm -->
          <col /><col /><!-- 9  IFR hh|mm -->
          <col /><col /><!-- 10 PIC hh|mm -->
          <col /><col /><!-- 10 Co-Pilot hh|mm -->
          <col /><col /><!-- 10 Dual hh|mm -->
          <col /><col /><!-- 10 Instructor hh|mm -->
          <col /><!-- 11 FSTD session date -->
          <col /><!-- 11 FSTD device type -->
          <col /><col /><!-- 11 Total time of session hh|mm -->
          <col /><!-- 12 Remarks and endorsements -->
        </colgroup>
        <thead>
          <tr class="numbers">
            <th colspan="4">9</th>
            <th colspan="8">10</th>
            <th colspan="4">11</th>
            <th colspan="1">12</th>
          </tr>
          <tr class="groups">
            <th colspan="4">Operational condition time</th>
            <th colspan="8">Pilot function time</th>
            <th colspan="4">FSTD session</th>
            <th rowspan="2">Remarks and endorsements</th>
          </tr>
          <tr class="subs">
            <th colspan="2">{label('nightMinutes', 'Night')}</th>
            <th colspan="2">{label('ifrMinutes', 'IFR')}</th>
            <th colspan="2">{label('picMinutes', 'PIC')}</th>
            <th colspan="2">{label('coPilotMinutes', 'Co-Pilot')}</th>
            <th colspan="2">{label('dualMinutes', 'Dual')}</th>
            <th colspan="2">{label('instructorMinutes', 'Instructor')}</th>
            <th>Date<br /><span class="fine">(yyyy-MM-dd)</span></th>
            <th>Type</th>
            <th colspan="2">Total time of session</th>
          </tr>
        </thead>
        <tbody>
          {#each spread.rows as row, i (i)}
            <tr class="entry">
              <td class="hh mono">{dur(row, 'nightMinutes').hours}</td>
              <td class="mm mono">{dur(row, 'nightMinutes').minutes}</td>
              <td class="hh mono">{dur(row, 'ifrMinutes').hours}</td>
              <td class="mm mono">{dur(row, 'ifrMinutes').minutes}</td>
              <td class="hh mono">{dur(row, 'picMinutes').hours}</td>
              <td class="mm mono">{dur(row, 'picMinutes').minutes}</td>
              <td class="hh mono">{dur(row, 'coPilotMinutes').hours}</td>
              <td class="mm mono">{dur(row, 'coPilotMinutes').minutes}</td>
              <td class="hh mono">{dur(row, 'dualMinutes').hours}</td>
              <td class="mm mono">{dur(row, 'dualMinutes').minutes}</td>
              <td class="hh mono">{dur(row, 'instructorMinutes').hours}</td>
              <td class="mm mono">{dur(row, 'instructorMinutes').minutes}</td>
              <!-- Columns 11 carry the session, and only for an FSTD entry. -->
              <td class="mono">{row && row.entryType === 'fstd' ? row.date : ''}</td>
              <td class="mono">{row && row.entryType === 'fstd' ? row.simulatorRegistration : ''}</td>
              <td class="hh mono">{row && row.entryType === 'fstd' ? dur(row, 'simulatorMinutes').hours : ''}</td>
              <td class="mm mono">{row && row.entryType === 'fstd' ? dur(row, 'simulatorMinutes').minutes : ''}</td>
              <td class="remarks">{text(row, 'remarks')}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          {#each totalsRows(spread) as row, i (row.label)}
            <tr class="totals">
              <td colspan="2" class="tval mono">{joinDuration(row.totals.nightMinutes ?? 0)}</td>
              <td colspan="2" class="tval mono">{joinDuration(row.totals.ifrMinutes ?? 0)}</td>
              <td colspan="2" class="tval mono">{joinDuration(row.totals.picMinutes ?? 0)}</td>
              <td colspan="2" class="tval mono">{joinDuration(row.totals.coPilotMinutes ?? 0)}</td>
              <td colspan="2" class="tval mono">{joinDuration(row.totals.dualMinutes ?? 0)}</td>
              <td colspan="2" class="tval mono">{joinDuration(row.totals.instructorMinutes ?? 0)}</td>
              <td colspan="2" class="tlabel">{row.label}</td>
              <td colspan="2" class="tval mono">{joinDuration(row.sim)}</td>
              {#if i === 0}
                <!-- The remarks column is merged across all three totals rows
                     to carry the certification block, exactly as the reference
                     rules it. -->
                <td rowspan="3" class="certify">
                  <span class="cert-text">I certify the entries on this page are correct.</span>
                  <span class="sig-line"></span>
                  <span class="sig-label">PILOT'S SIGNATURE</span>
                </td>
              {/if}
            </tr>
          {/each}
        </tfoot>
      </table>
      <p class="folio">Page {spread.number}B</p>
    </section>
  {/each}
</div>

<style>
  /*
    A4 landscape with the reference file's own margins. The sheet is sized in
    millimetres so the print output matches regardless of the screen.
  */
  @page {
    size: A4 landscape;
    margin: 0;
  }

  .print-root {
    --sheet-w: 297mm;
    --sheet-h: 210mm;
    --margin: 14.1mm; /* 40pt, the reference's margin */
    background: #fff;
    color: #000;
  }

  .sheet {
    width: var(--sheet-w);
    height: var(--sheet-h);
    padding: var(--margin);
    box-sizing: border-box;
    background: #fff;
    position: relative;
    page-break-after: always;
    break-after: page;
    overflow: hidden;
  }
  .sheet:last-child {
    page-break-after: auto;
    break-after: auto;
  }

  /* --- The ruled grid ---------------------------------------------------- */

  .grid {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 6.5pt;
    color: #000;
  }
  .grid th,
  .grid td {
    border: 0.4pt solid #000;
    padding: 0.4mm 0.6mm;
    text-align: center;
    vertical-align: middle;
    overflow: hidden;
    white-space: nowrap;
  }

  .grid .numbers th {
    height: 7.05mm; /* 20pt */
    font-size: 6pt;
    font-weight: 700;
  }
  .grid .groups th {
    height: 9.2mm; /* 26pt */
    font-size: 6.5pt;
    font-weight: 700;
    line-height: 1.15;
    white-space: normal;
  }
  .grid .subs th {
    height: 20.4mm; /* 58pt */
    font-size: 6pt;
    font-weight: 700;
    line-height: 1.15;
    white-space: normal;
  }
  .grid .fine {
    font-weight: 400;
    font-size: 5pt;
  }

  /* DAY / NIGHT set one letter per line, as the reference does. */
  .grid th.vert span {
    display: block;
    line-height: 1.05;
    font-size: 5.5pt;
    word-break: break-all;
    white-space: normal;
  }

  .grid tbody tr.entry td {
    height: 7.1mm; /* 20.2pt */
    font-size: 7pt;
  }
  .grid td.hh {
    border-right: 0.25pt solid #000;
    text-align: right;
    padding-right: 0.4mm;
  }
  .grid td.mm {
    border-left: 0.25pt solid #000;
    text-align: left;
    padding-left: 0.4mm;
  }
  .grid td.date,
  .grid td.type,
  .grid td.pic,
  .grid td.remarks {
    text-align: left;
    padding-left: 1mm;
  }
  .grid td.remarks,
  .grid td.pic,
  .grid td.type {
    text-overflow: ellipsis;
  }

  .grid tfoot td {
    height: 7.1mm;
    font-size: 7pt;
    font-weight: 700;
  }
  .grid td.tlabel {
    text-align: right;
    padding-right: 1.5mm;
    font-weight: 400;
    font-size: 6.5pt;
  }
  .grid td.tval {
    text-align: center;
  }

  .grid td.certify {
    vertical-align: top;
    text-align: left;
    padding: 1.2mm;
    font-weight: 400;
    /*
      The grid is `nowrap` everywhere else, because a ruled data cell that grew
      a second line would break the row height. This cell is three rows tall and
      carries prose, so it wraps instead. At the reference width the sentence
      still sets on one line — this only decides what happens if a substituted
      font runs wide, and a wrapped certification beats a truncated one.
    */
    white-space: normal;
  }
  .cert-text {
    display: block;
    font-size: 6.5pt;
  }
  .sig-line {
    display: block;
    border-bottom: 0.4pt solid #000;
    margin: 5mm 2mm 1mm 0;
  }
  .sig-label {
    display: block;
    font-size: 6pt;
    letter-spacing: 0.06em;
  }

  .folio {
    position: absolute;
    right: var(--margin);
    bottom: 6mm;
    margin: 0;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 7pt;
    color: #000;
  }

  /* --- Column widths ------------------------------------------------------

     Percentages of the reference's 760.9pt content width, so each sheet sums to
     100%. Three decimals are not fussiness: rounding to one put the date column
     ~4pt short of the ten characters it has to hold, and a logbook date reading
     "2021-01-" is worse than useless.

     These are on `col`, not on the data cells — see the colgroup comment in the
     markup for why that distinction is load-bearing.

     THE RULE FOR A DURATION COLUMN: it is sized by the widest thing it must
     ever print, and that is the TOTALS figure, not the data row. A data cell
     holds "1" and "38"; the totals row under it holds a whole career, and the
     reference file's own example is `18541:44`. Sizing to the data row is what
     made the single-pilot columns clip a four-figure total.

     Applied in both directions, that rule is also what funds the text columns.
     Every duration group is cut to a little over what its totals string needs
     — 40pt on sheet A, 52pt on sheet B — and the ~105pt this releases on sheet
     B goes to the FSTD date and to remarks, which is the column carrying free
     text and the signed certification block. The columns and their order are
     the reference's throughout; only the proportions move.                  */

  .grid.a col:nth-child(1) { width: 8.411%; }   /* 1  Date            64pt  */
  .grid.a col:nth-child(2) { width: 7.097%; }   /* 2  Dep place       54pt  */
  .grid.a col:nth-child(3) { width: 5.126%; }   /* 2  Dep time        39pt  */
  .grid.a col:nth-child(4) { width: 7.097%; }   /* 3  Arr place       54pt  */
  .grid.a col:nth-child(5) { width: 5.126%; }   /* 3  Arr time        39pt  */
  .grid.a col:nth-child(6) { width: 8.411%; }   /* 4  Make/model      64pt  */
  .grid.a col:nth-child(7) { width: 7.754%; }   /* 4  Registration    59pt  */
  .grid.a col:nth-child(8) { width: 3.023%; }   /* 5  SE hh           23pt  */
  .grid.a col:nth-child(9) { width: 2.234%; }   /* 5  SE mm           17pt  */
  .grid.a col:nth-child(10) { width: 3.023%; }  /* 5  ME hh           23pt  */
  .grid.a col:nth-child(11) { width: 2.234%; }  /* 5  ME mm           17pt  */
  .grid.a col:nth-child(12) { width: 3.023%; }  /* 5  Multi hh        23pt  */
  .grid.a col:nth-child(13) { width: 2.234%; }  /* 5  Multi mm        17pt  */
  .grid.a col:nth-child(14) { width: 3.023%; }  /* 6  Total hh        23pt  */
  .grid.a col:nth-child(15) { width: 2.234%; }  /* 6  Total mm        17pt  */
  .grid.a col:nth-child(16) { width: 15.758%; } /* 7  Name PIC     119.9pt  */
  .grid.a col:nth-child(17) { width: 3.548%; }  /* 8  T/O day         27pt  */
  .grid.a col:nth-child(18) { width: 3.548%; }  /* 8  T/O night       27pt  */
  .grid.a col:nth-child(19) { width: 3.548%; }  /* 8  Ldg day         27pt  */
  .grid.a col:nth-child(20) { width: 3.548%; }  /* 8  Ldg night       27pt  */

  .grid.b col:nth-child(1) { width: 3.943%; }   /* 9  Night hh        30pt  */
  .grid.b col:nth-child(2) { width: 2.891%; }   /* 9  Night mm        22pt  */
  .grid.b col:nth-child(3) { width: 3.943%; }   /* 9  IFR hh          30pt  */
  .grid.b col:nth-child(4) { width: 2.891%; }   /* 9  IFR mm          22pt  */
  .grid.b col:nth-child(5) { width: 3.943%; }   /* 10 PIC hh          30pt  */
  .grid.b col:nth-child(6) { width: 2.891%; }   /* 10 PIC mm          22pt  */
  .grid.b col:nth-child(7) { width: 3.943%; }   /* 10 Co-Pilot hh     30pt  */
  .grid.b col:nth-child(8) { width: 2.891%; }   /* 10 Co-Pilot mm     22pt  */
  .grid.b col:nth-child(9) { width: 3.943%; }   /* 10 Dual hh         30pt  */
  .grid.b col:nth-child(10) { width: 2.891%; }  /* 10 Dual mm         22pt  */
  .grid.b col:nth-child(11) { width: 3.943%; }  /* 10 Instructor hh   30pt  */
  .grid.b col:nth-child(12) { width: 2.891%; }  /* 10 Instructor mm   22pt  */
  .grid.b col:nth-child(13) { width: 10.251%; } /* 11 FSTD date       78pt  */
  .grid.b col:nth-child(14) { width: 10.382%; } /* 11 FSTD type       79pt  */
  .grid.b col:nth-child(15) { width: 3.943%; }  /* 11 Session hh      30pt  */
  .grid.b col:nth-child(16) { width: 2.891%; }  /* 11 Session mm      22pt  */
  .grid.b col:nth-child(17) { width: 31.528%; } /* 12 Remarks      239.9pt  */

  /* --- The cover --------------------------------------------------------- */

  .cover {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: Arial, Helvetica, sans-serif;
  }
  .cover-inner {
    text-align: center;
  }
  .cover h1 {
    margin: 0 0 4mm;
    font-size: 22pt;
    font-weight: 400;
    letter-spacing: 0.02em;
  }
  .cover-sub {
    margin: 0 0 3mm;
    font-size: 15pt;
  }
  .cover-range {
    margin: 0 0 6mm;
    font-size: 11pt;
  }
  .cover-name {
    margin: 0 0 8mm;
    font-size: 13pt;
    font-weight: 700;
  }
  .cover-foot {
    margin: 0;
    font-size: 8pt;
    color: #444;
  }

  .mono {
    font-family: ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace;
  }

  /* --- On screen, and on paper ------------------------------------------ */

  @media screen {
    .print-root {
      padding: 1rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
      background: #6b7c88;
    }
    .sheet {
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
    }
  }

  @media print {
    .print-root {
      padding: 0;
      gap: 0;
      background: #fff;
    }
    .sheet {
      box-shadow: none;
    }
  }
</style>
