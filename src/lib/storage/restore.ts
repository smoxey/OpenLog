/**
 * Restore — the write half of "either the whole file lands or nothing changes".
 *
 * `import/restore` decides whether a file is acceptable IN FULL; this module
 * applies it. Both halves are needed: vetting without a transaction still loses
 * the logbook if the browser dies between `clear()` and the last write, and a
 * transaction without vetting just rolls back a file we should have refused.
 *
 * Dexie stays confined to `src/lib/storage/`, so this is where the transaction
 * lives rather than in the importer or the UI.
 */
import { db } from './db';
import { DEFAULT_SETTINGS, SETTINGS_KEY, type Settings } from './settings';
import { sanitizeOpeningBalance, type OpeningBalance } from '../domain/openingBalance';
import type { Flight } from '../domain/flight';
import type { Aircraft } from '../domain/aircraft';

/** Vetted contents, as produced by `readBackup`. */
export interface RestoreContents {
  flights: readonly Flight[];
  aircraft: readonly Aircraft[];
  /**
   * The brought-forward balance from the file, or `null`/absent when it carried
   * none — in which case this device's existing balance is left exactly as it
   * is. A file without the key is a file that has nothing to say about it, not
   * a file saying "zero".
   */
  openingBalance?: OpeningBalance | null;
}

export interface RestoreResult {
  ok: boolean;
  flightCount: number;
  aircraftCount: number;
  error?: string;
}


/**
 * Replace the logbook with the contents of a backup.
 *
 * REPLACE, not merge — the entry point already said which of the two this is
 * (Settings has separate Restore and Import entry points), so nothing here ever
 * asks.
 *
 * Everything happens inside ONE read-write transaction spanning both tables.
 * IndexedDB aborts the whole transaction if any step throws or if the tab dies
 * before it commits, so there is no window in which the old flights are gone
 * and the new ones have not arrived. On failure the logbook is exactly as it
 * was, and the caller gets an error rather than an exception.
 *
 * `bulkAdd` rather than `bulkPut`: the tables were just cleared, so a key
 * collision here would mean duplicate ids in the file. `readBackup` already
 * refuses those; this is the belt to its braces, and it aborts the transaction
 * rather than silently collapsing two flights into one.
 *
 * NOTE: this assumes vetted input. It is not a validation boundary — call
 * `readBackup` first.
 */
export async function restoreBackup(contents: RestoreContents): Promise<RestoreResult> {
  const flights = [...contents.flights];
  const aircraft = [...contents.aircraft];
  const balance = contents.openingBalance ?? null;

  try {
    /*
      `db.settings` joins the transaction scope so the brought-forward balance
      lands with the flights or not at all. Writing it afterwards would leave a
      window where a failed restore had already changed what the totals say.
      The row is read and written directly rather than through
      `updateSettings`, which opens its own transaction and would deadlock
      inside this one.
    */
    await db.transaction('rw', db.flights, db.aircraft, db.settings, async () => {
      await db.flights.clear();
      await db.aircraft.clear();
      if (flights.length > 0) await db.flights.bulkAdd(flights);
      if (aircraft.length > 0) await db.aircraft.bulkAdd(aircraft);

      if (balance !== null) {
        const row = await db.settings.get(SETTINGS_KEY);
        const stored = (row?.value as Partial<Settings> | undefined) ?? {};
        const next: Settings = {
          ...DEFAULT_SETTINGS,
          ...stored,
          openingBalance: sanitizeOpeningBalance(balance),
        };
        await db.settings.put({ key: SETTINGS_KEY, value: next });
      }
    });
  } catch (error) {
    return {
      ok: false,
      flightCount: 0,
      aircraftCount: 0,
      error:
        error instanceof Error
          ? `Restore failed and nothing was changed: ${error.message}`
          : 'Restore failed and nothing was changed.',
    };
  }

  return { ok: true, flightCount: flights.length, aircraftCount: aircraft.length };
}
