/**
 * CSV export — the interchange format.
 *
 * Its guarantee is deliberately weaker than JSON's, and the UI says so next to
 * the option. CSV has no types, no file-level header, and no way to express
 * nesting, so it carries flat scalars only. Anything it cannot represent is
 * OMITTED and REPORTED — never stringified into something that would re-import
 * as garbage.
 *
 * Columns are generated from the registry's `easaColumn`, in registry order.
 * There is no hand-written column list here or anywhere else; adding a registry
 * field adds a column automatically.
 *
 * PURE: records in, string out. The caller passes the spreadsheet format in —
 * this module never reads settings, and export output never depends on the
 * user's *display* preference (`Claude Context/HOW_IT_WORKS.md`).
 */
import Papa from 'papaparse';
import { FIELDS } from '../registry/fields';
import type { FieldDefinition } from '../registry/types';
import { minutesToDecimal } from '../time/duration';
import { readFieldValue } from '../format';
import type { Flight } from '../domain/flight';
import {
  SPREADSHEET_PROFILES,
  type CsvExportOptions,
  type CsvExportResult,
  type ExportBundle,
  type ExportWarning,
} from './types';
import { sortFlights } from './order';

/** Excel garbles accented characters without this. Present in both variants. */
const BOM = '﻿';

/** What CSV can carry. Anything else needs JSON. */
function isFlatScalar(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/** Apply the profile's decimal mark to an already-formatted number string. */
function withDecimalMark(numeric: string, decimal: '.' | ','): string {
  return decimal === '.' ? numeric : numeric.replace('.', decimal);
}

/** Format one registry field for a CSV cell. Registry-driven, never per-field. */
function formatRegistryCell(
  flight: Flight,
  field: FieldDefinition,
  decimal: '.' | ',',
): string {
  const raw = readFieldValue(flight, field);
  switch (field.type) {
    case 'durationMinutes':
      // Always decimal hours to one place, regardless of the display setting.
      return withDecimalMark(minutesToDecimal(typeof raw === 'number' ? raw : 0), decimal);
    case 'count':
      return String(typeof raw === 'number' ? raw : 0);
    default:
      // Dates stay YYYY-MM-DD and times stay HH:MM UTC — both already stored
      // in exactly that form, so there is nothing to reformat.
      return raw == null ? '' : String(raw);
  }
}

/** Format a flat scalar from `extra` for a CSV cell. */
function formatExtraCell(value: unknown, decimal: '.' | ','): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? withDecimalMark(String(value), decimal) : '';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * Serialize flights to CSV.
 *
 * The aircraft table is deliberately NOT included: CSV is one flat table of
 * flights, and a second entity would need either a second file or a column set
 * that no other logbook app would understand. Aircraft profiles ride in the
 * JSON export, which is the format that promises a complete restore.
 */
export function serializeCsv(
  bundle: ExportBundle,
  options: CsvExportOptions,
): CsvExportResult {
  const { delimiter, decimal } = SPREADSHEET_PROFILES[options.spreadsheetFormat];
  const flights = sortFlights(bundle.flights);
  const warnings: ExportWarning[] = [];

  // Registry columns, in registry order, headed by their EASA column name.
  const registryFields = FIELDS;
  const registryKeys = new Set(registryFields.map((f) => f.key));

  // Extra columns: the union of `extra` keys across every exported flight,
  // alphabetical, minus anything the registry already emits as a column.
  const extraKeys = new Set<string>();
  for (const flight of flights) {
    for (const key of Object.keys(flight.extra ?? {})) {
      if (!registryKeys.has(key)) extraKeys.add(key);
    }
  }

  const scalarExtraKeys: string[] = [];
  for (const key of [...extraKeys].sort()) {
    const offender = flights.find(
      (f) => f.extra && key in f.extra && !isFlatScalar(f.extra[key]),
    );
    if (offender) {
      warnings.push({
        key,
        message:
          `"${key}" was left out of the CSV: it holds a value CSV cannot represent ` +
          `(an object or a list). Export as JSON to keep it.`,
      });
      continue;
    }
    scalarExtraKeys.push(key);
  }

  const header = [
    ...registryFields.map((f) => f.easaColumn),
    ...scalarExtraKeys,
  ];

  const rows = flights.map((flight) => [
    ...registryFields.map((field) => formatRegistryCell(flight, field, decimal)),
    ...scalarExtraKeys.map((key) => formatExtraCell(flight.extra?.[key], decimal)),
  ]);

  // PapaParse owns all escaping — quoting rules for the delimiter, embedded
  // quotes and newlines are exactly what you do not want to hand-roll.
  const body = Papa.unparse([header, ...rows], {
    delimiter,
    newline: '\r\n',
    quotes: false,
  });

  return { csv: `${BOM}${body}\r\n`, warnings };
}
