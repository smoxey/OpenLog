/**
 * CSV import — reading someone else's file.
 *
 * This is the counterpart to `import/restore`, and it is deliberately built to
 * the same standard: PURE (no storage, no settings, no clock, no DOM), and it
 * NEVER THROWS. A file a pilot picked by mistake is an ordinary outcome, not an
 * exception, so every failure comes back as a rejection carrying words they can
 * act on.
 *
 * What separates this module from the export side: an export writes a file we
 * control, so `export/csv.ts` may assume its own conventions. An import reads a
 * file written by software we have never seen. Nothing about its shape may be
 * assumed — least of all from our own settings.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: **sniff, never assume.** The
 * `spreadsheetFormat` setting describes how this app WRITES a file and has no
 * authority whatsoever over one it READS. Reading it here would mean a user
 * whose export preference is European silently mis-parses a comma-delimited
 * file from another app.
 *
 * Rows are kept as arrays aligned to `headers`, not as objects keyed by header
 * name. A foreign file may repeat a column name, and an object would silently
 * collapse the duplicates into one — losing a column without saying so.
 */
import Papa from 'papaparse';

/** Delimiters worth considering. Ordered: ties resolve to the earlier one. */
const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const;

export type CsvDelimiter = (typeof CANDIDATE_DELIMITERS)[number];

export type CsvIssueCode = 'ragged-row' | 'duplicate-header' | 'blank-header' | 'parser';

/** Something worth telling the user about a row or column, short of refusing the file. */
export interface CsvIssue {
  code: CsvIssueCode;
  message: string;
  /** 1-based line in the source file, header row included. */
  line?: number;
}

/** One data row, its cells aligned index-for-index with `ParsedCsv.headers`. */
export interface CsvRow {
  /** 1-based line in the source file. The header is line 1, so the first data row is 2. */
  line: number;
  cells: readonly string[];
}

export interface ParsedCsv {
  headers: readonly string[];
  rows: readonly CsvRow[];
  /** The delimiter actually used, as sniffed from the header row. */
  delimiter: CsvDelimiter;
  /** Whether the file began with a byte-order mark. Ours do; RB's does not. */
  hadBom: boolean;
  issues: readonly CsvIssue[];
}

export type CsvRejectionCode = 'empty' | 'looks-like-json' | 'no-columns' | 'unreadable';

export interface CsvRejection {
  code: CsvRejectionCode;
  message: string;
}

export type CsvParseResult =
  | { ok: true; file: ParsedCsv }
  | { ok: false; rejection: CsvRejection };

function reject(code: CsvRejectionCode, message: string): CsvParseResult {
  return { ok: false, rejection: { code, message } };
}

/**
 * Count a delimiter's occurrences in a line, ignoring any inside quotes.
 *
 * Quote-aware because the naive count is wrong exactly when it matters: a
 * header like `Remarks,"Notes, extra"` has two commas but three columns' worth
 * of nothing to do with the delimiter question.
 */
function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      // A doubled quote inside a quoted field is an escaped quote, not a close.
      if (inQuotes && line[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && char === delimiter) {
      count++;
    }
  }
  return count;
}

/**
 * Pick the delimiter from the header row.
 *
 * The header row rather than the whole file: it is the one line guaranteed to
 * have a value in every column, so its separator count is the honest one. A
 * data row full of empty cells looks identical under any delimiter.
 */
