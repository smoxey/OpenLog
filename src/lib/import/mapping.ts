/**
 * What each column of a foreign CSV means — as DATA, not as code.
 *
 * A mapping is one target per source column. The importer never asks
 * `if (header === 'Duty Type')`; it asks what the mapping says. That is the
 * same discipline the field registry enforces everywhere else in this app
 * (`Claude Context/HOW_IT_WORKS.md`), and it is what lets a pilot correct a bad guess in
 * the mapping UI instead of waiting for a code change.
 *
 * PURE: no storage, no settings, no clock.
 *
 * ---
 *
 * TWO KINDS OF COLUMN NEED MORE THAN A FIELD NAME, and they are the reason
 * `role` exists alongside `field`:
 *
 *  - a column that STEERS the record rather than filling it in. RB's
 *    `Duty Type` decides whether a row is a flight or a simulator session; it
 *    is never stored anywhere.
 *  - a column whose destination DEPENDS on that decision. RB writes both
 *    registrations and simulator device ids into one `Aircraft ID` column, and
 *    they must land in different fields — `registration` for a flight,
 *    `simulatorRegistration` for a session. Sending a device id to
 *    `registration` would fill the aircraft store with simulators that are not
 *    aircraft, which is the exact thing `simulatorRegistration` exists to
 *    prevent.
 *
 * WHAT DELIBERATELY IS NOT A ROLE: `Dual Given` and `Instructor` both mean
 * `instructorMinutes`. That needs no special machinery — two columns simply
 * target the same field, and `transform` applies one documented merge rule.
 * Expressing it as a role would have made a general shape into a special case.
 */
import { FIELDS, appliesTo, ENTRY_TYPES, getField } from '../registry/fields';
import type { FieldDefinition } from '../registry/types';
import type { DurationFormat } from './units';

/**
 * A column that does a job no field name can express.
 *
 * Kept to the two the format genuinely needs. Every role is a small exception
 * to "the registry describes everything", so the bar for adding a third is
 * high: it must be something a target field cannot say.
 */
export type ImportRole =
  /** Decides `entryType`. Never stored. */
  | 'entryTypeDiscriminator'
  /** Registration on a flight, device id on a simulator session. */
  | 'aircraftIdentifier';

export type ColumnTarget =
  /** A registry field, by key. */
  | { kind: 'field'; key: string }
  | { kind: 'role'; role: ImportRole }
  /** Preserved under this key in `Flight.extra`. */
  | { kind: 'extra'; key: string }
  /** Read and thrown away, deliberately. */
  | { kind: 'ignore' };

export interface ImportMapping {
  /** One target per source column, aligned index-for-index with the headers. */
  targets: readonly ColumnTarget[];
  /** How every duration cell in this file is to be read. */
  duration: DurationFormat;
  /**
   * Values of the `entryTypeDiscriminator` column that mean "simulator
   * session". Compared case-insensitively after trimming. Anything else — an
   * empty cell included — means "flight", so a file with no discriminator at
   * all imports entirely as flights, which is the correct default for the many
   * logbook exports that have no concept of an FSTD row.
   */
  simulatorValues: readonly string[];
  /**
   * The zone the file's block times are written in, as minutes east of UTC.
   *
   * `0` — UTC — is the default and is what a logbook is supposed to hold, but
   * "supposed to" is not a guarantee about someone else's export: several apps
   * write local time and say nothing about it. So this is asked rather than
   * assumed, and the answer is applied once, to the whole file.
   *
   * It CANNOT be sniffed the way the duration unit can. `08:00` is a perfectly
   * good time in every zone there is, so there is no shape to read — the only
   * signal is a DST discontinuity across a whole year of flights, which is a
   * research project, not an import step. This app measured its own reference
   * file that way once (see `Claude Context/HOW_IT_WORKS.md`) and it took a session.
   *
   * Optional so every existing mapping, preset and test means UTC by omission.
   */
  timeZoneOffsetMinutes?: number;
  /** The preset this mapping started from, if any. Informational. */
  presetId?: string;
}

