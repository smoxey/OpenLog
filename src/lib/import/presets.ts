/**
 * Mapping presets — the formats we have characterised well enough to map
 * without asking.
 *
 * A preset is a starting point, never a commitment: `buildMapping` produces an
 * ordinary mapping from it, and the mapping step shows every column so a wrong
 * guess is visible and correctable before anything is written.
 *
 * PURE: no storage, no settings, no clock.
 */
import { FIELDS } from '../registry/fields';
import { IGNORE, type ColumnTarget, type ImportPreset } from './mapping';

const field = (key: string): ColumnTarget => ({ kind: 'field', key });
const extra = (key: string): ColumnTarget => ({ kind: 'extra', key });

/**
 * RB Logbook.
 *
 * Characterised from a real export. 105 columns, of which 24 carry data.
 */
export const RB_PRESET: ImportPreset = {
  id: 'rb-logbook',
  label: 'RB Logbook',
  description: 'CSV exported from RB Logbook. 105 columns, durations in whole minutes.',

  // Columns our own export does not have, so the two can never be confused.
  signature: ['Duty Type', 'Total Block', 'Aircraft ID', 'Out', 'In'],

  simulatorValues: ['1'],

  columns: {
    Date: field('date'),

    // Decides flight vs simulator session. Never stored.
    'Duty Type': { kind: 'role', role: 'entryTypeDiscriminator' },

    Departure: field('depAerodrome'),
    Arrival: field('arrAerodrome'),

    // One column, two destinations: a registration on a flight, a device id on
    // a simulator session. Sending a device id to `registration` would put
    // simulators into the aircraft store, which is precisely what the separate
    // `simulatorRegistration` field exists to prevent.
    'Aircraft ID': { kind: 'role', role: 'aircraftIdentifier' },

    // Applies to both entry types, so a sim row's "A320-200-SIM" is kept as-is.
    // Empty on some rows of the real file — those need a human, and get one.
    'Aircraft Type': field('aircraftType'),

    // THE block times we want. Not dependably UTC (format doc §5), which is why
    // `Total Block` outranks the interval between them.
    Out: field('offBlock'),
    In: field('onBlock'),

    // Airborne times. EMPTY IN EVERY ROW, and deliberately IGNORED rather
    // than mapped: they are wheels-up/wheels-down, not block times, so the day
    // RB starts populating them a mapping would start writing the wrong number
    // into `offBlock`. Ignoring is the safe reading of a column we have never
    // seen filled in.
    Off: IGNORE,
    On: IGNORE,

    // Authoritative for total time. On a simulator row it is a trap — well over a hundred hours
    // that were never flown — and `transform` parks it in `extra` instead.
    'Total Block': field('totalMinutes'),

    // The real session time on a simulator row. Disagrees with `Total Block`,
    // and this is the one that means what it says.
    Simulator: field('simulatorMinutes'),

    PIC: field('picMinutes'),
    SIC: field('coPilotMinutes'),
    Night: field('nightMinutes'),
    IFR: field('ifrMinutes'),

    // Dual RECEIVED. This is what `dualMinutes` means.
    'Dual Received': field('dualMinutes'),
    // Dual GIVEN is instructor time; there is no separate concept. Both columns
    // therefore target one field, and `transform` applies the merge rule — take
    // whichever is non-zero, never sum, report a genuine disagreement.
    'Dual Given': field('instructorMinutes'),
    Instructor: field('instructorMinutes'),

    'Day Landing': field('landingsDay'),
    'Night Landing': field('landingsNight'),

    Remarks: field('remarks'),

    // --- No home in the schema; preserved rather than dropped ---------------
    PICUS: extra('PICUS'),
    'Actual Instrument': extra('Actual Instrument'),
    'Simulated Instrument': extra('Simulated Instrument'),
    'X-Country': extra('X-Country'),
    // We have no take-off counts. Populated on every row of the real file.
    'Day Takeoff': extra('Day Takeoff'),
    'Night Takeoff': extra('Night Takeoff'),
    // PF/PM, NOT a logging function. Never derive PIC time from this — it says
    // who was handling the aircraft, not who was in command. It looks exactly
    // like a field someone will later "improve" into picMinutes; do not.
    'Pilot Flying': extra('Pilot Flying'),
  },

  notes: [
    'Durations in this format are whole minutes.',
    'Rows marked Duty Type 1 are simulator sessions. Their block time is never counted as flight time.',
    'RB does not record who the pilot in command was, so PIC name is left empty.',
  ],
};

/**
 * Our own CSV export, for reading a file this app wrote.
 *
 * Generated from the registry rather than listed by hand, so it cannot drift:
 * adding a field adds its column here automatically, which is the whole point
 * of the registry being the single source of column names.
 *
 * NOTE this is the INTERCHANGE format, not the backup format. A CSV written by
 * this app does not carry flight ids, so re-importing one creates new records
 * rather than updating existing ones — that is what Restore is for, and the
 * overlap check is what catches it when someone does it anyway.
 */
export const OPENLOG_PRESET: ImportPreset = {
  id: 'open-pilot-logbook',
  label: 'Open Pilot Logbook (CSV)',
  description: 'A CSV exported from this app. Durations in decimal hours.',

  // `Total Time of Flight` is the EASA wording; RB says `Total Block`.
  signature: ['Total Time of Flight', 'Aircraft Registration'],

  simulatorValues: ['fstd'],

  columns: Object.fromEntries(
    FIELDS.map((f) => [
      f.easaColumn,
      // `Entry Type` is the discriminator, exactly as `Duty Type` is for RB —
      // it decides the record's kind rather than filling a field in.
      f.key === 'entryType'
        ? ({ kind: 'role', role: 'entryTypeDiscriminator' } as ColumnTarget)
        : field(f.key),
    ]),
  ),

  notes: [
    'Durations in this format are decimal hours.',
    'A CSV carries no flight ids, so importing one adds records rather than updating them. To replace a logbook from a file this app wrote, use Restore from backup instead.',
  ],
};

export const PRESETS: readonly ImportPreset[] = [RB_PRESET, OPENLOG_PRESET];

/**
 * Which preset, if any, claims this file.
 *
 * Every signature column must be present. Deliberately strict: mapping a file
 * with the wrong preset is worse than mapping it by hand, because a preset's
 * guesses look authoritative.
 */
export function detectPreset(headers: readonly string[]): ImportPreset | undefined {
  const present = new Set(headers);
  return PRESETS.find((preset) => preset.signature.every((column) => present.has(column)));
}
