/**
 * Backup freshness — a pure function of the last backup timestamp and the clock.
 *
 * The iOS eviction risk (`Claude Context/HOW_IT_WORKS.md`) is the reason this exists: a
 * logbook that has never been exported is one Safari storage sweep away from
 * gone, and the user has no way to know that without being told.
 *
 * Escalation is deliberately gentle. Nagging a pilot who exported last week
 * trains them to ignore the indicator, which is exactly when it stops working.
 */

export type BackupUrgency = 'never' | 'quiet' | 'gentle' | 'prominent';

/** Days since the last successful export before the indicator changes tone. */
export const GENTLE_AFTER_DAYS = 7;
export const PROMINENT_AFTER_DAYS = 30;

/**
 * "More than a handful of flights" before the never-exported state appears.
 * A pilot trying the app out with one test flight does not need a backup
 * warning; someone with real data does.
 */
export const NEVER_EXPORTED_MIN_FLIGHTS = 4;

const MS_PER_DAY = 86_400_000;

export interface BackupStatus {
  urgency: BackupUrgency;
  /** Whole days since the last export; null when never exported. */
  daysSince: number | null;
  /** True when the indicator should be rendered at all. */
  visible: boolean;
}

export function daysSince(lastBackupAt: string, now: Date): number | null {
  const then = Date.parse(lastBackupAt);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / MS_PER_DAY));
}

/**
 * Decide how loudly to ask for a backup.
 *
 * Never exported + a real logbook -> "never" (visible, prominent in the UI).
 * Never exported + almost no data -> hidden; nothing worth losing yet.
 * An unparseable stored timestamp is treated as "never" rather than trusted.
 */
export function backupStatus(
  lastBackupAt: string | null,
  now: Date,
  flightCount: number,
): BackupStatus {
  const days = lastBackupAt ? daysSince(lastBackupAt, now) : null;

  if (days === null) {
    const worthWarningAbout = flightCount >= NEVER_EXPORTED_MIN_FLIGHTS;
    return { urgency: 'never', daysSince: null, visible: worthWarningAbout };
  }
  if (days >= PROMINENT_AFTER_DAYS) return { urgency: 'prominent', daysSince: days, visible: true };
  if (days >= GENTLE_AFTER_DAYS) return { urgency: 'gentle', daysSince: days, visible: true };
  return { urgency: 'quiet', daysSince: days, visible: flightCount > 0 };
}

/** Short human label for the indicator. */
export function backupLabel(status: BackupStatus): string {
  if (status.urgency === 'never') return 'Never backed up';
  if (status.daysSince === 0) return 'Backed up today';
  if (status.daysSince === 1) return 'Backed up yesterday';
  return `Last backup ${status.daysSince} days ago`;
}
