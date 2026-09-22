/**
 * One CSV row -> one logbook record.
 *
 * This is where the import's data-integrity rules actually bite, and the one
 * that matters most is this:
 *
 *   **A `Duty Type = 1` row must never contribute flight time.**
 *
 * RB Logbook populates `Total Block` on simulator rows. In a real export
 * that came to well over a hundred hours of flight time that was never
 * flown. Importing it as flight time would be the single largest data-integrity
 * failure this format can produce, and it would look completely plausible in
 * the totals. `applyEntryTypeInvariants` is what makes it structurally
 * impossible rather than merely avoided, and the parked value is preserved in
 * `extra` rather than deleted.
 *
 * PURE: no storage, no settings, no clock, no DOM, no id generation of its own.
 * Everything variable arrives in the context — the aircraft the pilot confirmed,
 * the fallback class from settings, and the id source. That is what makes the
 * whole preview unit-testable without a browser or a database.
 *
 * Nothing here throws. A bad row is an ordinary outcome that gets reported.
 */
import { CURRENT_SCHEMA_VERSION, type EntryType, type Flight } from '../domain/flight';
import { applyEntryTypeInvariants } from '../domain/entryType';
import { deriveAircraftTimes } from '../domain/derive';
import { migrateFlight } from '../domain/migrate';
import { normalizeRegistration, type Aircraft, type AircraftClass } from '../domain/aircraft';
import { getField } from '../registry/fields';
import { validateFlight } from '../validation/validate';
import { cellAt, type CsvRow } from './csv';
import {
  columnForRole,
  isSimulatorValue,
  type ColumnTarget,
  type ImportMapping,
} from './mapping';
import { parseCount, parseDuration } from './units';
import { entryLocalToUtc, parseTimeOfDayInput } from '../time/timeOfDay';

/** Everything variable, supplied by the caller so this module stays pure. */
export interface TransformContext {
  /** Aircraft the pilot confirmed, keyed by NORMALIZED registration. */
  aircraft: ReadonlyMap<string, Aircraft>;
  /** Class used when a registration is unknown. Read from settings by the caller. */
  fallbackClass: AircraftClass;
  /** Supplies record ids. Injected so tests can be deterministic. */
  makeId: () => string;
}

export type RowIssueCode =
  /** Two columns targeting one field disagree, and summing would double-count. */
  | 'source-conflict'
  /** A cell could not be read as the type its column was mapped to. */
  | 'unparseable'
  /**
   * No aircraft type — neither in the row nor in the confirmed aircraft.
   *
   * Its own code rather than a generic validation failure, because it is not a
   * broken row: it is a row waiting for an answer the aircraft step collects.
   * some rows of the real file are in this state, and the preview must be able to
   * say "23 rows need a type" rather than "23 rows are invalid".
   */
  | 'missing-aircraft'
  /** The finished record failed the same validation a typed-in flight faces. */
  | 'invalid';

export interface RowIssue {
  code: RowIssueCode;
  message: string;
  /** Source column heading, when the problem belongs to one. */
  column?: string;
}

/**
 * Something done to a row that the pilot should see stated before it lands.
 *
 * These are not problems; they are inferences and silent-looking transforms.
 * The rule they serve is that an import may transform, but never invisibly.
 */
export type RowFlag =
  /** Imported as a simulator session rather than a flight. */
  | 'fstd'
  /** Its block time was preserved into `extra` and NOT counted as flight time. */
  | 'sim-block-parked'
  /** Multi-pilot aircraft with no function time — logged as co-pilot time. */
  | 'derived-copilot'
  /** No aircraft type is known for this registration. */
  | 'aircraft-unknown';

export type RowResult =
  | { ok: true; line: number; record: Flight; flags: RowFlag[]; edited?: boolean }
  | { ok: false; line: number; issues: RowIssue[]; label: string; flags: RowFlag[]; edited?: boolean };

/**
 * A correction the pilot made to one row before importing it.
 *
 * Deliberately narrow: these four fields are what an overlap is ever ABOUT, and
 * they are what the conflict pause lets you fix in place. Everything else about
 * a row is better corrected in the flight list afterwards, where the full entry
 * form already exists — duplicating it inside the wizard would mean two forms
 * for one job, and the second one always drifts.
 *
 * An edit is applied to the assembled record BEFORE the entry-type invariants,
 * the aircraft derivation and validation, so all three run on the corrected
 * values. That ordering is not cosmetic: reducing `totalMinutes` without
 * re-deriving would leave `multiPilotMinutes` holding the old, larger figure,
 * and the row would fail validation with a message about component times
 * exceeding the total — which is true, baffling, and entirely our fault.
 */
