/**
 * PERMANENT SCHEMA v1 FIXTURE — DO NOT EDIT TO MAKE A TEST PASS.
 *
 * This is a hand-written record in the shape the app wrote at schemaVersion 1,
 * before the six EASA function/condition-time columns were promoted to core
 * fields in v2. It is the regression net that proves `migrateFlight` still
 * upgrades real historical data correctly, no matter how many schema versions
 * are added later.
 *
 * If a future change makes a test using this fixture fail, the change is wrong
 * — not the fixture. The whole point of `schemaVersion` is that this record,
 * and any 2026 CSV backup shaped like it, still loads years from now.
 *
 * Notes on the chosen values:
 *  - Crosses midnight (23:40 -> 00:20 = 40 raw minutes) and logs 42, i.e. the
 *    nearest tenth of an hour, per the logged-time rule in `Claude Context/HOW_IT_WORKS.md`.
 *  - `remarks` deliberately contains a comma, double quotes and non-ASCII
 *    characters, so it doubles as a CSV-escaping fixture in Phase 3.
 *  - `extra` holds only keys the app has never known about, so migration must
 *    carry all of them through untouched.
 */
export const V1_FLIGHT_FIXTURE = {
  id: '11111111-2222-4333-8444-555555555555',
  schemaVersion: 1,
  date: '2026-03-14',
  depAerodrome: 'ENGM',
  arrAerodrome: 'ENBR',
  offBlock: '23:40',
  onBlock: '00:20',
  aircraftType: 'C172',
  registration: 'LN-ABC',
  picName: 'SELF',
  totalMinutes: 42,
  picMinutes: 42,
  multiPilotMinutes: 0,
  nightMinutes: 42,
  landingsDay: 0,
  landingsNight: 1,
  remarks: 'Night x-country, "quoted" text; commas, and åøæ',
  extra: {
    importedFrom: 'paper-logbook',
    approaches: 2,
    customTag: 'x-country',
  },
} as const;

/**
 * A fresh deep copy of the fixture, so a test that mutates its result can never
 * contaminate another test.
 */
export function makeV1Flight(): Record<string, unknown> {
  return structuredClone(V1_FLIGHT_FIXTURE) as Record<string, unknown>;
}
