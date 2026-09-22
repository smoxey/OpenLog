/**
 * Sum validation — do the time columns agree with the total?
 *
 * THE GOVERNING RULE: this WARNS, it never blocks. `validateFlight` is
 * untouched by this module and never consults it. A finding here is advisory in
 * exactly the way the overlap warning is advisory: it is shown, and the pilot
 * decides.
 *
 * That is a decision, not a shortcut. A hard rule would have refused rows from
 * a real import, and it would be wrong to: a flight logged as both
 * PIC and instructor for its whole duration legitimately sums to twice its
 * total, and that is a correct logbook entry. The check exists to catch a
 * fat-fingered 100 where 10 was meant, not to enforce an arithmetic identity
 * that aviation does not actually have.
 *
 * This module is PURE. No storage, no settings, no clock, no DOM. That is what
 * lets it run on every keystroke in the entry form and still be testable
 * without rendering anything.
 */
import {
  DEFAULT_ENTRY_TYPE,
  FIELDS,
  appliesTo,
  copySourceKey,
  getField,
} from '../registry/fields';
import type { FieldDefinition } from '../registry/types';
import type { EntryType, Flight } from './flight';

/**
 * Which of the two checks produced a finding.
 *
 * They are separate because they fail for different reasons and the fix is
 * different. A pilot-function overrun usually means one column was typed twice;
 * an operational-condition overrun means a single column exceeds the flight.
 */
export type SumCheckKind = 'pilotFunction' | 'operationalCondition';

export interface SumFinding {
  kind: SumCheckKind;
  /** Registry keys that contributed. Exactly one for a condition finding. */
  keys: readonly string[];
  /** What to call this in the UI — the group name, or the single field's label. */
  label: string;
  /** What the contributing fields add up to, in minutes. */
  sum: number;
  /** The field the sum was measured against. */
  yardstickKey: 'totalMinutes' | 'simulatorMinutes';
  yardstickLabel: string;
  yardstick: number;
  /** How far over the yardstick. Always positive — nothing else is a finding. */
  excessMinutes: number;
}

/**
 * The two EASA column groups this module checks, identified by their column
 * prefix rather than by a hardcoded list of keys.
 *
 * Reading the registry means a future pilot-function column — EASA has added
 * them before — joins the check by existing, with no edit here. Listing the
 * keys inline would make this the second place that has to be remembered.
 */
const PILOT_FUNCTION_PREFIX = 'Pilot Function Time ';
const OPERATIONAL_CONDITION_PREFIX = 'Operational Condition Time ';

function fieldsWithColumnPrefix(prefix: string, entryType: EntryType): FieldDefinition[] {
  return FIELDS.filter(
    (f) => f.summable && f.easaColumn.startsWith(prefix) && appliesTo(f, entryType),
  );
}

/** Read a field's value off a record, honouring core vs `extra` storage. */
function readValue(record: Record<string, unknown>, field: FieldDefinition): unknown {
  if (field.storage === 'extra') {
    const extra = record.extra as Record<string, unknown> | undefined;
    return extra ? extra[field.key] : undefined;
  }
  return record[field.key];
}

/**
 * A field's value as a number, or `null` when it cannot be read as one.
 *
 * Absent and empty both mean "nothing logged here", which is 0. Anything else
 * that is not a finite number — a half-typed string, `NaN` from a failed parse —
 * returns `null`, and a check that sees a `null` declines to run rather than
 * guessing. The form calls this on every keystroke, so half-typed input is the
 * normal case, not an error case.
 */
function readMinutes(record: Record<string, unknown>, field: FieldDefinition): number | null {
  const raw = readValue(record, field);
  if (raw === undefined || raw === null || raw === '') return 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw;
}

/**
 * The yardstick's value, or `null` when there is nothing to measure against.
 *
 * Deliberately stricter than `readMinutes`: an ABSENT total is not zero, it is
 * a total that has not been typed yet, and a check run against it would warn on
 * every keystroke in a fresh form. A total that really is the number zero is a
 * different thing and does get checked — a flight of no duration carrying 45
 * minutes of PIC time is exactly the mistake this module is for.
 */
function readYardstick(record: Record<string, unknown>, field: FieldDefinition): number | null {
  const raw = readValue(record, field);
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw;
}

function labelFor(key: string): string {
  return getField(key)?.label ?? key;
}

/**
 * Check a record's time columns against the total it should fit inside.
 *
 * Returns every finding, not just the first: a record with both a function-time
 * overrun and an IFR overrun has two separate mistakes in it.
 *
 * ONLY AN OVERRUN IS REPORTED. A function-time sum *below* the total is
 * ordinary and silent — plenty of flights log PIC and leave the rest at zero,
 * and the vast majority of a real import look exactly like that.
 * Reporting "under" would make the warning fire on nearly every flight, which
 * is the same as not having it.
 */
export function checkTimeSums(record: Flight | Record<string, unknown>): SumFinding[] {
  const source = record as Record<string, unknown>;
  const rawType = source.entryType;
  const entryType: EntryType = rawType === 'fstd' || rawType === 'flight' ? rawType : DEFAULT_ENTRY_TYPE;

  /*
    A flight is measured against its total time; a simulator session against its
    session time. `copySourceKey` already states that pairing for the form's
    "= total" button — reusing it is what stops a second definition drifting
    away from the first.
  */
  const yardstickKey = copySourceKey(entryType);
  const yardstickField = getField(yardstickKey);
  if (!yardstickField) return [];

  const yardstick = readYardstick(source, yardstickField);
  // No usable total means there is nothing to measure against. Silence, not a
  // finding: this is a form mid-edit, not a bad record.
  if (yardstick === null || yardstick < 0) return [];

  const findings: SumFinding[] = [];
  const yardstickLabel = yardstickField.label;

  // --- Pilot function time, summed --------------------------------------
  //
  // PIC + co-pilot + dual + instructor. These ARE additive with each other:
  // they describe the capacity the pilot occupied, and a single minute of
  // flight is normally spent in one of them.
  const functionFields = fieldsWithColumnPrefix(PILOT_FUNCTION_PREFIX, entryType);
  const functionValues = functionFields.map((f) => readMinutes(source, f));
  if (!functionValues.includes(null)) {
    const sum = functionValues.reduce((a: number, b) => a + (b as number), 0);
    if (sum > yardstick) {
      findings.push({
        kind: 'pilotFunction',
        keys: functionFields.map((f) => f.key),
        label: 'Pilot function time',
        sum,
        yardstickKey,
        yardstickLabel,
        yardstick,
        excessMinutes: sum - yardstick,
      });
    }
  }

  // --- Operational condition time, each on its own -----------------------
  //
  // Night and IFR are NOT additive with each other. A flight can be in darkness
  // and on instruments for its entire duration, so night + IFR legitimately
  // reaches twice the total. Summing them would fire on every night IFR flight
  // ever logged. Each is only ever compared with the yardstick alone.
  for (const field of fieldsWithColumnPrefix(OPERATIONAL_CONDITION_PREFIX, entryType)) {
    const value = readMinutes(source, field);
    if (value === null) continue;
    if (value > yardstick) {
      findings.push({
        kind: 'operationalCondition',
        keys: [field.key],
        label: labelFor(field.key),
        sum: value,
        yardstickKey,
        yardstickLabel,
        yardstick,
        excessMinutes: value - yardstick,
      });
    }
  }

  return findings;
}
