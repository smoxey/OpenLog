/**
 * App settings, persisted in IndexedDB via the same storage module.
 */
import { db } from './db';
import type { AircraftClass } from '../domain/aircraft';
import type { ExportKind, SpreadsheetFormat } from '../export/types';
import {
  EMPTY_OPENING_BALANCE,
  sanitizeOpeningBalance,
  type OpeningBalance,
} from '../domain/openingBalance';
import { isKnownOffset, type ClockDisplay } from '../time/timeOfDay';

export interface Settings {
  /** How durations are shown: decimal hours ("2.3") or hh:mm ("2:18"). */
  durationDisplay: 'decimal' | 'hhmm';
  /**
   * The class ASSUMED when an aircraft's class is unknown — a fallback, not a
   * global override. A known aircraft's own class always wins.
   *
   * Its value is read at the moment of entry and the resolved result is stored
   * on the flight. Changing this setting later must never alter a single
   * existing record; see `domain/derive`.
   */
  defaultAircraftClass: AircraftClass;
  /**
   * CSV delimiter + decimal mark + BOM as ONE bundled choice, never three
   * toggles — they always move together. Affects CSV only; JSON never varies.
   */
  spreadsheetFormat: SpreadsheetFormat;
  /**
   * ISO timestamp of the last SUCCESSFUL export, or null if never exported.
   * A share sheet the user cancels does not write this.
   */
  lastBackupAt: string | null;
  /** Which format that last successful export used. */
  lastBackupFormat: ExportKind | null;
  /**
   * Whether simulator entries appear in the main list.
   *
   * A DISPLAY setting and nothing more. Hiding them changes the visible list
   * only — the records stay in storage and in every JSON and CSV export,
   * because export never depends on a display preference. Anything that reads
   * this to decide what to EXPORT is a bug.
   */
  showSimulatorEntries: boolean;
  /**
   * Hours flown before this logbook began, keyed by registry field key.
   *
   * A SETTING, not a flight — see `domain/openingBalance` for why a synthetic
   * "previous logbook" record was rejected. It applies to the all-time totals
   * and to nothing else: not to a date range, not to a breakdown, not to
   * currency.
   *
   * Unlike every other setting here, this one TRAVELS IN THE JSON BACKUP. A
   * balance that stayed on one device would silently make every total wrong
   * after a restore on a new phone, which is the exact failure the backup story
   * exists to prevent.
   */
  openingBalance: OpeningBalance;
  /**
   * Whether the entry form fills in night time by itself.
   *
   * A BEHAVIOUR setting, and nothing more. It decides whether the form offers a
   * figure before being asked; the button beside the field works either way,
   * and the pilot's value is what gets stored in every case. It does not travel
   * in the JSON backup — the opening balance remains the only setting that
   * does — and no export has ever read it.
   */
  autoNight: boolean;
  /**
   * Which clock times of day are shown and typed on: 24-hour, or 12-hour with
   * am/pm.
   *
   * A DISPLAY setting, in the same family as `durationDisplay` and under the
   * same rule: what is stored never varies. Every record holds `"HH:MM"` on the
   * 24-hour clock, every export writes that, and the printed EASA page uses it
   * whatever this says — it is a facsimile of an official document, not a view
   * of the app. Anything that reads this to decide what to STORE or EXPORT is a
   * bug.
   */
  clockDisplay: ClockDisplay;
  /**
   * The zone the entry form ASSUMES you are typing block times in, as minutes
   * east of UTC. `0` means UTC, which is what a logbook records.
   *
   * Not a property of any flight — the records stay in UTC and carry no zone —
   * but of the pilot doing the typing, which is why it lives here and not on
   * `Flight`. It is remembered because a pilot who logs in local time logs in
   * local time every day, and re-picking the zone on every entry would be a
   * question already answered. The form states the UTC it will store beneath
   * the field, so a remembered offset is never a silent one.
   *
   * Sanitized on the way in and out against `UTC_OFFSETS`: this is a number
   * that arithmetic is done with, and a damaged one would move flights onto the
   * wrong day.
   */
  entryTimeZoneOffset: number;
}

export const DEFAULT_SETTINGS: Settings = {
  durationDisplay: 'decimal',
  defaultAircraftClass: 'ME',
  spreadsheetFormat: 'standard',
  lastBackupAt: null,
  lastBackupFormat: null,
  // Shown by default: hiding a pilot's own records without being asked to is
  // more surprising than a longer list.
  showSimulatorEntries: true,
  // Empty: a logbook that starts from zero, which is the behaviour the app had
  // before this setting existed.
  openingBalance: EMPTY_OPENING_BALANCE,
  // On: the whole point of the feature is not having to think about it. It
  // fills a field the pilot can still change, so being wrong costs a tap.
  autoNight: true,
  // 24-hour: it is what aviation runs on, what every stored record already
  // holds, and what an EASA logbook is written in. The 12-hour clock is
  // available for anyone who thinks in it, and changes nothing but the display.
  clockDisplay: '24h',
  // UTC: a logbook records UTC, so the form's resting state must be the thing
  // it stores. Local time is a choice the pilot makes and can see.
  entryTimeZoneOffset: 0,
};

/** The single settings row's key. Exported so the restore transaction can
 *  write the row directly without opening a second one. */
export const SETTINGS_KEY = 'app';

/**
 * Current settings, merged over defaults.
 *
 * The opening balance is sanitized on the way out rather than trusted: it is
 * the one setting that can arrive from a FILE, so an unrecognised column or a
 * fractional value must be dropped here rather than reaching a total.
 */
export async function getSettings(): Promise<Settings> {
  const row = await db.settings.get(SETTINGS_KEY);
  const stored = (row?.value as Partial<Settings> | undefined) ?? {};
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  return {
    ...merged,
    openingBalance: sanitizeOpeningBalance(merged.openingBalance),
    // Falls back to UTC rather than to whatever was stored. An offset this app
    // does not offer cannot have come from its own UI, and UTC is the one value
    // that can never file a flight on the wrong day.
    entryTimeZoneOffset: isKnownOffset(merged.entryTimeZoneOffset)
      ? merged.entryTimeZoneOffset
      : DEFAULT_SETTINGS.entryTimeZoneOffset,
  };
}

/** Apply a partial settings update and return the merged result. */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const merged: Settings = { ...(await getSettings()), ...patch };
  // Sanitize on the way IN as well as out, so a bad figure never reaches disk.
  const next: Settings = {
    ...merged,
    openingBalance: sanitizeOpeningBalance(merged.openingBalance),
    entryTimeZoneOffset: isKnownOffset(merged.entryTimeZoneOffset)
      ? merged.entryTimeZoneOffset
      : DEFAULT_SETTINGS.entryTimeZoneOffset,
  };
  await db.settings.put({ key: SETTINGS_KEY, value: next });
  return next;
}
