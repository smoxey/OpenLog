/**
 * Dexie/IndexedDB definition.
 *
 * This file and its siblings in `src/lib/storage/` are the ONLY place that
 * touches Dexie. The rest of the app imports the API from `./index` and never
 * imports Dexie directly — keeping the door open to swapping the backend later
 * (e.g. Capacitor native storage).
 */
import Dexie, { type Table } from 'dexie';
import type { Flight } from '../domain/flight';
import type { Aircraft } from '../domain/aircraft';

/** A key/value row for persisted app settings. */
export interface SettingsRow {
  key: string;
  value: unknown;
}

export class LogbookDatabase extends Dexie {
  flights!: Table<Flight, string>;
  settings!: Table<SettingsRow, string>;
  aircraft!: Table<Aircraft, string>;

  constructor(name = 'open-pilot-logbook') {
    super(name);
    /**
     * IMPORTANT: Dexie's `version(n)` and the record-level `schemaVersion` are
     * two SEPARATE numbers that change for different reasons. Do not conflate
     * them, and do not try to keep them in step.
     *
     *  - `version(n)` here describes the INDEXES of the IndexedDB object
     *    stores. Bump it only when the index definitions below change, i.e.
     *    when a field needs to become queryable.
     *  - `schemaVersion` (see ../domain/flight) describes the SHAPE of a
     *    Flight record. It is bumped whenever fields are added or reshaped,
     *    and it travels with the record into CSV/JSON exports so an old backup
     *    still imports years later.
     *
     * Schema v2 added six core time fields but indexed none of them, which is
     * why record schemaVersion 2 first shipped on Dexie version 1. Records are
     * upgraded on read by `migrateFlight`, not by a Dexie upgrade hook — that
     * keeps migration identical for data read from IndexedDB and data read
     * from an imported file.
     *
     * Phase 2b bumps Dexie to version 2 because a NEW OBJECT STORE (`aircraft`)
     * appeared — an index change. The record-level `schemaVersion` stays at 2,
     * because the Flight shape did not change: SE/ME time is derived at entry
     * into fields that already existed. The two numbers moving independently
     * like this is exactly why they are kept separate.
     *
     * Every past version stays declared below; Dexie needs the chain to upgrade
     * a database created by an older build. Adding the store needs no upgrade
     * function — an empty `aircraft` table is the correct starting state, and
     * unknown registrations simply prompt on first use.
     *
     * Indexes: flights keyed by `id`, plus `date` and `offBlock` for sorting;
     * aircraft keyed by normalized `registration` (see domain/aircraft).
     */
    this.version(1).stores({
      flights: 'id, date, offBlock',
      settings: 'key',
    });
    this.version(2).stores({
      flights: 'id, date, offBlock',
      settings: 'key',
      aircraft: 'registration',
    });
  }
}

export const db = new LogbookDatabase();
