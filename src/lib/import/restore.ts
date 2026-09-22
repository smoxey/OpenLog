/**
 * Restore from backup — reading and vetting a JSON backup file.
 *
 * THE GOVERNING RULE: a restore must never leave the logbook in a state that is
 * neither the old one nor the new one. Either the whole file lands or nothing
 * changes. This module is the first half of that guarantee: it decides whether a
 * file is acceptable IN FULL before a single record is written. The second half
 * is the transaction in `storage/restore`.
 *
 * That is why every failure here rejects the WHOLE file. Restoring the eleven
 * records that happened to parse, out of a file of twelve, would produce a
 * logbook that never existed — worse than refusing, because the user would
 * believe they had their data back.
 *
 * This module is PURE. No storage, no settings, no clock, no DOM. A bad file is
 * an ordinary outcome rather than an exception, so nothing here throws: callers
 * get a rejection they can put in front of a pilot.
 *
 * JSON only. CSV is a different job with a different guarantee (see the export
 * format policy in `Claude Context/HOW_IT_WORKS.md`) and a different entry point.
 */
import { migrateFlight } from '../domain/migrate';
import { validateFlight } from '../validation/validate';
import { EXPORT_FORMAT_ID, EXPORT_FORMAT_VERSION } from '../export/types';
import { readOpeningBalance } from '../domain/openingBalance';
import type { OpeningBalance } from '../domain/openingBalance';
import type { Flight } from '../domain/flight';
import type { Aircraft } from '../domain/aircraft';

/** How many individual record failures are quoted before the list is truncated. */
const MAX_REPORTED_DETAILS = 5;

/** What the file says about itself, for display before anything is committed. */
export interface BackupSummary {
  flightCount: number;
  aircraftCount: number;
  /** May be an empty string on a file that omitted it. */
  exportedAt: string;
  appVersion: string;
  formatVersion: number;
  /** Every distinct record schema version found in the file, ascending. */
  schemaVersions: number[];
}

export type RejectionCode =
  | 'not-json'
  | 'looks-like-csv'
  | 'not-a-backup'
  | 'future-format'
  | 'count-mismatch'
  | 'duplicate-ids'
  | 'migration-failed'
  | 'invalid-records'
  | 'invalid-aircraft'
  | 'invalid-opening-balance';

/** Why a file was refused, in words a pilot can act on. */
export interface BackupRejection {
  code: RejectionCode;
  message: string;
  /** Per-record specifics, already truncated for display. */
  details: string[];
}

export type BackupReadResult =
  | {
      ok: true;
      flights: Flight[];
      aircraft: Aircraft[];
      /**
       * The brought-forward balance the file carried, or `null` when it carried
       * none. NULL IS NOT ZERO: a file written before this key existed, or by a
       * logbook that starts from zero, must leave whatever balance this device
       * already has alone rather than wiping it.
       */
      openingBalance: OpeningBalance | null;
      summary: BackupSummary;
    }
  | { ok: false; rejection: BackupRejection };

function reject(code: RejectionCode, message: string, details: string[] = []): BackupReadResult {
  return { ok: false, rejection: { code, message, details } };
}

/** Trim the detail list for display and say how many were left out. */
function summarizeDetails(all: string[]): string[] {
  if (all.length <= MAX_REPORTED_DETAILS) return all;
  const shown = all.slice(0, MAX_REPORTED_DETAILS);
  shown.push(`…and ${all.length - MAX_REPORTED_DETAILS} more.`);
  return shown;
}

/**
 * Does this look like a spreadsheet rather than a backup?
 *
 * Only consulted once JSON parsing has already failed, so a real backup can
 * never reach it. The point is a specific message — "this looks like a
 * spreadsheet" — instead of a parser error the user cannot act on.
 */
