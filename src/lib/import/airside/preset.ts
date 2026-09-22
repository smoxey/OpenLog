/**
 * The mapping for an adapted Airside file.
 *
 * Deliberately NOT in `PRESETS`, so `detectPreset` cannot claim a file with it.
 * These thirteen columns are not something a pilot ever has on disk — they are
 * what `adaptAirside` produces — so the only correct way to reach this mapping
 * is through the Airside step, and a preset that could be picked by accident
 * would be a way to reach it wrongly.
 *
 * It is an ordinary `ImportPreset` all the same, and that is the point: once
 * the file has been adapted, the columns step shows it, the pilot can change
 * any of these targets, and everything downstream is the same code that reads
 * an RB export.
 */
import type { ColumnTarget, ImportPreset } from '../mapping';

const field = (key: string): ColumnTarget => ({ kind: 'field', key });
const extra = (key: string): ColumnTarget => ({ kind: 'extra', key });

export const AIRSIDE_PRESET_ID = 'airside';

export const AIRSIDE_PRESET: ImportPreset = {
  id: AIRSIDE_PRESET_ID,
  label: 'Airside',
  description:
    'An airline crew-app export. IATA aerodromes, local block times and a packed flight identifier, unpacked before this step.',

  // Never matched against a file on disk — the Airside step is the only way in,
  // so this names columns no file a pilot owns would have.
  signature: ['Flight Number', 'Block Off', 'Block On', 'Zone Assumed'],

  // Airside has no simulator rows and no column that could mark one, so every
  // row is a flight. An empty list says that, rather than leaving RB's `1` in
  // place to be matched against a column that does not exist.
  simulatorValues: [],

  columns: {
    // The commercial flight number. No EASA column records it and the schema
    // has no field for it, so it is kept under its own name — which means it
    // survives into every JSON export and appears in CSV export as its own
    // column, rather than being thrown away for want of a tidy home.
    'Flight Number': extra('Flight Number'),

    // The DEPARTURE DATE column, not the date packed into the flight
    // identifier. They disagree when a departure slips past midnight, and the
    // identifier carries the scheduled day while the column carries the real
    // one. Already moved into UTC by the adapter where the conversion crossed
    // midnight.
    Date: field('date'),

    // ICAO, translated from the IATA the file writes. A code with no
    // unambiguous ICAO twin arrives here still in IATA and is listed for the
    // pilot rather than blanked.
    Departure: field('depAerodrome'),
    Arrival: field('arrAerodrome'),

    // UTC. The file's times are on two different local clocks; see `./zones`.
    'Block Off': field('offBlock'),
    'Block On': field('onBlock'),

    // Hyphenated back into a real registration — `SEXYZ` -> `SE-XYZ` — for the
    // prefixes the pilot confirmed in the Airside step.
    Registration: field('registration'),
    // The ICAO designator the pilot chose for this file's model code.
    'Aircraft Type': field('aircraftType'),

    // Whole minutes, straight from the file, and authoritative: the block times
    // were derived from it rather than the other way round.
    'Total Time': field('totalMinutes'),

    // COMPUTED, not read. Airside records no night time at all, so this column
    // is either the route calculation or empty — never something the file said.
    Night: field('nightMinutes'),

    // Airside's `Landing` column says only whether this pilot landed. Which of
    // the two EASA columns it belongs in is worked out from the arrival, and
    // the two columns here are that answer.
    'Ldg Day': field('landingsDay'),
    'Ldg Night': field('landingsNight'),

    // Filled in only on rows whose time zone had to be assumed rather than
    // worked out. Mostly empty, and that is the shape of the fact: it names the
    // rows a later doubt about an hour should start from.
    'Zone Assumed': extra('Zone Assumed'),
  },

  notes: [
    'Durations in this format are whole minutes.',
    'Block times were written on local clocks and have been converted to UTC. The on-block is the off-block plus the total flight time, so the stored interval always agrees with the stored total.',
    'Airside does not record who the pilot in command was, so PIC name is left empty.',
    'Airside records no night time. The Night column here was worked out from the route and the clock, not read from the file.',
  ],
};
