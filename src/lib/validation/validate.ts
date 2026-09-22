/**
 * Registry-driven validation, used by the storage layer's addFlight/updateFlight.
 *
 * Rules:
 *  - required fields present and non-empty
 *  - ICAO fields normalized (uppercased + trimmed) rather than rejected
 *  - durations: non-negative integers; picMinutes / multiPilotMinutes /
 *    nightMinutes must each be <= totalMinutes
 *  - landings (counts): non-negative integers
 *  - time-of-day fields match HH:MM (00:00–23:59)
 *  - dates match ISO YYYY-MM-DD
 *
 * Returns structured errors (never throws for validation failures) plus a
 * NORMALIZED copy of the record with ICAO fields cleaned up. `extra` is copied
 * through untouched.
 */
import { appliesTo, DEFAULT_ENTRY_TYPE, FIELDS, isRequiredFor } from '../registry/fields';
import type { FieldDefinition } from '../registry/types';
import { SIMULATOR_AERODROME, type EntryType, type Flight } from '../domain/flight';

export interface ValidationError {
  key: string;
  message: string;
}

export interface ValidationResult {
  errors: ValidationError[];
  /** The input with normalizations applied (ICAO uppercased/trimmed). */
  normalized: Flight;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function readValue(record: Record<string, unknown>, field: FieldDefinition): unknown {
  if (field.storage === 'extra') {
    const extra = record.extra as Record<string, unknown> | undefined;
    return extra ? extra[field.key] : undefined;
  }
  return record[field.key];
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** True ISO calendar date (rejects e.g. 2026-13-40). */
function isValidIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Validate and normalize a candidate flight record. The caller (addFlight /
 * updateFlight) passes a COMPLETE record (defaults already filled); this keeps
 * the rules simple and registry-driven.
 */
export function validateFlight(input: Flight | Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];
  // `Flight` is an interface, so it has no implicit index signature; widen once
  // here rather than casting at every call site.
  const record = input as Record<string, unknown>;
  // Shallow clone; extra is copied by reference-safe spread below.
  const normalized: Record<string, unknown> = { ...record };
  normalized.extra = { ...((record.extra as Record<string, unknown>) ?? {}) };

  // Which kind of entry this is decides which fields apply, which are required,
  // and what the component durations are measured against. Anything that is not
  // a recognised entry type is treated as a flight and reported below.
  const rawEntryType = record.entryType;
  const entryType: EntryType = rawEntryType === 'fstd' ? 'fstd' : DEFAULT_ENTRY_TYPE;
  if (rawEntryType !== undefined && rawEntryType !== 'flight' && rawEntryType !== 'fstd') {
    errors.push({ key: 'entryType', message: 'Entry Type must be "flight" or "fstd".' });
  }

  for (const field of FIELDS) {
    // A field that does not apply to this entry type is not validated for it —
    // there is no such thing as an off-block time on a simulator session.
    if (!appliesTo(field, entryType)) continue;

    const required = isRequiredFor(field, entryType);
    let value = readValue(record, field);

    // Normalize ICAO before the required/empty check so " engm " counts.
    if (field.type === 'icao' && typeof value === 'string') {
      value = value.trim().toUpperCase();
      if (field.storage === 'extra') {
        (normalized.extra as Record<string, unknown>)[field.key] = value;
      } else {
        normalized[field.key] = value;
      }
    }

    if (required && isEmpty(value)) {
      errors.push({ key: field.key, message: `${field.label} is required.` });
      continue;
    }

    // Optional and absent: nothing more to check.
    if (isEmpty(value) && !required) continue;

    switch (field.type) {
      case 'date':
        if (typeof value !== 'string' || !isValidIsoDate(value)) {
          errors.push({ key: field.key, message: `${field.label} must be a valid date (YYYY-MM-DD).` });
        }
        break;
      case 'timeOfDay':
        if (typeof value !== 'string' || !TIME_RE.test(value)) {
          errors.push({ key: field.key, message: `${field.label} must be a time (HH:MM, 00:00–23:59).` });
        }
        break;
      case 'durationMinutes':
      case 'count':
        if (!isNonNegativeInteger(value)) {
          errors.push({ key: field.key, message: `${field.label} must be a non-negative whole number.` });
        }
        break;
      case 'icao':
      case 'text':
      case 'remarks':
        if (typeof value !== 'string') {
          errors.push({ key: field.key, message: `${field.label} must be text.` });
        }
        break;
    }
  }

  // Cross-field: component durations cannot exceed the session they belong to.
  //
  // On an FSTD entry that yardstick is `simulatorMinutes`, NOT `totalMinutes` —
  // the latter is zero by invariant, so measuring against it would reject every
  // simulator session that logged any instrument or instructor time.
  const isFstd = entryType === 'fstd';
  const yardstickKey = isFstd ? 'simulatorMinutes' : 'totalMinutes';
  const yardstick = record[yardstickKey];
  const yardstickLabel = isFstd ? 'Simulator' : 'Total';
  const components = isFstd
    ? (['ifrMinutes', 'instructorMinutes', 'dualMinutes'] as const)
    : (['picMinutes', 'multiPilotMinutes', 'nightMinutes'] as const);

  if (isNonNegativeInteger(yardstick)) {
    for (const key of components) {
      const v = record[key];
      if (isNonNegativeInteger(v) && v > yardstick) {
        const label = FIELDS.find((f) => f.key === key)?.label ?? key;
        errors.push({
          key,
          message: `${label} (${v}) cannot exceed ${yardstickLabel} (${yardstick}).`,
        });
      }
    }
  }

  // The entry-type invariants. These are what make "simulator time is never
  // flight time" a property of the data rather than a convention the UI happens
  // to follow, so they are enforced on the way in to storage.
  if (isFstd) {
    if (record.totalMinutes !== 0) {
      errors.push({
        key: 'totalMinutes',
        message: 'A simulator session cannot carry flight time — Total must be 0.',
      });
    }
    if (record.registration !== undefined && record.registration !== '') {
      errors.push({
        key: 'registration',
        message: 'A simulator session has a device id, not a registration.',
      });
    }
    for (const key of ['depAerodrome', 'arrAerodrome'] as const) {
      if (normalized[key] !== SIMULATOR_AERODROME) {
        const label = FIELDS.find((f) => f.key === key)?.label ?? key;
        errors.push({
          key,
          message: `${label} must be "${SIMULATOR_AERODROME}" on a simulator session.`,
        });
      }
    }
  } else {
    if (isNonNegativeInteger(record.simulatorMinutes) && record.simulatorMinutes !== 0) {
      errors.push({
        key: 'simulatorMinutes',
        message: 'A flight cannot carry simulator time.',
      });
    }
    if (record.simulatorRegistration !== undefined && record.simulatorRegistration !== '') {
      errors.push({
        key: 'simulatorRegistration',
        message: 'A flight cannot carry a simulator device id.',
      });
    }
  }

  return { errors, normalized: normalized as unknown as Flight };
}
