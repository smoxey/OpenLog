/**
 * Bulk night time — the write.
 *
 * ALL-OR-NOTHING, like every other multi-record write in this app. One Dexie
 * transaction, so a failure, a closed tab or a dead process leaves the logbook
 * exactly as it was. A run that landed on 300 of 900 flights would leave a
 * logbook the pilot cannot reconcile against anything — there is no file to
 * compare it with the way a half-finished import has, and there is no undo.
 *
 * IT VALIDATES EVERY RECORD ON THE WAY IN, through the same gate a hand-typed
 * flight goes through: `applyEntryTypeInvariants`, then `validateFlight`.
 * Anything that fails stops the whole run BEFORE the transaction opens, and the
 * failure names the flight that caused it. The relevant rule here is that night
 * may not exceed total — `suggestNightForEntry` already caps it, so a failure
 * would mean a record whose own total is inconsistent, and that is worth
 * refusing loudly rather than writing over.
 *
 * `bulkPut`, not `bulkAdd`: every record here already exists and is being
 * replaced by an edited copy of itself.
 *
 * Deliberately parallel to `storage/bulkAdjust` rather than sharing its body.
 * The two are the same shape because they make the same promise, but they
 * rewrite the logbook with no undo, and folding them into one helper to save
 * thirty lines would put both tools' correctness in one place where a change
 * made for one could quietly alter the other.
 *
 * The planning is pure and lives in `domain/bulkNight`; this file is the only
 * half that knows Dexie exists.
 */
import { db } from './db';
import { applyEntryTypeInvariants } from '../domain/entryType';
import { nightPlanResults, type BulkNightPlan } from '../domain/bulkNight';
import { validateFlight } from '../validation/validate';
import type { Flight } from '../domain/flight';

export interface BulkNightResult {
  ok: boolean;
  /** Records rewritten. Zero whenever `ok` is false — nothing partial ever lands. */
  changedCount: number;
  error?: string;
}

const NOTHING_CHANGED = 'Nothing was changed.';

/**
 * Write the night figure the plan worked out to every flight it selects.
 *
 * The plan is re-derived into records here rather than accepting records from
 * the caller, so the UI cannot hand this function a set that no longer matches
 * the plan it showed the pilot.
 */
export async function applyBulkNight(plan: BulkNightPlan): Promise<BulkNightResult> {
  if (plan.problem !== undefined) {
    return { ok: false, changedCount: 0, error: `${plan.problem} ${NOTHING_CHANGED}` };
  }

  const records: Flight[] = [];
  for (const candidate of nightPlanResults(plan)) {
    const merged = applyEntryTypeInvariants(candidate);
    const { errors, normalized } = validateFlight(merged);
    if (errors.length > 0) {
      const where = `${candidate.date} ${candidate.depAerodrome}–${candidate.arrAerodrome}`.trim();
      return {
        ok: false,
        changedCount: 0,
        error: `${where || 'One entry'} would become invalid: ${errors[0].message} ${NOTHING_CHANGED}`,
      };
    }
    records.push(normalized);
  }

  if (records.length === 0) {
    return { ok: false, changedCount: 0, error: `Nothing to change. ${NOTHING_CHANGED}` };
  }

  try {
    await db.transaction('rw', db.flights, async () => {
      await db.flights.bulkPut(records);
    });
  } catch (error) {
    return {
      ok: false,
      changedCount: 0,
      error:
        error instanceof Error
          ? `Writing the night times failed: ${error.message} ${NOTHING_CHANGED}`
          : `Writing the night times failed. ${NOTHING_CHANGED}`,
    };
  }

  return { ok: true, changedCount: records.length };
}
