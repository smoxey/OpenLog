/**
 * The Flight record — schema v3.
 *
 * Every flight (and every future export) carries a `schemaVersion` so records
 * can be migrated forward over time. Unknown / future fields live in `extra`,
 * which the storage layer preserves untouched through all reads and writes.
 * This is what lets later phases add logbook fields without restructuring the
 * database or breaking old exports.
 *
 * v1 -> v2 promoted the six remaining EASA pilot-function and operational-
 * condition time columns from `extra` to core fields.
 * v2 -> v3 added FSTD (simulator) entries. See `./migrate`.
 */

/** The schema version this build reads and writes. */
export const CURRENT_SCHEMA_VERSION = 3;

/**
 * What kind of logbook entry this record is.
 *
 * THE GOVERNING RULE: simulator time is never flight time. It is separate,
 * counts only as simulator time, and is never summed into flight totals or
 * currency. A pilot's total flight time must be identical before and after
 * logging a simulator session.
 *
 * The mechanism is this discriminator rather than a second table. Because an
 * FSTD entry stores `totalMinutes: 0`, every existing total already excludes
 * simulator time with NO change to the summing logic — that is the whole point
 * of the design, and it is why you should never find an `entryType` check
 * inside totals code.
 */
export type EntryType = 'flight' | 'fstd';

/** The literal filed into both aerodrome columns on an FSTD entry. */
export const SIMULATOR_AERODROME = 'SIM';

/**
 * The core fields introduced by schema v2, in EASA column order.
 *
 * `migrateFlight` uses this list to upgrade v1 records: each key is filled with
 * `0`, unless a same-named key is found in `extra` (an early record written
 * before these were core), in which case that value is hoisted onto the core
 * field and removed from `extra`.
 */
export const V2_ADDED_FIELDS = [
  'singlePilotSeMinutes',
  'singlePilotMeMinutes',
  'coPilotMinutes',
  'dualMinutes',
  'instructorMinutes',
  'ifrMinutes',
] as const;

export type V2AddedField = (typeof V2_ADDED_FIELDS)[number];

/**
 * The core fields introduced by schema v3, with the default each takes when a
 * v2 record is upgraded. Every existing record is a flight — FSTD entries did
 * not exist before v3 — so `entryType` defaults to `'flight'`, which leaves the
 * record's meaning completely unchanged.
 *
 * `migrateFlight` hoists a same-named key out of `extra` in preference to these
 * defaults, exactly as the v1 -> v2 step does.
 */
export const V3_ADDED_FIELD_DEFAULTS = {
  entryType: 'flight',
  simulatorMinutes: 0,
  simulatorRegistration: '',
} as const;

export const V3_ADDED_FIELDS = Object.keys(
  V3_ADDED_FIELD_DEFAULTS,
) as readonly (keyof typeof V3_ADDED_FIELD_DEFAULTS)[];

export type V3AddedField = (typeof V3_ADDED_FIELDS)[number];

export interface Flight {
  id: string; // uuid
  schemaVersion: number; // 3
  /** Flight or simulator session. See `EntryType` — simulator time is never flight time. */
  entryType: EntryType; // v3
  date: string; // "2026-07-18"
  depAerodrome: string; // ICAO, e.g. "ENGM"
  arrAerodrome: string;
  offBlock: string; // "HH:MM" UTC
  onBlock: string; // "HH:MM" UTC
  aircraftType: string; // e.g. "C172"
  registration: string; // e.g. "LN-ABC"
  picName: string; // "SELF" or a name
  totalMinutes: number; // logged total time, integer minutes

  // --- EASA pilot function time -------------------------------------------
  picMinutes: number;
  coPilotMinutes: number;
  dualMinutes: number;
  instructorMinutes: number;

  // --- EASA single-pilot / multi-pilot time --------------------------------
  singlePilotSeMinutes: number; // single-engine
  singlePilotMeMinutes: number; // multi-engine
  multiPilotMinutes: number;

  // --- EASA operational condition time -------------------------------------
  nightMinutes: number;
  ifrMinutes: number;

  landingsDay: number;
  landingsNight: number;

  // --- FSTD (simulator) ----------------------------------------------------
  /** Session time. Non-zero only when `entryType === 'fstd'`. Never flight time. */
  simulatorMinutes: number; // v3
  /**
   * The simulator DEVICE id, e.g. "EU-DK187". Deliberately separate from
   * `registration`: the aircraft-lookup role in the registry is attached to
   * `registration`, so keeping device ids out of that field is what stops the
   * aircraft store filling up with simulators that are not aircraft.
   */
  simulatorRegistration: string; // v3

  remarks: string;
  extra: Record<string, unknown>;
}

/** Core numeric fields that `addFlight` defaults to 0 when the caller omits them. */
export type OptionalFlightNumbers =
  | 'picMinutes'
  | 'coPilotMinutes'
  | 'dualMinutes'
  | 'instructorMinutes'
  | 'singlePilotSeMinutes'
  | 'singlePilotMeMinutes'
  | 'multiPilotMinutes'
  | 'nightMinutes'
  | 'ifrMinutes'
  | 'landingsDay'
  | 'landingsNight'
  | 'simulatorMinutes';

/**
 * Fields a caller may omit entirely. `entryType` defaults to `'flight'`, so
 * every existing call site keeps working unchanged and logging a simulator
 * session is an explicit act.
 */
export type OptionalFlightFields =
  | OptionalFlightNumbers
  | 'entryType'
  | 'simulatorRegistration'
  | 'remarks'
  | 'extra';

/**
 * Input accepted by `addFlight`: the caller supplies the domain data; `id` and
 * `schemaVersion` are assigned by the storage layer. Numeric, landing, remarks
 * and `extra` fields are optional and default sensibly.
 *
 * The aerodromes and block times stay required HERE at the type level for
 * flights; an FSTD entry supplies `SIMULATOR_AERODROME` for the aerodromes and
 * empty strings for the times, and registry-driven validation is what actually
 * enforces requiredness per entry type (see `registry/types`).
 */
export type NewFlightInput = Omit<Flight, 'id' | 'schemaVersion' | OptionalFlightFields> &
  Partial<Pick<Flight, OptionalFlightFields>>;
