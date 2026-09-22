/**
 * Paginating a logbook into EASA spreads.
 *
 * PURE: flights in, printable spreads out. No storage, no settings, no clock,
 * no DOM. The renderer decides how a spread looks; this module decides what is
 * on it, which is the part worth testing.
 *
 * THE SHAPE OF THE THING. One logbook "page" is a two-sheet SPREAD — sheet A
 * carries EASA columns 1–8, sheet B carries 9–12, and a pilot lays them side by
 * side. Eight flight rows per spread. Measured from the reference file.
 *
 * TWO THINGS RUN OPPOSITE TO THE REST OF THE APP, both deliberately:
 *
 *  - **Rows read oldest first.** The list view is newest-first because that is
 *    what a pilot wants on a phone; a logbook page is a chronological record and
 *    reads downward through time.
 *  - **Durations print as hh:mm regardless of the display setting.** The form
 *    has an hours column and a minutes column; there is nowhere to put "2.3".
 *    This is not a display preference leaking into an export — it is the format
 *    the document itself is made of.
 *
 * WHERE THE OPENING BALANCE FINALLY BELONGS. Every spread carries "Total from
 * previous page", and on the FIRST spread that is exactly what a brought-forward
 * balance is. The rule that it is an all-time figure holds: it enters once, at
 * the start, and every later page inherits it through the running total rather
 * than adding it again.
 */
import { SUMMABLE_FIELDS } from '../registry/fields';
import { emptyTotals, sumTotals, type TotalsSet } from '../domain/totals';
import { applyOpeningBalance, type OpeningBalance } from '../domain/openingBalance';
import type { Flight } from '../domain/flight';

/** Flight rows on one spread. The EASA form is ruled for eight. */
export const ROWS_PER_SPREAD = 8;

export interface SpreadTotals {
  /** The eight rows on this spread. */
  thisPage: TotalsSet;
  /** Everything before it — including the opening balance, on spread one. */
  broughtForward: TotalsSet;
  /** `broughtForward` plus `thisPage`. What "Total time" prints. */
  cumulative: TotalsSet;
}

export interface Spread {
  /** 1-based. Sheets are labelled `${number}A` and `${number}B`. */
  number: number;
  /**
   * Exactly `ROWS_PER_SPREAD` entries. `null` is a ruled but empty row — the
   * grid is part of the document, so a short final page is padded rather than
   * ending in mid-air.
   */
  rows: (Flight | null)[];
  totals: SpreadTotals;
  /**
   * Simulator session time, which has its own column (11) on sheet B and is
   * never part of any flight total. Same three figures as the flight totals so
   * the column can carry a page and a running total like every other.
   */
  simulator: { thisPage: number; broughtForward: number; cumulative: number };
}

export interface LogbookPrintPlan {
  spreads: Spread[];
  /** Entries actually printed, after any date filtering. */
  flightCount: number;
  /** Earliest and latest dates printed, for the cover. Empty for a blank book. */
  firstDate: string;
  lastDate: string;
  /** Whether a brought-forward balance opens the first page. */
  hasOpeningBalance: boolean;
}

export interface PrintOptions {
  /** Inclusive ISO bounds. Empty means unbounded — the whole logbook. */
  from?: string;
  to?: string;
  openingBalance?: OpeningBalance;
}

/** Sum two totals sets. Neither input is mutated. */
function addTotals(a: TotalsSet, b: TotalsSet): TotalsSet {
  const out: TotalsSet = { ...a };
  for (const field of SUMMABLE_FIELDS) {
    out[field.key] = (a[field.key] ?? 0) + (b[field.key] ?? 0);
  }
  return out;
}

/**
 * Chronological order: date, then off-block, then id.
 *
 * The id tiebreak is not decoration. Two simulator sessions on one day carry no
 * block times at all, so without it their order would depend on whatever order
 * storage happened to return — and a logbook that reprints in a different order
 * each time is not a record of anything.
 */
