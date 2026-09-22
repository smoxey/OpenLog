/**
 * Aircraft store — CRUD for the minimal aircraft record, in the same style as
 * the flight API and behind the same module boundary. Dexie stays confined to
 * `src/lib/storage/`.
 *
 * Every entry point normalizes the registration through the single shared
 * function in `domain/aircraft`, so the key written and the key looked up can
 * never disagree.
 */
import { db } from './db';
import { normalizeAircraft, normalizeRegistration, type Aircraft } from '../domain/aircraft';

/** Look up one aircraft by registration (case- and whitespace-insensitive). */
export async function getAircraft(registration: string): Promise<Aircraft | undefined> {
  const key = normalizeRegistration(registration ?? '');
  if (!key) return undefined;
  return db.aircraft.get(key);
}

/**
 * Create or replace an aircraft record. Returns the stored (normalized) record
 * so the caller uses the same values that went to disk.
 *
 * Replacing an aircraft never touches flights already written — derived times
 * live on the flight record. See `domain/derive`.
 */
export async function upsertAircraft(input: Aircraft): Promise<Aircraft> {
  // Shared with the CSV importer, which writes a whole fileful of these inside
  // its own transaction. Both paths must produce identical records for
  // identical input, or an import would create a second, subtly different copy
  // of an aircraft the entry form had already stored.
  const record = normalizeAircraft(input);
  if (!record.registration) {
    throw new Error('Aircraft registration is required.');
  }
  await db.aircraft.put(record);
  return record;
}

/** Every known aircraft, ordered by registration. */
export async function getAllAircraft(): Promise<Aircraft[]> {
  const all = await db.aircraft.toArray();
  return all.sort((a, b) => (a.registration < b.registration ? -1 : a.registration > b.registration ? 1 : 0));
}

/** Forget one aircraft. Flights already logged in it are unaffected. */
export async function deleteAircraft(registration: string): Promise<void> {
  const key = normalizeRegistration(registration ?? '');
  if (key) await db.aircraft.delete(key);
}