export function sniffDelimiter(headerLine: string): CsvDelimiter {
  let best: CsvDelimiter = ',';
  let bestCount = 0;
  for (const candidate of CANDIDATE_DELIMITERS) {
    const count = countOutsideQuotes(headerLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  // Nothing found means a single-column file. Comma is as good as anything.
  return best;
}

/**
 * Does this look like JSON — that is, like a file meant for Restore?
 *
 * The mirror of `looksLikeCsv` in `import/restore`, and it exists for the same
 * reason: a specific, actionable message beats a parser error. Restore already
 * recognises a spreadsheet; this completes the pair so each flow can hand the
 * user over to the other instead of failing obscurely.
 */
function looksLikeJson(text: string): boolean {
  const body = text.trimStart();
  return body.startsWith('{') || body.startsWith('[');
}

/**
 * Parse a CSV file into headers and rows.
 *
 * Never throws. Never reads settings or the clock. Does not mutate its input.
 */
export function parseCsv(text: unknown): CsvParseResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return reject('empty', 'That file is empty.');
  }

  const hadBom = text.charCodeAt(0) === 0xfeff;
  // Strip a BOM if present and tolerate its absence. Our own export writes one;
  // RB Logbook writes none. Left in place it becomes part of the first header
  // name, and every mapping against that column silently fails to match.
  const body = hadBom ? text.slice(1) : text;

  if (looksLikeJson(body)) {
    return reject(
      'looks-like-json',
      'That looks like a backup file, not a spreadsheet. Did you mean to use "Restore from backup"?',
    );
  }

  // The header row, for sniffing only — the real split is PapaParse's job.
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = sniffDelimiter(firstLine);

  let parsed: Papa.ParseResult<string[]>;
  try {
    parsed = Papa.parse<string[]>(body, {
      delimiter,
      // No `header: true`. We take row 0 ourselves so that repeated column
      // names stay visible instead of collapsing into one another.
      header: false,
      // `true`, not `'greedy'`: this drops the empty final line left by a
      // trailing newline, while a row that is genuinely all-empty-cells — a
      // real row, badly filled in — still reaches us to be reported.
      skipEmptyLines: true,
      newline: undefined,
    });
  } catch (error) {
    return reject(
      'unreadable',
      `That file could not be read as a spreadsheet${error instanceof Error ? `: ${error.message}` : '.'}`,
    );
  }

  const issues: CsvIssue[] = [];
  for (const error of parsed.errors ?? []) {
    // Papa reports a row index; +1 for the header line, +1 for 1-based counting.
    const line = typeof error.row === 'number' ? error.row + 1 : undefined;
    issues.push({ code: 'parser', message: error.message, line });
  }

  const table = parsed.data ?? [];
  if (table.length === 0) {
    return reject('empty', 'That file has no rows in it.');
  }

  const headers = (table[0] ?? []).map((h) => (typeof h === 'string' ? h.trim() : ''));
  if (headers.length === 0 || headers.every((h) => h === '')) {
    return reject(
      'no-columns',
      'That file has no column headings in its first row, so there is no way to tell what its columns mean.',
    );
  }

  // Duplicate and blank headings are reported rather than refused: the file is
  // still importable, the user just needs to know a column cannot be named.
  const seen = new Map<string, number>();
  headers.forEach((header, index) => {
    if (header === '') {
      issues.push({
        code: 'blank-header',
        message: `Column ${index + 1} has no heading. Its values can still be imported, but it has to be mapped by hand.`,
        line: 1,
      });
      return;
    }
    const previous = seen.get(header);
    if (previous !== undefined) {
      issues.push({
        code: 'duplicate-header',
        message: `"${header}" appears as both column ${previous + 1} and column ${index + 1}.`,
        line: 1,
      });
    } else {
      seen.set(header, index);
    }
  });

  const rows: CsvRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const raw = table[i] ?? [];
    const line = i + 1;

    if (raw.length !== headers.length) {
      issues.push({
        code: 'ragged-row',
        message:
          `Line ${line} has ${raw.length} ${raw.length === 1 ? 'value' : 'values'} but the file has ` +
          `${headers.length} columns. It was read as far as it goes rather than being dropped.`,
        line,
      });
    }

    // Pad short rows and drop the overflow of long ones, so every row is
    // aligned to `headers` and callers never index off the end. The row is kept
    // either way — a row is reported, never silently discarded.
    const cells: string[] = new Array(headers.length);
    for (let c = 0; c < headers.length; c++) {
      const value = raw[c];
      cells[c] = typeof value === 'string' ? value.trim() : '';
    }
    rows.push({ line, cells });
  }

  return { ok: true, file: { headers, rows, delimiter, hadBom, issues } };
}

/**
 * The index of a named column, or -1. First occurrence wins, matching the
 * duplicate-header report above.
 */
export function headerIndex(headers: readonly string[], name: string): number {
  return headers.indexOf(name);
}

/** A row's value for a column index, or `''` when the index is out of range. */
export function cellAt(row: CsvRow, index: number): string {
  return index >= 0 && index < row.cells.length ? row.cells[index] : '';
}
