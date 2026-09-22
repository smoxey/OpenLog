/**
 * Delete everything — the only operation in the app whose entire purpose is to
 * destroy data.
 *
 * There is no server, no cloud copy and no undo. Once this runs, a logbook that
 * was never exported is gone for good. Everything about how it is presented —
 * the typed confirmation, the counts, the offer to back up first — exists
 * because of that one fact, and none of it should be softened for convenience.
 *
 * WHAT IT DELETES: flights and aircraft. That is the logbook, and it is the
 * personal data — which matters for the case where someone is wiping a device
 * before handing it on.
 *
 * WHAT IT KEEPS: the display preferences (duration format, default aircraft
 * class, spreadsheet format). They are not logbook data, losing them helps
 * nobody, and having to set them up again after a deliberate reset would be a
 * small insult on top of a large action.
 *
 * WHAT IT RESETS: `lastBackupAt` and `lastBackupFormat`. Keeping them would
 * leave the app claiming a backup that covers a logbook which no longer exists —
 * so the next flight entered would show "backed up 3 days ago" about data that
 * was never in any backup. An empty logbook has never been backed up, and the
 * reminder should say so.
 *
 * One transaction, so a failure leaves the logbook whole rather than half
 * erased. The same standard as restore and import.
 */
import { db } from './db';

/** The single settings row's key. Must match `storage/settings.ts`. */
const SETTINGS_KEY = 'app';

export interface DeleteAllResult {
  ok: boolean;
  /** What was destroyed, for confirming it afterwards. */
  flightCount: number;
  aircraftCount: number;
  error?: string;
}

/**
 * Erase the logbook.
 *
 * Counts are read INSIDE the transaction, so the number reported is what was
 * actually deleted rather than what happened to be there when the dialog was
 * opened.
 */
export async function deleteAllData(): Promise<DeleteAllResult> {
  let flightCount = 0;
  let aircraftCount = 0;

  try {
    await db.transaction('rw', db.flights, db.aircraft, db.settings, async () => {
      flightCount = await db.flights.count();
      aircraftCount = await db.aircraft.count();

      await db.flights.clear();
      await db.aircraft.clear();

      // Preferences survive; the backup stamp does not. See the module note.
      // Only touched when a settings row already exists — deleting must not
      // invent preferences that were never set.
      const stored = await db.settings.get(SETTINGS_KEY);
      const value = stored?.value;
      if (value && typeof value === 'object') {
        await db.settings.put({
          key: SETTINGS_KEY,
          value: { ...(value as Record<string, unknown>), lastBackupAt: null, lastBackupFormat: null },
        });
      }
    });
  } catch (error) {
    return {
      ok: false,
      flightCount: 0,
      aircraftCount: 0,
      error:
        error instanceof Error
          ? `Nothing was deleted: ${error.message}`
          : 'Nothing was deleted.',
    };
  }

  return { ok: true, flightCount, aircraftCount };
}