function looksLikeCsv(text: string): boolean {
  const body = text.replace(/^﻿/, '').trimStart();
  if (body.startsWith('{') || body.startsWith('[')) return false;
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  if (!firstLine) return false;
  // Two or more separators means three or more columns: a table, not prose.
  for (const delimiter of [',', ';', '\t']) {
    if (firstLine.split(delimiter).length >= 3) return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read the aircraft table out of the envelope.
 *
 * Absent or empty is legitimate — an early export, or a logbook where no
 * aircraft was ever confirmed — and leaves the table empty. A malformed entry
 * is not legitimate: dropping it silently would lose a profile the user
 * believes they backed up.
 */
function readAircraft(raw: unknown): { aircraft: Aircraft[] } | { errors: string[] } {
  if (raw === undefined || raw === null) return { aircraft: [] };
  if (!Array.isArray(raw)) return { errors: ['"aircraft" is present but is not a list.'] };

  const aircraft: Aircraft[] = [];
  const errors: string[] = [];

  raw.forEach((entry, index) => {
    const at = `Aircraft ${index + 1}`;
    if (!isPlainObject(entry)) {
      errors.push(`${at}: not a record.`);
      return;
    }
    const registration = entry.registration;
    if (typeof registration !== 'string' || registration.trim() === '') {
      errors.push(`${at}: missing a registration.`);
      return;
    }
    aircraft.push({
      registration,
      type: typeof entry.type === 'string' ? entry.type : '',
      // Anything that is not the literal "ME" files as SE, matching upsertAircraft.
      class: entry.class === 'ME' ? 'ME' : 'SE',
      multiPilot: entry.multiPilot === true,
    });
  });

  return errors.length > 0 ? { errors } : { aircraft };
}

/**
 * Vet a backup file and return its contents ready to write.
 *
 * Records below the current schema version are migrated on the way through, so
 * a backup written in 2026 restores correctly years later — that is the whole
 * point of `schemaVersion`, and migration happens HERE rather than in the
 * writer so that a file which cannot be migrated is refused before anything is
 * destroyed.
 *
 * Never throws. Never reads the clock. Does not mutate its input.
 */
export function readBackup(text: unknown): BackupReadResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return reject('not-json', 'That file is empty.');
  }

  let parsed: unknown;
  try {
    // Strip a BOM: our own export writes one for CSV, and some editors add one
    // to JSON. JSON.parse treats it as a syntax error.
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    if (looksLikeCsv(text)) {
      return reject(
        'looks-like-csv',
        'That looks like a spreadsheet, not a backup. Restoring needs the JSON file — the one labelled "JSON backup" when you exported.',
      );
    }
    return reject('not-json', 'That file could not be read. A backup is a .json file written by this app.');
  }

  if (!isPlainObject(parsed)) {
    return reject('not-a-backup', 'That file is valid JSON, but it is not an Open Pilot Logbook backup.');
  }

  if (parsed.format !== EXPORT_FORMAT_ID) {
    return reject(
      'not-a-backup',
      'That file is not an Open Pilot Logbook backup. Restoring only accepts a JSON file this app exported.',
    );
  }

  const formatVersion = parsed.formatVersion;
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
    return reject('not-a-backup', 'That backup is missing its format version, so it cannot be read safely.');
  }
  // Refuse a future envelope outright. A partial read of a format we do not
  // know would be a guess, and this is the one operation where a guess costs
  // the user their logbook.
  if (formatVersion > EXPORT_FORMAT_VERSION) {
    return reject(
      'future-format',
      `That backup was written by a newer version of the app (format ${formatVersion}; this build reads ${EXPORT_FORMAT_VERSION}). Update the app, then restore.`,
    );
  }

  const rawFlights = parsed.flights;
  if (!Array.isArray(rawFlights)) {
    return reject('not-a-backup', 'That backup has no flight list, so there is nothing to restore.');
  }

  // A stated count that disagrees with the list means the file was edited or
  // truncated. A truncated backup that restores "successfully" is the worst
  // outcome available, so this is a refusal rather than a warning.
  const statedCount = parsed.flightCount;
  if (typeof statedCount !== 'number' || !Number.isInteger(statedCount)) {
    return reject('not-a-backup', 'That backup is missing its flight count, so it cannot be checked for damage.');
  }
  if (statedCount !== rawFlights.length) {
    return reject(
      'count-mismatch',
      `That backup looks damaged: it says it holds ${statedCount} flights but contains ${rawFlights.length}. Nothing has been changed.`,
    );
  }

  // --- Migrate ------------------------------------------------------------
  const migrated: Flight[] = [];
  const migrationErrors: string[] = [];
  const schemaVersions = new Set<number>();

  rawFlights.forEach((record, index) => {
    if (isPlainObject(record) && typeof record.schemaVersion === 'number') {
      schemaVersions.add(record.schemaVersion);
    }
    try {
      migrated.push(migrateFlight(record));
    } catch (error) {
      migrationErrors.push(
        `Flight ${index + 1}: ${error instanceof Error ? error.message : 'could not be upgraded.'}`,
      );
    }
  });

  if (migrationErrors.length > 0) {
    return reject(
      'migration-failed',
      `${migrationErrors.length} of ${rawFlights.length} flights could not be upgraded to the current format, so nothing was restored.`,
      summarizeDetails(migrationErrors),
    );
  }

  // --- Validate -----------------------------------------------------------
  // The same rules every hand-entered flight passes. This is what catches a
  // hand-edited backup before it reaches storage.
  const vetted: Flight[] = [];
  const validationErrors: string[] = [];

  migrated.forEach((record, index) => {
    const { errors, normalized } = validateFlight(record);
    if (errors.length > 0) {
      validationErrors.push(`Flight ${index + 1}: ${errors[0].message}`);
      return;
    }
    // Keep the NORMALIZED record: it is exactly what the app would have written
    // had the flight been typed in, so a restore cannot introduce a record the
    // entry form could never have produced.
    vetted.push(normalized);
  });

  if (validationErrors.length > 0) {
    return reject(
      'invalid-records',
      `${validationErrors.length} of ${migrated.length} flights in that backup are not valid, so nothing was restored.`,
      summarizeDetails(validationErrors),
    );
  }

  // Ids are the primary key. Duplicates would silently collapse into one record
  // on write, quietly losing a flight — refuse instead.
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const flight of vetted) {
    if (seen.has(flight.id)) duplicates.add(flight.id);
    seen.add(flight.id);
  }
  if (duplicates.size > 0) {
    return reject(
      'duplicate-ids',
      `That backup contains ${duplicates.size} repeated flight ${duplicates.size === 1 ? 'id' : 'ids'}, which would lose records on restore. Nothing was changed.`,
      summarizeDetails([...duplicates].map((id) => `Repeated id: ${id}`)),
    );
  }

  // --- Aircraft -----------------------------------------------------------
  const aircraftResult = readAircraft(parsed.aircraft);
  if ('errors' in aircraftResult) {
    return reject(
      'invalid-aircraft',
      `The aircraft list in that backup is damaged (${aircraftResult.errors.length} ${aircraftResult.errors.length === 1 ? 'entry' : 'entries'}), so nothing was restored.`,
      summarizeDetails(aircraftResult.errors),
    );
  }

  // --- Opening balance ----------------------------------------------------
  // Refused rather than repaired, like the aircraft list above: silently
  // dropping half a damaged backup is the one behaviour restore never allows.
  const balanceResult = readOpeningBalance(parsed.openingBalance);
  if ('errors' in balanceResult) {
    return reject(
      'invalid-opening-balance',
      `The brought-forward totals in that backup are damaged (${balanceResult.errors.length} ${balanceResult.errors.length === 1 ? 'figure' : 'figures'}), so nothing was restored.`,
      summarizeDetails(balanceResult.errors),
    );
  }

  return {
    ok: true,
    flights: vetted,
    aircraft: aircraftResult.aircraft,
    openingBalance: balanceResult.balance,
    summary: {
      flightCount: vetted.length,
      aircraftCount: aircraftResult.aircraft.length,
      exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
      appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : '',
      formatVersion,
      schemaVersions: [...schemaVersions].sort((a, b) => a - b),
    },
  };
}
