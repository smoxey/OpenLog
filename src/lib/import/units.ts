/**
 * Duration units in a foreign CSV — sniffing them, and parsing by them.
 *
 * A duration column in someone else's export may be integer minutes (RB
 * Logbook), decimal hours (our own export), or `hh:mm` (several others). The
 * three are not distinguishable value by value, so the unit is decided ONCE for
 * the whole file from all its duration columns together, and then applied.
 *
 * WHY THIS IS NOT A SMALL DETAIL: mistaking decimal hours for minutes turns
 * 2.3 hours into 2 minutes; mistaking minutes for decimal hours turns 138
 * minutes into 8,280. A wrong guess here is not a rounding error, it is a
 * logbook full of fiction. That is why `sniffDurationFormat` reports how
 * confident it is, and why the mapping UI shows the answer and lets the pilot
 * overrule it — a guess about someone else's file should always be visible.
 *
 * PURE: no settings, no storage, no clock. In particular this does NOT read
 * `spreadsheetFormat`, which describes how this app writes a file and says
 * nothing about one it is reading.
 */
import { decimalToMinutes, hhmmToMinutes } from '../time/duration';

export type DurationUnit = 'minutes' | 'decimalHours' | 'hhmm';
export type DecimalMark = '.' | ',';

export interface DurationFormat {
  unit: DurationUnit;
  /** Which mark separates the fractional part. Irrelevant unless `decimalHours`. */
  decimal: DecimalMark;
}

export interface DurationFormatGuess {
  format: DurationFormat;
  /**
   * True when nothing in the sample distinguished the units — every value was
   * blank, or a whole number with no separator of any kind. `minutes` is then
   * a default rather than a finding, and the UI must say so.
   */
  ambiguous: boolean;
  /**
   * True when the sample held more than one shape (say `1:30` alongside `1.5`).
   * The file is internally inconsistent; one unit was chosen and the rest will
   * parse badly, so this needs a human.
   */
  mixed: boolean;
  /** A few distinct values from the sample, for showing the user what was read. */
  samples: string[];
}

/** `1:30`, `12:05` — hours and minutes. Not a time of day, though it looks like one. */
const HHMM = /^\d{1,3}:[0-5]\d$/;
/** `1.5`, `0,3`, `-2.0` — a number carrying a fractional part. */
const DECIMAL = /^-?\d+[.,]\d+$/;
/** `138`, `0`, `-5` — a bare integer. */
const INTEGER = /^-?\d+$/;

const MAX_SAMPLES = 4;

/**
 * Above this, an integer can only be minutes.
 *
 * 24 is generous rather than tight: the longest sector ever flown is under 20
 * hours, so a duration column holding `25` is already far likelier to be 25
 * minutes than 25 hours. The point of the threshold is not precision, it is
 * having ANY evidence at all — below it there genuinely is none, and the guess
 * gets reported as a guess.
 */
const MAX_PLAUSIBLE_HOURS = 24;

/**
 * Decide the duration unit for a whole file from a sample of its duration cells.
 *
 * Precedence, and the reasoning for each step:
 *
 * 1. **Any `hh:mm` value wins.** The colon is the one unambiguous marker in the
 *    set; nothing else produces it.
 * 2. **Otherwise any fractional value means decimal hours.** No logbook records
 *    a fraction of a minute, so a decimal point can only be a fraction of an
 *    hour.
 * 3. **Otherwise minutes** — but only confidently when some value is too large
 *    to be a duration in hours. `138` can only be minutes; no sector is 138
 *    hours long. `2`, on the other hand, is equally good as two minutes or two
 *    hours, so a file whose durations are all small whole numbers is reported
 *    `ambiguous` rather than guessed at quietly. That case is rare, and it is
 *    exactly the case where a silent guess is catastrophic.
 *
 * Blank cells carry no information and are skipped. `0` carries none either —
 * it is a whole number under every unit — but it is common enough that treating
 * it as evidence of "minutes" would make almost every file look unambiguous.
 */