export interface RowEdit {
  date?: string;
  offBlock?: string;
  onBlock?: string;
  totalMinutes?: number;
}

/** Which fields of a row an edit may touch. Used by the UI to build its form. */
export const EDITABLE_KEYS = ['date', 'offBlock', 'onBlock', 'totalMinutes'] as const;

/** True when an edit actually changes something about a record. */
export function editChangesAnything(record: Flight, edit: RowEdit | undefined): boolean {
  if (!edit) return false;
  return EDITABLE_KEYS.some(
    (key) => edit[key] !== undefined && edit[key] !== record[key],
  );
}

/** Read a cell by column index straight off the row. */
function raw(row: CsvRow, index: number): string {
  return index >= 0 ? cellAt(row, index) : '';
}

/**
 * The `extra` key under which a simulator row's block time is parked.
 *
 * Exported because the plan has to read that value back to report how much
 * block time was set aside. Deriving it in two places would let the writer and
 * the reader drift apart, and the symptom would be a preview quietly stating
 * the wrong number for the one figure this import exists to get right.
 */
export function parkedBlockKey(mapping: ImportMapping, headers: readonly string[]): string {
  const source = mapping.targets.findIndex((t) => t.kind === 'field' && t.key === 'totalMinutes');
  return source >= 0 ? (headers[source] ?? 'Total Block') : 'Total Block';
}

/**
 * Merge several source columns targeting one field.
 *
 * THE RULE, and it is deliberate: take whichever value is non-zero; if two
 * disagree, REPORT THE ROW RATHER THAN SUMMING IT. Summing would silently
 * double-count one session — `Dual Given` and `Instructor` both mean instructor
 * time, so a row carrying 60 in each describes one hour of instruction, not
 * two. There is no safe automatic answer, so a human gets asked.
 *
 * Equal values are not a disagreement: a format that writes the same number
 * into two columns is being redundant, not contradictory.
 */
function mergeDurations(
  values: readonly { value: number; column: string }[],
): { value: number } | { conflict: string[] } {
  const nonZero = values.filter((v) => v.value !== 0);
  if (nonZero.length === 0) return { value: 0 };

  const distinct = new Set(nonZero.map((v) => v.value));
  if (distinct.size === 1) return { value: nonZero[0].value };

  return { conflict: nonZero.map((v) => `${v.column} = ${v.value}`) };
}

/**
 * Should this row be logged as co-pilot time?
 *
 * The inference the format document calls for, expressed as a rule about the
 * AIRCRAFT rather than a hardcoded list of type designators. A multi-pilot
 * aircraft flown with no pilot-function time recorded at all was almost
 * certainly flown as co-pilot — that is what an airline first officer's
 * logbook looks like when the export carries no function columns.
 *
 * Gated on every function field being empty, so the rows of the real file
 * that DO carry PIC time are left exactly as they are. And gated on
 * `multiPilot`, which is why no A320 or A319 string appears anywhere in this
 * module: the pilot confirms which aircraft are multi-pilot in the aircraft
 * step, and the inference follows from that answer.
 *
 * It is an inference, not data. The preview states it as a claim the pilot can
 * refuse before anything is written.
 */
function shouldInferCoPilot(record: Omit<Flight, 'id' | 'schemaVersion'>, aircraft: Aircraft | undefined): boolean {
  if (!aircraft?.multiPilot) return false;
  if (record.totalMinutes <= 0) return false;
  return (
    record.picMinutes === 0 &&
    record.coPilotMinutes === 0 &&
    record.dualMinutes === 0 &&
    record.instructorMinutes === 0
  );
}

