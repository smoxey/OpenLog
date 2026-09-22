/**
 * Migration scaffold.
 *
 * `migrateFlight` upgrades any stored/imported record to the CURRENT schema
 * version. For v1 there is nothing to do, but the machinery exists now so that
 * future schema bumps are a single new entry in `MIGRATIONS` — no changes to
 * the storage layer or call sites.
 */
import {
  CURRENT_SCHEMA_VERSION,
  V2_ADDED_FIELDS,
  V3_ADDED_FIELDS,
  V3_ADDED_FIELD_DEFAULTS,
  type Flight,
} from './flight';

/** Thrown when a record cannot be migrated to the current schema version. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** A record at some (possibly older) schema version. */
type VersionedRecord = { schemaVersion: number } & Record<string, unknown>;

/**
 * Each migration takes a record at version `N` and returns it at version `N+1`.
 * Steps are pure: they never mutate the record they are given.
 *
 * Adding v3 is one more entry here — `2: (r) => ...` — and nothing else in the
 * codebase changes, because the loop below walks the chain.
 */
const MIGRATIONS: Record<number, (record: VersionedRecord) => VersionedRecord> = {
  /**
   * v1 -> v2: the six EASA pilot-function and operational-condition time
   * columns became core fields.
   *
   * Records written by an early build may already carry one of these keys
   * inside `extra` (that was the documented way to add a field before v2), so
   * hoist any such value onto the core field and remove it from `extra`. A
   * hoisted value always wins over the `0` default, and the key never ends up
   * in both places.
   */
  1: (record) => {
    const extra = { ...((record.extra as Record<string, unknown>) ?? {}) };
    const migrated: VersionedRecord = { ...record, schemaVersion: 2 };

    for (const key of V2_ADDED_FIELDS) {
      const hoisted = extra[key];
      migrated[key] = hoisted === undefined ? 0 : hoisted;
      delete extra[key];
    }

    migrated.extra = extra;
    return migrated;
  },

  /**
   * v2 -> v3: FSTD (simulator) entries arrived.
   *
   * Every pre-v3 record is a flight by definition — simulator entries could not
   * be expressed before this version — so `entryType` becomes `'flight'` and
   * the two simulator fields are zeroed/blanked. The record's MEANING is
   * unchanged, which is what makes this safe to run over a 2026 backup in 2030.
   *
   * As with v1 -> v2, a same-named key already sitting in `extra` (the
   * documented way to carry a field before it became core) is hoisted onto the
   * core field and removed from `extra`, so the key never ends up in both.
   */
  2: (record) => {
    const extra = { ...((record.extra as Record<string, unknown>) ?? {}) };
    const migrated: VersionedRecord = { ...record, schemaVersion: 3 };

    for (const key of V3_ADDED_FIELDS) {
      const hoisted = extra[key];
      migrated[key] = hoisted === undefined ? V3_ADDED_FIELD_DEFAULTS[key] : hoisted;
      delete extra[key];
    }

    migrated.extra = extra;
    return migrated;
  },
};

/**
 * Upgrade a record to `CURRENT_SCHEMA_VERSION`. Passthrough for current-version
 * records; throws `MigrationError` for anything that can't be reached (missing
 * version, a newer version than this build understands, or a gap with no
 * registered migration step).
 */
export function migrateFlight(record: unknown): Flight {
  if (record === null || typeof record !== 'object') {
    throw new MigrationError('Cannot migrate a non-object record.');
  }

  const version = (record as Partial<VersionedRecord>).schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new MigrationError('Record is missing a valid integer schemaVersion.');
  }
  if (version < 1) {
    throw new MigrationError(`Unknown schema version ${version}: below the minimum (1).`);
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new MigrationError(
      `Record schema version ${version} is newer than this build supports ` +
        `(${CURRENT_SCHEMA_VERSION}). Update the app to read this data.`,
    );
  }

  let current = record as VersionedRecord;
  while (current.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[current.schemaVersion];
    if (!step) {
      throw new MigrationError(
        `No migration registered from schema version ${current.schemaVersion}.`,
      );
    }
    current = step(current);
  }

  return current as unknown as Flight;
}