/** A named, pre-built mapping for a format we have characterised. */
export interface ImportPreset {
  id: string;
  label: string;
  description: string;
  /**
   * Column names that must ALL be present for this preset to claim a file.
   *
   * A signature, not an overlap score, and that distinction is load-bearing:
   * RB Logbook and our own export both have a column called `Date` and one
   * called `Aircraft Type`, so anything counting shared names would confuse the
   * two. Each signature names columns the OTHER format does not have.
   */
  signature: readonly string[];
  columns: Readonly<Record<string, ColumnTarget>>;
  simulatorValues: readonly string[];
  /** Things the pilot should know about this format, shown in the mapping step. */
  notes?: readonly string[];
}

export const IGNORE: ColumnTarget = { kind: 'ignore' };

/** Loosen a column name for comparison: case, spaces and punctuation all go. */
export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Every registry field a column may be mapped onto, in registry order. */
export function mappableFields(): readonly FieldDefinition[] {
  // `entryType` is excluded: it is not filled from a column, it is DECIDED by
  // the discriminator role. Offering it as a target would let a pilot map a
  // column onto it and quietly contradict the row's own entry type.
  return FIELDS.filter(
    (field) => field.key !== 'entryType' && ENTRY_TYPES.some((type) => appliesTo(field, type)),
  );
}

/** Human wording for a target, for the mapping UI and for test failures. */
export function describeTarget(target: ColumnTarget): string {
  switch (target.kind) {
    case 'field': {
      const field = FIELDS.find((f) => f.key === target.key);
      return field ? field.label : target.key;
    }
    case 'role':
      return target.role === 'entryTypeDiscriminator'
        ? 'Flight or simulator'
        : 'Registration / device id';
    case 'extra':
      return `Keep as "${target.key}"`;
    case 'ignore':
      return 'Ignore';
  }
}

/**
 * Guess a mapping for a file no preset claims.
 *
 * Three passes, narrowing: an exact EASA column name, then a loosened match
 * against the column name, the field label and the field key, then `extra`.
 *
 * Landing in `extra` is a SUCCESS, not a failure. It means the value is kept
 * under its own name and survives into every JSON export, rather than being
 * dropped because we had nowhere tidy to put it. Guessing a field wrongly would
 * be far worse than not guessing at all, so this stays conservative.
 */
export function autoMapHeaders(headers: readonly string[]): ColumnTarget[] {
  const fields = mappableFields();
  const byExact = new Map<string, FieldDefinition>();
  const byLoose = new Map<string, FieldDefinition>();

  for (const field of fields) {
    if (!byExact.has(field.easaColumn)) byExact.set(field.easaColumn, field);
    for (const alias of [field.easaColumn, field.label, field.key]) {
      const loose = normalizeHeader(alias);
      if (loose && !byLoose.has(loose)) byLoose.set(loose, field);
    }
  }

  const claimed = new Set<string>();
  return headers.map((header) => {
    if (header === '') return IGNORE;

    const exact = byExact.get(header);
    if (exact && !claimed.has(exact.key)) {
      claimed.add(exact.key);
      return { kind: 'field', key: exact.key };
    }

    const loose = byLoose.get(normalizeHeader(header));
    if (loose && !claimed.has(loose.key)) {
      claimed.add(loose.key);
      return { kind: 'field', key: loose.key };
    }

    // A second column matching an already-claimed field is NOT mapped onto it.
    // Two columns may legitimately share a field (the `Dual Given` /
    // `Instructor` pair), but that is a deliberate statement a preset makes —
    // never something a guess should decide on a file it has never seen.
    return { kind: 'extra', key: header };
  });
}

/**
 * Build the mapping for a file, from a preset when one claims it.
 *
 * Columns the preset does not mention fall through to `extra` under their own
 * heading, so a format that grows a column between releases keeps its data
 * instead of dropping it silently.
 */
