/**
 * Bulk adjust — the write.
 *
 * ALL-OR-NOTHING, like every other multi-record write in this app. A bulk
 * adjust that landed on 240 of 400 flights would leave a logbook the pilot
 * cannot reconcile against anything: there is no file to compare it with, the
 * way a half-finished import has, and no undo. One Dexie transaction, so a
 * failure, a closed tab or a dead process leaves the logbook exactly as it was.
 *
 * IT VALIDATES EVERY RECORD ON THE WAY IN. This is a rewrite of history, so it
 * goes through the same gate a hand-typed flight does — `applyEntryTypeInvariants`
 * then `validateFlight` — rather than trusting the plan. Anything that fails
 * stops the whole run BEFORE the transaction opens, and the failure names the
 * flight that caused it. The most likely such failure is the real one: PIC,
 * Multi-Pilot and Night may not exceed Total, so filling a column on a record
 * whose total is smaller than the value being written is refused rather than
 * quietly written and left for the next validation to trip over.
 *
 * `bulkPut`, not `bulkAdd`: every record here already exists and is being
 * replaced by an edited copy of itself.
 *
 * The planning is pure and lives in `domain/bulkAdjust`; this file is the only
 * half that knows Dexie exists.
 */
import { db } from './db';
import { applyEntryTypeInvariants } from '../domain/entryType';
import { planResults, type BulkAdjustPlan } from '../domain/bulkAdjust';
import { validateFlight } from '../validation/validate';
import type { Flight } from '../domain/flight';

export interface BulkAdjustResult {
  ok: boolean;
  /** Records rewritten. Zero whenever `ok` is false — nothing partial ever lands. */
  changedCount: number;
  error?: string;
}

const NOTHING_CHANGED = 'Nothing was changed.';

/**
 * Rewrite every record a plan selects.
 *
 * The plan is re-derived into records here rather than accepting records from
 * the caller, so the UI cannot hand this function a set that no longer matches
 * the plan it showed the pilot.
 */
export async function applyBulkAdjust(plan: BulkAdjustPlan): Promise<BulkAdjustResult> {
  if (plan.problem !== undefined) {
    return { ok: false, changedCount: 0, error: `${plan.problem} ${NOTHING_CHANGED}` };
  }

  const records: Flight[] = [];
  for (const candidate of planResults(plan)) {
    const merged = applyEntryTypeInvariants(candidate);
    const { errors, normalized } = validateFlight(merged);
    if (errors.length > 0) {
      const where = `${candidate.date} ${candidate.registration || candidate.simulatorRegistration}`.trim();
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
          ? `The adjustment failed: ${error.message} ${NOTHING_CHANGED}`
          : `The adjustment failed. ${NOTHING_CHANGED}`,
    };
  }

  return { ok: true, changedCount: records.length };
}