export function sniffDurationFormat(values: Iterable<string>): DurationFormatGuess {
  let sawHhmm = false;
  let sawDecimal = false;
  /** Any non-zero integer — evidence of shape, for the `mixed` check. */
  let sawInteger = false;
  /** An integer too large to be hours — evidence of the UNIT. */
  let sawDecisiveInteger = false;
  let decimal: DecimalMark = '.';
  const samples: string[] = [];

  const remember = (value: string) => {
    if (samples.length < MAX_SAMPLES && !samples.includes(value)) samples.push(value);
  };

  for (const raw of values) {
    const value = (raw ?? '').trim();
    if (value === '') continue;

    if (HHMM.test(value)) {
      sawHhmm = true;
      remember(value);
    } else if (DECIMAL.test(value)) {
      sawDecimal = true;
      // The separator actually present, not the one our settings would write.
      decimal = value.includes(',') ? ',' : '.';
      remember(value);
    } else if (INTEGER.test(value)) {
      // A plain `0` is true under every unit, so it is not evidence.
      if (value !== '0' && value !== '-0') {
        sawInteger = true;
        // Longer than any sector: this can only be a count of minutes.
        if (Math.abs(Number(value)) > MAX_PLAUSIBLE_HOURS) sawDecisiveInteger = true;
        remember(value);
      }
    } else {
      // Unparseable under every unit. Not evidence either way; the row-level
      // parse will report it.
      remember(value);
    }
  }

  const shapes = [sawHhmm, sawDecimal, sawInteger].filter(Boolean).length;
  const mixed = shapes > 1;

  if (sawHhmm) return { format: { unit: 'hhmm', decimal }, ambiguous: false, mixed, samples };
  if (sawDecimal) return { format: { unit: 'decimalHours', decimal }, ambiguous: false, mixed, samples };
  return {
    format: { unit: 'minutes', decimal },
    ambiguous: !sawDecisiveInteger,
    mixed: false,
    samples,
  };
}

/**
 * Parse one duration cell into integer minutes under a known format.
 *
 * Returns `null` — not `0` — for anything unparseable, so a caller can tell
 * "this cell said nothing" from "this cell said zero". Collapsing the two would
 * turn a malformed value into a silent zero, which is the quiet kind of data
 * loss this whole import is built to avoid.
 *
 * An empty cell is `0`: a blank duration column in a logbook export means no
 * time was logged, which is a real answer rather than a missing one.
 */
export function parseDuration(value: string, format: DurationFormat): number | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return 0;

  // An `hh:mm` value is unmistakable, so it is honoured whatever unit the file
  // was judged to be in. A file that is mostly minutes but has one `1:30` in it
  // should read that cell correctly rather than fail it on principle.
  if (HHMM.test(trimmed)) {
    const minutes = hhmmToMinutes(trimmed);
    return Number.isFinite(minutes) ? minutes : null;
  }

  const normalized = format.decimal === ',' ? trimmed.replace(',', '.') : trimmed;

  if (format.unit === 'decimalHours') {
    if (!DECIMAL.test(trimmed) && !INTEGER.test(trimmed)) return null;
    const hours = Number(normalized);
    if (!Number.isFinite(hours)) return null;
    return decimalToMinutes(hours);
  }

  // Minutes. A fractional value here is a contradiction — no logbook records
  // half a minute — so it is far likelier the unit was guessed wrong than that
  // the pilot flew for 138.5 minutes. Round rather than refuse, and let the
  // `mixed` flag be what warns.
  if (!INTEGER.test(trimmed) && !DECIMAL.test(trimmed)) return null;
  const minutes = Number(normalized);
  if (!Number.isFinite(minutes)) return null;
  return Math.round(minutes);
}

/**
 * Parse a whole-number cell — a landing count, a take-off count.
 *
 * Separate from `parseDuration` because counts have no unit to guess at, and
 * because a count is never negative. `null` for anything that is not a
 * non-negative whole number; `0` for an empty cell.
 */
export function parseCount(value: string): number | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return 0;
  if (!/^\d+$/.test(trimmed)) return null;
  const count = Number(trimmed);
  return Number.isFinite(count) ? count : null;
}