export function buildMapping(
  headers: readonly string[],
  preset: ImportPreset | undefined,
  duration: DurationFormat,
): ImportMapping {
  const targets = preset
    ? headers.map<ColumnTarget>((header) =>
        header === '' ? IGNORE : (preset.columns[header] ?? { kind: 'extra', key: header }),
      )
    : autoMapHeaders(headers);

  return {
    targets: dedupeExtraKeys(targets),
    duration,
    simulatorValues: preset?.simulatorValues ?? DEFAULT_SIMULATOR_VALUES,
    presetId: preset?.id,
  };
}

/**
 * Values that mean "this row is a simulator session" when no preset says
 * otherwise. `1` is RB's; the words cover the formats that spell it out.
 */
export const DEFAULT_SIMULATOR_VALUES: readonly string[] = ['1', 'fstd', 'sim', 'simulator'];

/**
 * Make every `extra` key distinct — from the other extras, and from the
 * registry's own column names.
 *
 * Two reasons, both of them silent data corruption if skipped:
 *
 *  - A file with two columns both headed `Notes` would write one over the
 *    other and lose a column without a word — the same failure that keeping
 *    rows as arrays avoids on the parsing side.
 *  - An extra key equal to a field's EASA column name would give CSV export
 *    TWO columns with the same heading: the registry's, and the extra's.
 *    Re-importing that file could then map either one. Seeding the reserved
 *    set with the registry's names makes the collision impossible.
 */
function dedupeExtraKeys(targets: readonly ColumnTarget[]): ColumnTarget[] {
  const used = new Set<string>();
  for (const field of FIELDS) {
    used.add(field.easaColumn);
    used.add(field.key);
  }
  return targets.map((target) => {
    if (target.kind !== 'extra') return target;
    let key = target.key;
    let n = 2;
    while (used.has(key)) key = `${target.key} (${n++})`;
    used.add(key);
    return { kind: 'extra', key };
  });
}

/**
 * The cells to sniff a duration unit from: exactly the columns mapped to a
 * duration field, and nothing else.
 *
 * DRIVEN BY THE MAPPING, never by header names — and this is not fussiness. A
 * column called `Departure Time` holds `08:00`, which looks exactly like an
 * `hh:mm` DURATION. Sampling by name pulls it in, the file is judged to be in
 * `hh:mm`, and every real duration in it then parses wrongly: our own export's
 * `1.2` decimal hours comes back as 1 minute instead of 72.
 *
 * That is why the caller must build the mapping first and sniff second. The
 * mapping does not depend on the duration format to be built — only to be used.
 */
export function durationSamples(
  rows: readonly { cells: readonly string[] }[],
  mapping: ImportMapping,
): string[] {
  const columns: number[] = [];
  mapping.targets.forEach((target, index) => {
    if (target.kind !== 'field') return;
    if (getField(target.key)?.type === 'durationMinutes') columns.push(index);
  });

  const samples: string[] = [];
  for (const row of rows) {
    for (const index of columns) {
      const value = row.cells[index];
      if (value) samples.push(value);
    }
  }
  return samples;
}

/** Does the mapping send any column to this field? */
export function columnsForField(mapping: ImportMapping, key: string): number[] {
  const indices: number[] = [];
  mapping.targets.forEach((target, index) => {
    if (target.kind === 'field' && target.key === key) indices.push(index);
  });
  return indices;
}

/** The single column carrying a role, or -1. First wins if a file has two. */
export function columnForRole(mapping: ImportMapping, role: ImportRole): number {
  return mapping.targets.findIndex((t) => t.kind === 'role' && t.role === role);
}

/**
 * Is a row's discriminator cell saying "simulator"?
 *
 * Anything unrecognised means "flight". Defaulting the other way would turn an
 * unfamiliar value into a session with no flight time, silently removing hours
 * from the logbook — whereas defaulting to `flight` at worst imports a session
 * as a flight, which the preview shows and the pilot can see.
 */
export function isSimulatorValue(value: string, mapping: ImportMapping): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return false;
  return mapping.simulatorValues.some((candidate) => candidate.toLowerCase() === normalized);
}
