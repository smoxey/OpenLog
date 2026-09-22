/**
 * The dry run — everything the preview needs, computed before anything is
 * written.
 *
 * The import's promise is that nothing reaches the logbook until the pilot has
 * seen what it will do. That promise is only as good as this module: if a count
 * here is wrong, the confirmation the pilot gave was for a different import
 * than the one that runs.
 *
 * PURE. No storage, no settings, no clock, no DOM. The whole preview is
 * therefore unit-testable without a browser or a database, which matters
 * because it is the screen a pilot uses to decide.
 *
 * ---
 *
 * CONFLICTS ARE CLUSTERED, NOT PAIRED, and this is not a presentation detail.
 * The real RB export contains several overlapping PAIRS, but they are only two
 * situations: three rows all overlap one another, and two more overlap each
 * other. Listed as pairs, the first situation appears three times
 * and invites the pilot to "skip" the same three rows in three separate
 * decisions. Grouped, it is one thing to look at and one decision to make.
 *
 * The rule itself is NOT redefined here. `findConflicts` in
 * `domain/conflicts.ts` is the single definition, shared with the entry form —
 * if the form and the importer disagreed about what a conflict is, the feature
 * would be worthless.
 */
import { findConflicts } from '../domain/conflicts';
import type { Flight } from '../domain/flight';
import type { Aircraft } from '../domain/aircraft';
import { minutesToDecimal } from '../time/duration';
import { elapsedMinutes } from '../time/blockTime';
import type { ParsedCsv } from './csv';
import type { ImportMapping } from './mapping';
import type { DurationUnit } from './units';
import {
  collectAircraftNeeds,
  parkedBlockKey,
  transformRow,
  type AircraftNeed,
  type RowFlag,
  type RowEdit,
  type RowIssue,
  type RowResult,
  type TransformContext,
} from './transform';

/** A row that will be written, with what was inferred about it. */
export interface PlannedRow {
  line: number;
  record: Flight;
  flags: RowFlag[];
  /** True when the pilot corrected this row in the conflict pause. */
  edited: boolean;
}

/** A row that will not be written, and why. */
export interface RejectedRow {
  line: number;
  label: string;
  issues: RowIssue[];
  /**
   * True when the only thing wrong is a missing aircraft type — a question, not
   * a fault. Kept separate so the preview never calls 23 ordinary rows
   * "invalid" and send the pilot hunting for damage in their file.
   */
  needsAircraft: boolean;
}

/**
 * A set of rows that mutually overlap in time, presented as one situation.
 *
 * `lines` are the source lines of the imported rows involved; `existing` names
 * flights ALREADY in the logbook that the group collides with. A group may have
 * either, or both — re-importing a file that is already in the logbook produces
 * groups that are entirely `existing` collisions.
 */
export interface ConflictGroup {
  /** Source lines of the imported rows in this group, ascending. */
  lines: number[];
  /** Ids of already-stored flights this group collides with. */
  existingIds: string[];
  /** One line of plain text describing the clash, for the preview. */
  summary: string;
}

export interface ImportPlan {
  /** Rows that will be written if the pilot confirms. */
  rows: PlannedRow[];
  /** Rows that will not be written because they could not be. */
  rejected: RejectedRow[];
  /**
   * Rows the pilot chose to leave out, still fully transformed.
   *
   * Kept rather than discarded so the UI can list them and offer them back —
   * a drop the pilot cannot undo is a worse trade than one they can.
   */
  skipped: PlannedRow[];
  /** Aircraft the file mentions, for the aircraft step. */
  aircraft: AircraftNeed[];
  /** Overlapping-time situations, grouped. Empty means no pause. */
  conflicts: ConflictGroup[];
  counts: ImportCounts;
  /** Claims about what the import will do, in words, for the pilot to refuse. */
  statements: string[];
  /**
   * Whether the durations being imported agree with the file's own block times.
   *
   * The guard against the worst mistake this wizard can make: reading whole
   * minutes as decimal hours, which multiplies a whole logbook by sixty.
   */
  durationCheck: DurationCheck;
}

