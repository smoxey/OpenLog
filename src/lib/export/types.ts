/**
 * Export types.
 *
 * FORMAT POLICY (see `Claude Context/HOW_IT_WORKS.md`):
 *
 *   JSON is the CANONICAL backup format. It is lossless — `extra` survives
 *   whatever shape it holds, the aircraft table travels with the flights, and
 *   durations stay as integer minutes because machines read this file.
 *
 *   CSV is the INTERCHANGE format. Its guarantee is deliberately weaker: flat
 *   scalars only, decimal hours, no file-level header. It exists so other
 *   logbook apps can read our data. When the two formats disagree, JSON wins.
 */
import type { Flight } from '../domain/flight';
import type { Aircraft } from '../domain/aircraft';
import type { OpeningBalance } from '../domain/openingBalance';

/** Identifies our envelope to anything reading the file. */
export const EXPORT_FORMAT_ID = 'open-pilot-logbook';

/**
 * THREE INDEPENDENT VERSION NUMBERS — do not conflate them:
 *
 *  - `formatVersion` (this constant) describes the ENVELOPE: the wrapper keys
 *    below, and how flights and aircraft are arranged inside it. It changes
 *    when the envelope is restructured, even if no record shape changed.
 *  - `schemaVersion` describes the RECORDS inside the envelope (see
 *    domain/flight). It changes when a Flight gains or reshapes a field.
 *  - Dexie's `db.version(n)` (see storage/db) describes INDEXES on disk and
 *    never appears in an export at all.
 *
 * A future release could bump the envelope while flights stay at schema v2, or
 * ship schema v3 records inside an unchanged v1 envelope. The importer in
 * Phase 3b must read both numbers and dispatch on them separately.
 */
export const EXPORT_FORMAT_VERSION = 1;

/** Everything an export writes out. Read from storage, then handed to a pure serializer. */
export interface ExportBundle {
  flights: readonly Flight[];
  /** The full aircraft table. Without it, a restore silently loses every profile. */
  aircraft: readonly Aircraft[];
  /**
   * Hours brought forward from a previous logbook.
   *
   * The only SETTING that travels in a backup, and it earns the exception: a
   * balance left behind on the old device makes every total on the new one
   * wrong, silently, in the exact scenario the backup exists for.
   *
   * Omitted from the file entirely when nothing is carried forward, which is
   * what keeps a zero-balance export byte-identical to one written before this
   * key existed — and is why `formatVersion` did not have to change.
   */
  openingBalance?: OpeningBalance;
}

/** The JSON export envelope, exactly as it appears on disk. */
export interface ExportEnvelope {
  format: typeof EXPORT_FORMAT_ID;
  formatVersion: number;
  schemaVersion: number;
  appVersion: string;
  exportedAt: string;
  flightCount: number;
  flights: unknown[];
  aircraft: unknown[];
  /** Present only when something is actually carried forward. See ExportBundle. */
  openingBalance?: Record<string, number>;
}

/**
 * One bundled choice, never three toggles. Delimiter, decimal mark and the BOM
 * always move together — that is the whole point of the setting.
 *
 * The BOM is present in BOTH variants: it is what stops Excel garbling accented
 * characters in remarks, and there is no variant where we want it off.
 */
export type SpreadsheetFormat = 'standard' | 'european';

export interface SpreadsheetProfile {
  delimiter: string;
  decimal: '.' | ',';
  bom: boolean;
}

export const SPREADSHEET_PROFILES: Record<SpreadsheetFormat, SpreadsheetProfile> = {
  standard: { delimiter: ',', decimal: '.', bom: true },
  european: { delimiter: ';', decimal: ',', bom: true },
};

export type ExportKind = 'json' | 'csv';

export interface JsonExportOptions {
  appVersion: string;
  /**
   * Supplied by the caller, never read from the clock inside the serializer.
   * This is what makes byte-identical output testable: everything else in the
   * envelope is a function of the database alone.
   */
  exportedAt: string;
}

export interface CsvExportOptions {
  spreadsheetFormat: SpreadsheetFormat;
}

/** A column CSV could not represent. Surfaced in the UI, never swallowed. */
export interface ExportWarning {
  key: string;
  message: string;
}

export interface CsvExportResult {
  csv: string;
  warnings: ExportWarning[];
}