/** A short human label for a row that failed, so the pilot can find it. */
function labelFor(row: CsvRow, mapping: ImportMapping): string {
  const pick = (key: string): string => {
    const index = mapping.targets.findIndex((t) => t.kind === 'field' && t.key === key);
    return index >= 0 ? raw(row, index) : '';
  };
  const identifier = columnForRole(mapping, 'aircraftIdentifier');
  const parts = [
    pick('date'),
    [pick('depAerodrome'), pick('arrAerodrome')].filter(Boolean).join('–'),
    identifier >= 0 ? raw(row, identifier) : pick('registration'),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : `line ${row.line}`;
}

/**
 * Turn one parsed CSV row into a validated logbook record.
 *
 * The order of operations matters and is not arbitrary:
 *
 *  1. Decide the entry type FIRST — it governs where several values may go.
 *  2. Read the mapped columns into core fields.
 *  3. Resolve the columns whose destination depends on the entry type.
 *  4. Apply the entry-type invariants, which is what disarms the sim-block trap.
 *  5. Derive the aircraft times, then infer co-pilot time.
 *  6. Migrate, then validate, and keep the NORMALIZED record — so an import can
 *     never introduce a record the entry form could not have produced. Same
 *     reasoning as `readBackup`.
 */
export function transformRow(
  row: CsvRow,
  headers: readonly string[],
  mapping: ImportMapping,
  context: TransformContext,
  edit?: RowEdit,
): RowResult {
  const issues: RowIssue[] = [];
  const flags: RowFlag[] = [];

  // --- 1. Entry type ------------------------------------------------------
  const discriminator = columnForRole(mapping, 'entryTypeDiscriminator');
  const entryType: EntryType =
    discriminator >= 0 && isSimulatorValue(raw(row, discriminator), mapping) ? 'fstd' : 'flight';
  if (entryType === 'fstd') flags.push('fstd');

  // --- 2. Mapped columns --------------------------------------------------
  const core: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  /** Duration values gathered per field, so several columns can feed one. */
  const durations = new Map<string, { value: number; column: string }[]>();

  mapping.targets.forEach((target: ColumnTarget, index) => {
    const column = headers[index] ?? `column ${index + 1}`;
    const value = cellAt(row, index);

    if (target.kind === 'ignore' || target.kind === 'role') return;

    if (target.kind === 'extra') {
      // Only non-empty cells. RB has 105 columns and most are empty on most
      // rows; writing 80 empty keys onto every record would be storage noise
      // that then reappears as 80 empty columns in every CSV export.
      //
      // The value is kept as the trimmed STRING the file actually held. That is
      // lossless and needs no special cases: coercing "0180" to a number, or
      // "true" to a boolean, would be us deciding what the file meant.
      if (value !== '') extra[target.key] = value;
      return;
    }

    const field = getField(target.key);
    if (!field) return;

    switch (field.type) {
      case 'durationMinutes': {
        const minutes = parseDuration(value, mapping.duration);
        if (minutes === null) {
          issues.push({
            code: 'unparseable',
            column,
            message: `"${value}" in ${column} could not be read as a duration.`,
          });
          return;
        }
        const bucket = durations.get(field.key) ?? [];
        bucket.push({ value: minutes, column });
        durations.set(field.key, bucket);
        return;
      }
      case 'count': {
        const count = parseCount(value);
        if (count === null) {
          issues.push({
            code: 'unparseable',
            column,
            message: `"${value}" in ${column} could not be read as a whole number.`,
          });
          return;
        }
        // First column wins for a count; counts are not merged the way
        // durations are, because no format splits one across two columns.
        if (core[field.key] === undefined) core[field.key] = count;
        return;
      }
      case 'timeOfDay': {
        // NORMALISED, not copied through. Foreign exports write block times in
        // whatever shape their UI used — `0805`, `8:05`, `08:05:00`, `8:05 AM`
        // — and all four mean the same instant. Storing them verbatim would put
        // four spellings of one time in the logbook, three of which fail
        // `validateFlight` and none of which the night calculation can read.
        const time = parseTimeOfDayInput(value);
        if (time === null) {
          issues.push({
            code: 'unparseable',
            column,
            message: `"${value}" in ${column} could not be read as a time of day.`,
          });
          return;
        }
        if (time !== '' && core[field.key] === undefined) core[field.key] = time;
        return;
      }
      default: {
        if (value !== '' && core[field.key] === undefined) core[field.key] = value;
        return;
      }
    }
  });

  for (const [key, values] of durations) {
    const merged = mergeDurations(values);
    if ('conflict' in merged) {
      const field = getField(key);
      issues.push({
        code: 'source-conflict',
        message:
          `${field?.label ?? key}: ${merged.conflict.join(' and ')} disagree. ` +
          `These are not added together, because that would double-count one session — ` +
          `the row needs a look.`,
      });
      continue;
    }
    core[key] = merged.value;
  }

  // --- 3. Columns whose destination depends on the entry type -------------
  const identifierColumn = columnForRole(mapping, 'aircraftIdentifier');
  if (identifierColumn >= 0) {
    const identifier = raw(row, identifierColumn);
    // A registration on a flight, a DEVICE ID on a session. Sending a device id
    // to `registration` is what would fill the aircraft store with simulators
    // that are not aircraft.
    if (entryType === 'fstd') core.simulatorRegistration = identifier;
    else core.registration = identifier;
  }

  if (issues.length > 0) {
    return { ok: false, line: row.line, issues, flags, label: labelFor(row, mapping) };
  }

  // --- 4. Assemble, and disarm the simulator trap -------------------------
  const assembled = {
    entryType,
    date: String(core.date ?? ''),
    depAerodrome: String(core.depAerodrome ?? ''),
    arrAerodrome: String(core.arrAerodrome ?? ''),
    offBlock: String(core.offBlock ?? ''),
    onBlock: String(core.onBlock ?? ''),
    aircraftType: String(core.aircraftType ?? ''),
    registration: String(core.registration ?? ''),
    // Left EMPTY on purpose. RB records PIC time, not the PIC's name, and the
    // pilot is not the commander on most of these flights — an invented "SELF"
    // would be wrong rather than merely absent. Settled; do not helpfully fill.
    picName: String(core.picName ?? ''),
    totalMinutes: Number(core.totalMinutes ?? 0),
    picMinutes: Number(core.picMinutes ?? 0),
    coPilotMinutes: Number(core.coPilotMinutes ?? 0),
    dualMinutes: Number(core.dualMinutes ?? 0),
    instructorMinutes: Number(core.instructorMinutes ?? 0),
    singlePilotSeMinutes: 0,
    singlePilotMeMinutes: 0,
    multiPilotMinutes: 0,
    nightMinutes: Number(core.nightMinutes ?? 0),
    ifrMinutes: Number(core.ifrMinutes ?? 0),
    landingsDay: Number(core.landingsDay ?? 0),
    landingsNight: Number(core.landingsNight ?? 0),
    simulatorMinutes: Number(core.simulatorMinutes ?? 0),
    simulatorRegistration: String(core.simulatorRegistration ?? ''),
    remarks: String(core.remarks ?? ''),
    extra,
  } satisfies Omit<Flight, 'id' | 'schemaVersion'>;

  // THE FILE'S ZONE COMES OFF HERE, before the pilot's corrections and before
  // anything is derived. Reading a local-time file is part of reading the file,
  // so it happens first — and the corrections that follow are then made against
  // the UTC values the preview actually shows, which is the only way an edit in
  // the conflict pause can mean what it appears to mean.
  //
  // A simulator session is skipped: it has no block times to convert and no
  // departure date to move.
  if (entryType === 'flight' && mapping.timeZoneOffsetMinutes) {
    const utc = entryLocalToUtc(
      { date: assembled.date, offBlock: assembled.offBlock, onBlock: assembled.onBlock },
      mapping.timeZoneOffsetMinutes,
    );
    assembled.date = utc.date;
    assembled.offBlock = utc.offBlock;
    assembled.onBlock = utc.onBlock;
  }

  // The pilot's corrections, applied HERE — after the file has been read, before
  // anything is derived from the values. See `RowEdit` for why the ordering
  // matters. An FSTD entry is left alone: its block times are empty by
  // definition and its flight time is zero, so there is nothing here to correct.
  const edited = entryType === 'flight' && edit !== undefined;
  if (edited) {
    if (edit.date !== undefined) assembled.date = edit.date;
    if (edit.offBlock !== undefined) assembled.offBlock = edit.offBlock;
    if (edit.onBlock !== undefined) assembled.onBlock = edit.onBlock;
    if (edit.totalMinutes !== undefined && Number.isFinite(edit.totalMinutes)) {
      assembled.totalMinutes = edit.totalMinutes;
    }
  }

  // THE TRAP. On a simulator row `totalMinutes` holds RB's `Total Block`, which
  // is not flight time and never was. Park it under its own column name so the
  // file's content is not destroyed, then let the invariants zero the field.
  // It lands in `extra`, which no total sums, so it can never leak back in.
  if (entryType === 'fstd' && assembled.totalMinutes > 0) {
    const key = parkedBlockKey(mapping, headers);
    if (!(key in extra)) extra[key] = String(assembled.totalMinutes);
    flags.push('sim-block-parked');
  }

  const invariant = applyEntryTypeInvariants(assembled);

  // --- 5. Aircraft: fill the gap, then derive -----------------------------
  const key = normalizeRegistration(invariant.registration);
  const aircraft = key ? context.aircraft.get(key) : undefined;

  // some rows of the real file carry a registration but no type. THIS is how the
  // format document's "give the user a chance to fill it in" is honoured: the
  // aircraft step collects one answer per registration, and it lands here. The
  // same prefill the entry form does from `aircraftRole: 'type'`, applied to a
  // whole file at once.
  if (!invariant.aircraftType && aircraft?.type) {
    invariant.aircraftType = aircraft.type;
  }

  if (!invariant.aircraftType) {
    flags.push('aircraft-unknown');
    // Reported as its own kind of problem, not as a broken row: it is waiting
    // for an answer rather than malformed. Returning here keeps `validateFlight`
    // from reporting the same gap in words that would send the pilot looking for
    // a fault in their file.
    return {
      ok: false,
      line: row.line,
      label: labelFor(row, mapping),
      flags,
      issues: [
        {
          code: 'missing-aircraft',
          message: key
            ? `No aircraft type for ${invariant.registration}.`
            : 'No aircraft type, and no registration to look one up by.',
        },
      ],
    };
  }

  // Derived once and STORED, never recomputed on read: correcting an aircraft's
  // class years later must not silently rewrite flights already logged.
  const derived =
    entryType === 'flight'
      ? deriveAircraftTimes(invariant, aircraft, context.fallbackClass)
      : invariant;

  const withFunctionTime = { ...derived };
  if (shouldInferCoPilot(withFunctionTime, aircraft)) {
    withFunctionTime.coPilotMinutes = withFunctionTime.totalMinutes;
    flags.push('derived-copilot');
  }

  // --- 6. Migrate, validate, keep the normalized record -------------------
  const candidate: Flight = {
    id: context.makeId(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...withFunctionTime,
  };

  // A no-op today, because the record was just built at the current version —
  // and that is exactly what it should assert. The day a schema v4 lands, this
  // is what stops a transform that has not been updated from writing a v3
  // record into storage.
  let migrated: Flight;
  try {
    migrated = migrateFlight(candidate);
  } catch (error) {
    return {
      ok: false,
      line: row.line,
      label: labelFor(row, mapping),
      flags,
      issues: [
        {
          code: 'invalid',
          message: error instanceof Error ? error.message : 'Could not be upgraded to the current format.',
        },
      ],
    };
  }

  const { errors, normalized } = validateFlight(migrated);
  if (errors.length > 0) {
    return {
      ok: false,
      line: row.line,
      label: labelFor(row, mapping),
      flags,
      edited,
      issues: errors.map((error) => ({ code: 'invalid' as const, message: error.message })),
    };
  }

  return { ok: true, line: row.line, record: normalized, flags, edited };
}

/** An aircraft the file mentions, and what the file says about it. */
export interface AircraftNeed {
  /** Normalized registration — the aircraft store's key. */
  registration: string;
  /** As it appeared in the file, for display. */
  asWritten: string;
  /** Distinct non-empty type designators seen against it. Usually one; 0 means blank. */
  typesSeen: string[];
  /** How many flight rows reference it. */
  rowCount: number;
}

/**
 * Every aircraft the file's FLIGHT rows mention, for the aircraft step.
 *
 * Simulator rows are excluded by design. Their identifier is a device id, not a
 * registration, and it must never reach the aircraft store — that separation is
 * the entire reason `simulatorRegistration` is a distinct field.
 */
export function collectAircraftNeeds(
  rows: readonly CsvRow[],
  mapping: ImportMapping,
): AircraftNeed[] {
  const discriminator = columnForRole(mapping, 'entryTypeDiscriminator');
  const identifier = columnForRole(mapping, 'aircraftIdentifier');
  const registrationColumn =
    identifier >= 0
      ? identifier
      : mapping.targets.findIndex((t) => t.kind === 'field' && t.key === 'registration');
  const typeColumn = mapping.targets.findIndex(
    (t) => t.kind === 'field' && t.key === 'aircraftType',
  );

  const needs = new Map<string, AircraftNeed>();

  for (const row of rows) {
    const isSim = discriminator >= 0 && isSimulatorValue(raw(row, discriminator), mapping);
    if (isSim) continue;

    const asWritten = raw(row, registrationColumn);
    const key = normalizeRegistration(asWritten);
    if (!key) continue;

    const need = needs.get(key) ?? { registration: key, asWritten, typesSeen: [], rowCount: 0 };
    need.rowCount++;
    const type = raw(row, typeColumn).trim();
    if (type && !need.typesSeen.includes(type)) need.typesSeen.push(type);
    needs.set(key, need);
  }

  return [...needs.values()].sort((a, b) => (a.registration < b.registration ? -1 : 1));
}