export interface ImportCounts {
  rowsRead: number;
  /** Rows that will be written. */
  ready: number;
  /** Rows held back for a missing aircraft type. */
  needingAircraft: number;
  /** Rows held back for anything else. */
  errors: number;
  flights: number;
  simulatorSessions: number;
  /** Flight minutes this import adds. */
  flightMinutes: number;
  /** Simulator minutes this import adds. NEVER part of `flightMinutes`. */
  simulatorMinutes: number;
  /**
   * Block minutes found on simulator rows and deliberately NOT counted as
   * flight time. Reported so the trap is visible rather than merely avoided.
   */
  parkedSimulatorBlockMinutes: number;
  /** Rows whose co-pilot time was inferred rather than read. */
  inferredCoPilot: number;
  /** Imported rows involved in a conflict. */
  conflicting: number;
  /** Rows the pilot corrected before importing. */
  edited: number;
}

/** What the pilot decided about individual rows before importing. */
export interface PlanOptions {
  /**
   * Source lines to leave out — both the bulk "skip the conflicting rows"
   * answer and any row dropped individually from the conflict pause. One
   * concept, because they mean the same thing: do not import this line.
   */
  skipLines?: readonly number[];
  /**
   * Corrections keyed by source line, from the conflict pause.
   *
   * Applied inside the transform, so the plan that follows — including the
   * conflict grouping — is computed from the CORRECTED records. That is what
   * makes fixing an overlap remove it from the list as you type, rather than
   * leaving a stale warning behind.
   */
  edits?: ReadonlyMap<number, RowEdit>;
}

function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Does the duration unit agree with the file's own block times?
 *
 * THE FAILURE THIS EXISTS TO CATCH: a file holding whole minutes, read as
 * decimal hours. `138` becomes 138 HOURS instead of 138 minutes, and a whole
 * logbook imports as **tens of thousands of hours** — years of continuous
 * flight. It happened, to a real pilot, with a real file, and the preview
 * reported the figure without comment.
 *
 * The unit cannot be told from a single value, which is why the pilot can
 * override the sniff at all. But most logbook exports carry BLOCK TIMES beside
 * the totals, and those settle it: if a row says 07:05 to 09:23 and the total
 * we parsed is 8,280 minutes, the unit is wrong by a factor of sixty and the
 * file has already told us so.
 *
 * The median is used rather than the mean because a handful of rows legitimately
 * disagree with their own interval — RB has two, both timezone-crossing sectors
 * out by exactly an hour — and one outlier must not move the answer.
 */
export interface DurationCheck {
  /** Rows carrying both a total and a usable block interval. */
  comparable: number;
  /** Median of (imported total ÷ elapsed block interval). 1 means agreement. */
  ratio: number | null;
  /**
   * The unit the block times imply, when they disagree with the current one
   * by a factor far too large to be anything but a unit mistake. `null` means
   * either agreement or not enough evidence to say.
   */
  suggestion: DurationUnit | null;
}

/**
 * Ratios beyond these can only be a unit error.
 *
 * The true factor when minutes are read as hours is exactly 60, and 1/60 the
 * other way. 20 and 0.05 leave enormous margins: the worst LEGITIMATE
 * disagreement in the real RB file is a timezone sector whose total exceeds its
 * interval by an hour — a ratio of 1.5.
 */
const RATIO_FAR_TOO_LARGE = 20;
const RATIO_FAR_TOO_SMALL = 0.05;

export function checkDurationSanity(
  rows: readonly PlannedRow[],
  unit: DurationUnit,
): DurationCheck {
  const ratios: number[] = [];

  for (const { record } of rows) {
    // FSTD entries have no block times by definition, so there is nothing to
    // compare them against.
    if (record.entryType !== 'flight') continue;
    if (!record.offBlock || !record.onBlock || record.totalMinutes <= 0) continue;

    const interval = elapsedMinutes(record.offBlock, record.onBlock);
    if (!Number.isFinite(interval) || interval <= 0) continue;
    ratios.push(record.totalMinutes / interval);
  }

  if (ratios.length === 0) return { comparable: 0, ratio: null, suggestion: null };

  ratios.sort((a, b) => a - b);
  const ratio = ratios[Math.floor(ratios.length / 2)];

  // Totals far too big: the file's numbers are minutes, being read as hours.
  if (ratio >= RATIO_FAR_TOO_LARGE && unit !== 'minutes') {
    return { comparable: ratios.length, ratio, suggestion: 'minutes' };
  }
  // Totals far too small: the file's numbers are hours, being read as minutes.
  if (ratio <= RATIO_FAR_TOO_SMALL && unit !== 'decimalHours') {
    return { comparable: ratios.length, ratio, suggestion: 'decimalHours' };
  }
  return { comparable: ratios.length, ratio, suggestion: null };
}

