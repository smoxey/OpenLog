/**
 * Public storage API — the ONLY surface the rest of the app uses to read and
 * write logbook data. It wraps Dexie (see ./db) and is registry-driven for
 * validation and totals, so new fields flow through without changes here.
 *
 * `extra` (unknown/future fields) is preserved untouched through add/get/update.
 */
import { db } from './db';
import { CURRENT_SCHEMA_VERSION, type Flight, type NewFlightInput } from '../domain/flight';
import { migrateFlight } from '../domain/migrate';
// The entry-type invariants live in the domain layer because the CSV importer
// must enforce exactly the same rule and cannot import this module — it pulls in
// Dexie, and the importer is pure by design. One rule, one definition, two
// callers — the same argument that put `findConflicts` in the domain layer.
import { applyEntryTypeInvariants } from '../domain/entryType';
import { FIELDS } from '../registry/fields';
import { sumTotals } from '../domain/totals';
import { validateFlight, type ValidationError } from '../validation/validate';

export { getSettings, updateSettings, DEFAULT_SETTINGS, type Settings } from './settings';
export {
  getAircraft,
  upsertAircraft,
  getAllAircraft,
  deleteAircraft,
} from './aircraft';
export { restoreBackup, type RestoreContents, type RestoreResult } from './restore';
export { importFlights, type ImportContents, type ImportResult } from './importFlights';
export { applyBulkAdjust, type BulkAdjustResult } from './bulkAdjust';
export { applyBulkNight, type BulkNightResult } from './bulkNight';
export { deleteAllData, type DeleteAllResult } from './deleteAll';
export type { ValidationError } from '../validation/validate';

/** Result of a write: either the saved flight, or structured validation errors. */
export type SaveResult =
  | { ok: true; flight: Flight }
  | { ok: false; errors: ValidationError[] };

export interface ListOptions {
  sortBy?: keyof Flight;
  direction?: 'asc' | 'desc';
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Fill core numeric/text defaults so validation sees a complete record. */
function withDefaults(input: NewFlightInput): Omit<Flight, 'id' | 'schemaVersion'> {
  return applyEntryTypeInvariants({
    entryType: input.entryType ?? 'flight',
    date: input.date,
    depAerodrome: input.depAerodrome,
    arrAerodrome: input.arrAerodrome,
    offBlock: input.offBlock,
    onBlock: input.onBlock,
    aircraftType: input.aircraftType,
    registration: input.registration,
    picName: input.picName,
    totalMinutes: input.totalMinutes,
    picMinutes: input.picMinutes ?? 0,
    coPilotMinutes: input.coPilotMinutes ?? 0,
    dualMinutes: input.dualMinutes ?? 0,
    instructorMinutes: input.instructorMinutes ?? 0,
    singlePilotSeMinutes: input.singlePilotSeMinutes ?? 0,
    singlePilotMeMinutes: input.singlePilotMeMinutes ?? 0,
    multiPilotMinutes: input.multiPilotMinutes ?? 0,
    nightMinutes: input.nightMinutes ?? 0,
    ifrMinutes: input.ifrMinutes ?? 0,
    landingsDay: input.landingsDay ?? 0,
    landingsNight: input.landingsNight ?? 0,
    simulatorMinutes: input.simulatorMinutes ?? 0,
    simulatorRegistration: input.simulatorRegistration ?? '',
    remarks: input.remarks ?? '',
    extra: { ...(input.extra ?? {}) },
  });
}

/** Create a flight. Generates `id` + `schemaVersion` and validates via the registry. */
export async function addFlight(input: NewFlightInput): Promise<SaveResult> {
  const candidate: Flight = {
    id: generateId(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...withDefaults(input),
  };

  const { errors, normalized } = validateFlight(candidate);
  if (errors.length > 0) return { ok: false, errors };

  await db.flights.add(normalized);
  return { ok: true, flight: normalized };
}

/** Patch an existing flight. Merges into the stored record and re-validates. */
export async function updateFlight(id: string, patch: Partial<Flight>): Promise<SaveResult> {
  const existing = await db.flights.get(id);
  if (!existing) {
    return { ok: false, errors: [{ key: 'id', message: `No flight with id ${id}.` }] };
  }

  const current = migrateFlight(existing);
  const patched = {
    ...current,
    ...patch,
    // Merge extra so unknown/future keys are preserved.
    extra: { ...current.extra, ...(patch.extra ?? {}) },
  };
  const merged: Flight = {
    // Re-assert the entry-type invariants: an edit that switches an entry from
    // flight to simulator (or back) must not leave the other mode's fields
    // behind carrying stale values.
    ...applyEntryTypeInvariants(patched),
    // Never let a patch change identity or schema version.
    id: current.id,
    schemaVersion: current.schemaVersion,
  };

  const { errors, normalized } = validateFlight(merged);
  if (errors.length > 0) return { ok: false, errors };

  await db.flights.put(normalized);
  return { ok: true, flight: normalized };
}

export async function deleteFlight(id: string): Promise<void> {
  await db.flights.delete(id);
}

export async function getFlight(id: string): Promise<Flight | undefined> {
  const record = await db.flights.get(id);
  return record ? migrateFlight(record) : undefined;
}

export async function listFlights(options: ListOptions = {}): Promise<Flight[]> {
  const { sortBy = 'date', direction = 'desc' } = options;
  const flights = (await db.flights.toArray()).map(migrateFlight);

  const dir = direction === 'asc' ? 1 : -1;
  flights.sort((a, b) => {
    const primary = compare(a[sortBy], b[sortBy]) * dir;
    if (primary !== 0) return primary;
    // Tiebreak by off-block in the same direction (spec default: date desc, then offBlock desc).
    if (sortBy !== 'offBlock') return compare(a.offBlock, b.offBlock) * dir;
    return 0;
  });
  return flights;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : 1;
}

/**
 * Sum every registry field with `summable: true` across all flights.
 *
 * The arithmetic itself lives in `domain/totals`, which is pure and does every
 * other figure the app shows. This function's whole job is the storage read —
 * one definition of what a total is, rather than one here and one there.
 */
export async function getTotals(): Promise<Record<string, number>> {
  const flights = (await db.flights.toArray()).map(migrateFlight);
  return sumTotals(flights);
}

/** Every stored entry, migrated. The reading half of every totals view. */
export async function getAllFlights(): Promise<Flight[]> {
  return (await db.flights.toArray()).map(migrateFlight);
}

/** Remove all flights. Used by tests and a future "reset" setting. */
export async function clearAll(): Promise<void> {
  await db.flights.clear();
}

// Re-export domain + registry surface so callers have a single import site.
export { FIELDS } from '../registry/fields';
export type { Flight, NewFlightInput } from '../domain/flight';
export { normalizeRegistration } from '../domain/aircraft';
export type { Aircraft, AircraftClass } from '../domain/aircraft';
export const registryFieldKeys = FIELDS.map((f) => f.key);