function chronological(a: Flight, b: Flight): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const aOff = a.offBlock ?? '';
  const bOff = b.offBlock ?? '';
  if (aOff !== bOff) return aOff < bOff ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function withinRange(flight: Flight, from: string, to: string): boolean {
  const date = typeof flight.date === 'string' ? flight.date : '';
  if (from !== '' && (date === '' || date < from)) return false;
  if (to !== '' && (date === '' || date > to)) return false;
  return true;
}

/** Simulator session minutes across a set of records. */
function sessionMinutes(flights: readonly Flight[]): number {
  let total = 0;
  for (const flight of flights) {
    if (flight.entryType !== 'fstd') continue;
    const value = flight.simulatorMinutes;
    if (typeof value === 'number' && Number.isFinite(value)) total += value;
  }
  return total;
}

/**
 * Lay a logbook out as printable spreads.
 *
 * An empty logbook still produces ONE spread — a blank ruled page. That is what
 * a paper logbook is before anything is written in it, and printing nothing at
 * all would be a worse answer to "print my logbook".
 */
export function planLogbookPrint(
  flights: readonly Flight[],
  options: PrintOptions = {},
): LogbookPrintPlan {
  const from = (options.from ?? '').trim();
  const to = (options.to ?? '').trim();
  const balance = options.openingBalance ?? {};

  const included = flights.filter((f) => withinRange(f, from, to)).sort(chronological);

  const spreads: Spread[] = [];
  // The opening balance is the first page's "brought forward", and enters here
  // exactly once. Later pages inherit it through `running`, never re-add it.
  let running = applyOpeningBalance(emptyTotals(), balance);
  let runningSim = 0;

  const pageCount = Math.max(1, Math.ceil(included.length / ROWS_PER_SPREAD));
  for (let i = 0; i < pageCount; i += 1) {
    const slice = included.slice(i * ROWS_PER_SPREAD, (i + 1) * ROWS_PER_SPREAD);
    const rows: (Flight | null)[] = [...slice];
    while (rows.length < ROWS_PER_SPREAD) rows.push(null);

    const thisPage = sumTotals(slice);
    const broughtForward = running;
    const cumulative = addTotals(broughtForward, thisPage);

    const simThisPage = sessionMinutes(slice);
    const simBroughtForward = runningSim;
    const simCumulative = simBroughtForward + simThisPage;

    spreads.push({
      number: i + 1,
      rows,
      totals: { thisPage, broughtForward, cumulative },
      simulator: {
        thisPage: simThisPage,
        broughtForward: simBroughtForward,
        cumulative: simCumulative,
      },
    });

    running = cumulative;
    runningSim = simCumulative;
  }

  return {
    spreads,
    flightCount: included.length,
    firstDate: included[0]?.date ?? '',
    lastDate: included[included.length - 1]?.date ?? '',
    hasOpeningBalance: Object.values(balance).some((v) => v > 0),
  };
}

/**
 * Minutes as `hh` and `mm` for the two halves of a ruled duration cell.
 *
 * Hours are NOT capped at 24 — a logbook column holds a career, and the
 * reference file prints `18541:44` in a running total. Zero is blank rather
 * than `0:00`: an empty cell on a logbook page means "none", and a page of
 * zeros is unreadable.
 */
export function splitDuration(minutes: number): { hours: string; minutes: string } {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    return { hours: '', minutes: '' };
  }
  const whole = Math.round(minutes);
  return {
    hours: String(Math.floor(whole / 60)),
    minutes: String(whole % 60).padStart(2, '0'),
  };
}

/**
 * Minutes as one `hh:mm` string, the way the reference prints a TOTALS row.
 *
 * Deliberately different from `splitDuration`: the totals rows in the reference
 * carry a colon and overflow across the hour/minute divider, and a zero total
 * prints as `0:00` rather than blank — a total of nothing is a fact, where an
 * empty flight cell is an absence.
 */
export function joinDuration(minutes: number): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return '0:00';
  const whole = Math.round(minutes);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** A landing or take-off count for a ruled cell — blank when there were none. */
export function countCell(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? String(value) : '';
}
