/**
 * Reactive settings store (Svelte 5 runes). Wraps the persisted settings from
 * the storage layer so the list, totals, form, and duration inputs all react
 * immediately when a setting changes.
 */
import { getSettings, updateSettings, DEFAULT_SETTINGS, type Settings } from '../storage';
import type { AircraftClass } from '../domain/aircraft';
import type { OpeningBalance } from '../domain/openingBalance';
import type { ExportKind, SpreadsheetFormat } from '../export/types';
import type { DurationDisplay } from '../format';
import type { ClockDisplay } from '../time/timeOfDay';

let current = $state<Settings>({ ...DEFAULT_SETTINGS });
let ready = $state(false);

export const settings = {
  get durationDisplay(): DurationDisplay {
    return current.durationDisplay;
  },
  /**
   * Fallback class for aircraft whose class is unknown. Read at the moment of
   * entry; the resolved value is then stored on the flight, so changing this
   * never alters an existing record.
   */
  get defaultAircraftClass(): AircraftClass {
    return current.defaultAircraftClass;
  },
  /** CSV delimiter/decimal/BOM bundle. Affects CSV export only. */
  get spreadsheetFormat(): SpreadsheetFormat {
    return current.spreadsheetFormat;
  },
  /** ISO timestamp of the last successful export, or null if never exported. */
  get lastBackupAt(): string | null {
    return current.lastBackupAt;
  },
  get lastBackupFormat(): ExportKind | null {
    return current.lastBackupFormat;
  },
  /**
   * Whether simulator entries are shown in the list. Display only — the
   * exporters never read this.
   */
  get showSimulatorEntries(): boolean {
    return current.showSimulatorEntries;
  },
  /**
   * Hours brought forward from a previous logbook, keyed by registry field key.
   *
   * Applies to the ALL-TIME totals only — never to a range, a breakdown or
   * currency. See `domain/openingBalance`.
   */
  get openingBalance(): OpeningBalance {
    return current.openingBalance;
  },
  /**
   * Whether the entry form works night time out by itself. Behaviour only —
   * the button beside the field works either way, and no export reads this.
   */
  get autoNight(): boolean {
    return current.autoNight;
  },
  /**
   * The clock times of day are shown and typed on. Display only — records,
   * exports and the printed EASA page are all 24-hour whatever this says.
   */
  get clockDisplay(): ClockDisplay {
    return current.clockDisplay;
  },
  /**
   * The zone the entry form assumes block times are typed in, minutes east of
   * UTC. The form converts to UTC before saving; nothing stored carries a zone.
   */
  get entryTimeZoneOffset(): number {
    return current.entryTimeZoneOffset;
  },
  get ready(): boolean {
    return ready;
  },
};

/** Re-read persisted settings — used after an export writes `lastBackupAt`. */
export async function refreshSettings(): Promise<void> {
  current = await getSettings();
}

/** Load persisted settings once at startup. */
export async function loadSettings(): Promise<void> {
  current = await getSettings();
  ready = true;
}

/** Change and persist the duration display format. */
export async function setDurationDisplay(mode: DurationDisplay): Promise<void> {
  current = await updateSettings({ durationDisplay: mode });
}

/** Change and persist the fallback aircraft class. Existing flights are untouched. */
export async function setDefaultAircraftClass(value: AircraftClass): Promise<void> {
  current = await updateSettings({ defaultAircraftClass: value });
}

/** Change and persist the CSV spreadsheet format bundle. JSON is unaffected. */
export async function setSpreadsheetFormat(value: SpreadsheetFormat): Promise<void> {
  current = await updateSettings({ spreadsheetFormat: value });
}

/**
 * Change and persist the brought-forward totals.
 *
 * Values are integer minutes for durations and integer counts for landings —
 * the same units the records use, so nothing downstream has to convert.
 */
export async function setOpeningBalance(value: OpeningBalance): Promise<void> {
  current = await updateSettings({ openingBalance: value });
}

/**
 * Show or hide simulator entries in the list. Affects the visible list ONLY —
 * hidden entries are still stored and still exported.
 */
export async function setShowSimulatorEntries(value: boolean): Promise<void> {
  current = await updateSettings({ showSimulatorEntries: value });
}

/**
 * Turn the automatic night-time calculation on or off.
 *
 * Off means the entry form stops offering a figure unasked; the button beside
 * the field still works, and nothing already stored changes.
 */
export async function setAutoNight(value: boolean): Promise<void> {
  current = await updateSettings({ autoNight: value });
}

/**
 * Change and persist the clock. Nothing already stored changes — every record
 * keeps the 24-hour UTC `"HH:MM"` it was saved with.
 */
export async function setClockDisplay(value: ClockDisplay): Promise<void> {
  current = await updateSettings({ clockDisplay: value });
}

/**
 * Remember the zone the entry form types block times in.
 *
 * Written when the pilot changes the selector on the form, so the next entry
 * opens where the last one left off. It changes nothing already saved: the
 * conversion happens in the form, and what reaches storage is always UTC.
 */
export async function setEntryTimeZoneOffset(value: number): Promise<void> {
  current = await updateSettings({ entryTimeZoneOffset: value });
}
