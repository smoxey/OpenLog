/**
 * Import — the write half of the CSV flow.
 *
 * MERGE, not replace. The entry point already said which of the two this is
 * (Settings has separate Restore and Import entry points), so nothing here asks
 * "merge or replace?" and nothing here clears a table. That is the single
 * difference from `storage/restore`, and it is the whole reason the two are
 * separate functions rather than one with a flag.
 *
 * ALL-OR-NOTHING ANYWAY. Merging is not a licence to land half a file: a
 * partially-imported logbook is one the pilot has to reconcile by hand against
 * a CSV, with no way to tell which rows made it. That is the state the restore
 * work went to considerable lengths to prevent, and there is no reason to hold
 * an import to a lower standard. Everything happens in one transaction across
 * both tables; IndexedDB commits only on completion, so a failure, a closed tab
 * or a dead process leaves the logbook exactly as it was.
 *
 * Dexie stays confined to `src/lib/storage/`, so the transaction lives here
 * rather than in the importer or the UI. Everything upstream of this — parsing,
 * mapping, transforming, planning — is pure.
 *
 * NOTE: this assumes vetted input. It is not a validation boundary; every
 * record has already been through `validateFlight` in `transformRow`.
 */
import { db } from './db';
import { normalizeAircraft, type Aircraft } from '../domain/aircraft';
import type { Flight } from '../domain/flight';

/** Vetted contents, as produced by `buildImportPlan`. */
export interface ImportContents {
  flights: readonly Flight[];
  /** Aircraft the pilot confirmed during the import. */
  aircraft: readonly Aircraft[];
}

export interface ImportResult {
  ok: boolean;
  flightCount: number;
  aircraftCount: number;
  error?: string;
}

/**
 * Add imported flights to the logbook, and remember the aircraft.
 *
 * `bulkAdd` for flights: every imported record carries a freshly generated id,
 * so a key collision here would mean the caller handed us the same record
 * twice. It aborts the transaction rather than silently collapsing two flights
 * into one — the same choice `restoreBackup` makes, for the same reason.
 *
 * `bulkPut` for aircraft: confirming an aircraft during an import is expected
 * to UPDATE what is already known about it. That is the pilot answering a
 * question, not a collision.
 *
 * Existing flights are never touched. Nothing is cleared.
 */
export async function importFlights(contents: ImportContents): Promise<ImportResult> {
  const flights = [...contents.flights];
  // Normalized through the shared domain function, so an aircraft confirmed
  // here is byte-identical to the same aircraft saved from the entry form.
  // Anything without a registration is dropped: it has no primary key, and a
  // blank-keyed record would abort the whole import over a row the pilot never
  // meant to create.
  const aircraft = contents.aircraft
    .map(normalizeAircraft)
    .filter((record) => record.registration !== '');

  try {
    await db.transaction('rw', db.flights, db.aircraft, async () => {
      if (flights.length > 0) await db.flights.bulkAdd(flights);
      if (aircraft.length > 0) await db.aircraft.bulkPut(aircraft);
    });
  } catch (error) {
    return {
      ok: false,
      flightCount: 0,
      aircraftCount: 0,
      error:
        error instanceof Error
          ? `Import failed and nothing was added: ${error.message}`
          : 'Import failed and nothing was added.',
    };
  }

  return { ok: true, flightCount: flights.length, aircraftCount: aircraft.length };
}