/**
 * Group mutually-overlapping rows into single situations.
 *
 * A union-find over the imported rows: any two rows that conflict join the same
 * group, so a chain of overlaps becomes one group rather than several pairs.
 * Collisions with already-stored flights attach to whichever group the imported
 * row belongs to.
 */
function groupConflicts(
  planned: readonly PlannedRow[],
  existing: readonly Flight[],
): ConflictGroup[] {
  const parent = new Map<number, number>();
  const find = (line: number): number => {
    let root = parent.get(line) ?? line;
    if (root !== line) {
      root = find(root);
      parent.set(line, root);
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  const involved = new Set<number>();
  const existingHits = new Map<number, Set<string>>();
  const byId = new Map<string, PlannedRow>(planned.map((row) => [row.record.id, row]));

  // Imported vs imported. Every planned record carries a distinct id, which is
  // what lets `findConflicts` compare them against each other without a record
  // matching itself.
  const records = planned.map((row) => row.record);
  for (const row of planned) {
    for (const other of findConflicts(row.record, records)) {
      const otherRow = byId.get(other.id);
      if (!otherRow) continue;
      involved.add(row.line);
      involved.add(otherRow.line);
      union(row.line, otherRow.line);
    }
  }

  // Imported vs already stored. This is what catches importing the same file
  // twice — the second run's rows collide with the first run's records.
  for (const row of planned) {
    const hits = findConflicts(row.record, existing);
    if (hits.length === 0) continue;
    involved.add(row.line);
    const set = existingHits.get(row.line) ?? new Set<string>();
    for (const hit of hits) set.add(hit.id);
    existingHits.set(row.line, set);
  }

  const groups = new Map<number, ConflictGroup>();
  for (const line of [...involved].sort((a, b) => a - b)) {
    const root = find(line);
    const group = groups.get(root) ?? { lines: [], existingIds: [], summary: '' };
    group.lines.push(line);
    for (const id of existingHits.get(line) ?? []) {
      if (!group.existingIds.includes(id)) group.existingIds.push(id);
    }
    groups.set(root, group);
  }

  const result = [...groups.values()].sort((a, b) => a.lines[0] - b.lines[0]);
  for (const group of result) {
    group.lines.sort((a, b) => a - b);

    // The caller prints the line numbers, so the summary never repeats them —
    // "Line 2 — row 2 overlaps…" is the shape to avoid.
    const withinFile =
      group.lines.length > 1
        ? `${pluralize(group.lines.length, 'row')} in this file overlap each other`
        : '';
    const withStored =
      group.existingIds.length > 0
        ? `${group.lines.length > 1 ? 'overlap' : 'overlaps'} ` +
          `${pluralize(group.existingIds.length, 'flight')} already in your logbook`
        : '';

    group.summary =
      withinFile && withStored ? `${withinFile}, and ${withStored}` : withinFile || withStored;
  }
  return result;
}

/**
 * Work out exactly what this import would do.
 *
 * `existingFlights` and `existingAircraft` are the logbook as it stands, read
 * once by the caller. Passing them in rather than reading storage here is what
 * keeps this module pure and the preview testable.
 */
export function buildImportPlan(
  file: ParsedCsv,
  mapping: ImportMapping,
  context: TransformContext,
  existingFlights: readonly Flight[],
  existingAircraft: readonly Aircraft[],
  options: PlanOptions = {},
): ImportPlan {
  const skip = new Set(options.skipLines ?? []);

  const results: RowResult[] = file.rows.map((row) =>
    transformRow(row, file.headers, mapping, context, options.edits?.get(row.line)),
  );

  const rows: PlannedRow[] = [];
  const skipped: PlannedRow[] = [];
  const rejected: RejectedRow[] = [];

  for (const result of results) {
    if (result.ok) {
      const planned: PlannedRow = {
        line: result.line,
        record: result.record,
        flags: result.flags,
        edited: result.edited === true,
      };
      // A skipped row is still transformed and still described — it is simply
      // not going to be written. Keeping it lets the UI offer it back.
      if (skip.has(result.line)) skipped.push(planned);
      else rows.push(planned);
      continue;
    }
    rejected.push({
      line: result.line,
      label: result.label,
      issues: result.issues,
      needsAircraft: result.issues.every((issue) => issue.code === 'missing-aircraft'),
    });
  }

  const conflicts = groupConflicts(rows, existingFlights);

  const flights = rows.filter((row) => row.record.entryType === 'flight');
  const sessions = rows.filter((row) => row.record.entryType === 'fstd');
  const flightMinutes = flights.reduce((sum, row) => sum + row.record.totalMinutes, 0);
  const simulatorMinutes = sessions.reduce((sum, row) => sum + row.record.simulatorMinutes, 0);

  // The block time found on simulator rows and deliberately not counted. Read
  // back out of `extra` at exactly the key the transform parked it under — via
  // the shared helper, so the reader and the writer cannot drift apart — rather
  // than recomputed, which could quietly disagree with what was set aside.
  const parkedKey = parkedBlockKey(mapping, file.headers);
  const parkedSimulatorBlockMinutes = sessions.reduce((sum, row) => {
    if (!row.flags.includes('sim-block-parked')) return sum;
    const minutes = Number(row.record.extra[parkedKey]);
    return Number.isFinite(minutes) ? sum + minutes : sum;
  }, 0);

  const inferredCoPilot = rows.filter((row) => row.flags.includes('derived-copilot')).length;
  const edited = results.filter((result) => result.edited).length;
  const needingAircraft = rejected.filter((row) => row.needsAircraft).length;
  const conflicting = conflicts.reduce((sum, group) => sum + group.lines.length, 0);

  const counts: ImportCounts = {
    rowsRead: file.rows.length,
    ready: rows.length,
    needingAircraft,
    errors: rejected.length - needingAircraft,
    flights: flights.length,
    simulatorSessions: sessions.length,
    flightMinutes,
    simulatorMinutes,
    parkedSimulatorBlockMinutes,
    inferredCoPilot,
    conflicting,
    edited,
  };

  return {
    rows,
    rejected,
    skipped,
    aircraft: collectAircraftNeeds(file.rows, mapping),
    conflicts,
    counts,
    statements: buildStatements(counts, existingAircraft),
    durationCheck: checkDurationSanity(rows, mapping.duration.unit),
  };
}

/**
 * The claims the preview puts in front of the pilot.
 *
 * Every one of these describes something the import DECIDED rather than read.
 * An import may transform; it may not transform invisibly. These are written as
 * sentences a pilot can disagree with, because refusing them is the point.
 */
function buildStatements(counts: ImportCounts, existingAircraft: readonly Aircraft[]): string[] {
  const statements: string[] = [];

  statements.push(
    `${pluralize(counts.flights, 'flight')} adding ${minutesToDecimal(counts.flightMinutes)} hours of flight time.`,
  );

  if (counts.simulatorSessions > 0) {
    statements.push(
      `${pluralize(counts.simulatorSessions, 'simulator session')} adding ` +
        `${minutesToDecimal(counts.simulatorMinutes)} hours of simulator time. ` +
        `Simulator time is never counted as flight time.`,
    );
  }

  if (counts.parkedSimulatorBlockMinutes > 0) {
    // The simulator block-time trap, stated out loud. A pilot who has been bitten by
    // another importer will want to see this number named and excluded.
    statements.push(
      `${minutesToDecimal(counts.parkedSimulatorBlockMinutes)} hours of block time recorded against ` +
        `simulator sessions will be kept with those entries but NOT added to your flight time.`,
    );
  }

  if (counts.inferredCoPilot > 0) {
    statements.push(
      `${pluralize(counts.inferredCoPilot, 'flight')} in multi-pilot aircraft record no pilot function ` +
        `time, and will be logged as co-pilot time. This is worked out from the aircraft, not read ` +
        `from the file.`,
    );
  }

  if (counts.edited > 0) {
    // Stated because it is a change the pilot made to their own file's contents
    // on the way in. The imported record will not match the CSV, and they
    // should be reminded of that while they can still reconsider.
    statements.push(
      `${pluralize(counts.edited, 'row')} corrected here before importing. ` +
        `The corrected values are what will be saved, not what the file says.`,
    );
  }

  if (counts.needingAircraft > 0) {
    statements.push(
      `${pluralize(counts.needingAircraft, 'row')} cannot be imported until the aircraft they name has a type.`,
    );
  }

  if (counts.errors > 0) {
    statements.push(`${pluralize(counts.errors, 'row')} cannot be imported and will be left out.`);
  }

  if (existingAircraft.length === 0 && counts.ready > 0) {
    statements.push('Aircraft you confirm here will be remembered for next time.');
  }

  return statements;
}
