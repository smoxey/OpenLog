/**
 * Airside -> a file the ordinary importer already knows how to read.
 *
 * WHY AN ADAPTER AND NOT A PRESET. A preset is a mapping, and a mapping is one
 * target per source column. Airside needs four things a mapping cannot say:
 *
 *  - one column holds FOUR values (`XY0123-20240115-OSL-BGO`);
 *  - the aerodromes are IATA and the logbook stores ICAO;
 *  - the registrations have had their hyphen removed;
 *  - the block times are on two DIFFERENT local clocks, and turning them into
 *    the UTC the logbook stores needs the whole file at once, not one row.
 *
 * So the file is rewritten first, into a plain thirteen-column table, and the
 * existing pipeline — mapping, transform, plan, conflicts, aircraft step,
 * preview — reads that without knowing Airside exists. Every rule the RB import
 * is held to applies unchanged, because it is the same code.
 *
 * THE ADAPTED FILE IS SHOWN TO THE PILOT, not hidden behind the wizard: the
 * columns step lists it like any other file, so what this module decided is
 * visible as data, and every decision is stated in the Airside step before that
 * with counts beside it. An import may transform; it may not transform
 * invisibly.
 *
 * NOTHING IS DROPPED. A row whose `Flight` cell cannot be read keeps its line
 * number and goes through with empty aerodromes, so the plan rejects it BY NAME
 * rather than the file quietly getting shorter. A row silently left out is
 * indistinguishable from one imported as zero, and this project has been bitten
 * by that twice.
 *
 * PURE: no storage, no settings, no clock, no DOM. The airport lookups and the
 * night calculation arrive as arguments, exactly as they do for `bulkNight`.
 */
import type { Airport } from '../../airports/types';
import { suggestNightForEntry } from '../../night/suggest';
import { addDays, timeOfDayToMinutes } from '../../time/blockTime';
import {
  formatOffset,
  localToUtc,
  minutesToTimeOfDay,
  parseTimeOfDayInput,
} from '../../time/timeOfDay';
import type { CsvRow, ParsedCsv } from '../csv';
import {
  AIRSIDE_HEADERS,
  hyphenateRegistration,
  parseAirsideFlight,
  parseAirsideLanding,
  registrationPrefix,
  suggestAircraftType,
  KNOWN_HYPHEN_PREFIXES,
} from './format';
import {
  assumedLines,
  exactlyResolvedCount,
  resolveZoneOffsets,
  type ZoneResolution,
  type ZoneRow,
} from './zones';

/** The columns the adapted file has. Ordinary names, one meaning each. */
export const ADAPTED_HEADERS = [
  'Flight Number',
  'Date',
  'Departure',
  'Arrival',
  'Block Off',
  'Block On',
  'Registration',
  'Aircraft Type',
  'Total Time',
  'Night',
  'Ldg Day',
  'Ldg Night',
  'Zone Assumed',
] as const;

// --- Surveying the file, before anything is decided ------------------------

/** An aerodrome the file mentions, and how often. */
export interface AirportUse {
  code: string;
  count: number;
}

/** A registration prefix the file uses, and what would happen to it. */
export interface PrefixUse {
  prefix: string;
  count: number;
  /** One registration carrying it, as written, for showing the change. */
  example: string;
  /** True when this app is confident the prefix takes a hyphen. */
  known: boolean;
}

/** A model code the file uses, and what this app would call it. */
export interface ModelUse {
  code: string;
  count: number;
  suggestion: string;
}

export interface AirsideSurvey {
  /** Aerodromes by how many sectors touch them, busiest first. */
  airports: AirportUse[];
  prefixes: PrefixUse[];
  models: ModelUse[];
  /** Registrations with no prefix this app recognises. Left exactly as written. */
  unrecognisedRegistrations: string[];
  /** Lines whose `Flight` cell could not be read at all. */
  unreadableLines: number[];
  /** Every row reduced to what the zone question needs. */
  zoneRows: ZoneRow[];
}

interface ParsedAirsideRow {
  line: number;
  flightNumber: string;
  /** The date inside the flight identifier — the SCHEDULED day. */
  scheduledDate: string;
  departure: string;
  arrival: string;
  date: string;
  offMinutes: number;
  offTime: string;
  arrivalDate: string;
  onMinutes: number;
  totalMinutes: number;
  registration: string;
  model: string;
  landed: boolean;
  /** False when the `Flight` cell did not parse. Everything routed is empty. */
  routed: boolean;
}

function columnIndexes(headers: readonly string[]): Record<string, number> {
  const index: Record<string, number> = {};
  for (const name of AIRSIDE_HEADERS) index[name] = headers.indexOf(name);
  return index;
}

function readRow(row: CsvRow, at: Record<string, number>): ParsedAirsideRow {
  const cell = (name: string): string => {
    const index = at[name];
    return index >= 0 ? (row.cells[index] ?? '').trim() : '';
  };

  const identifier = parseAirsideFlight(cell('Flight'));
  const offTime = parseTimeOfDayInput(cell('Block off')) ?? '';
  const onTime = parseTimeOfDayInput(cell('Block on')) ?? '';
  const total = Number(cell('Total Flight Time'));

  return {
    line: row.line,
    // A cell that would not parse still shows what it said, so a rejected row
    // is findable in the pilot's own file rather than known only by its line.
    flightNumber: identifier?.number ?? cell('Flight'),
    scheduledDate: identifier?.date ?? '',
    departure: identifier?.departure ?? '',
    arrival: identifier?.arrival ?? '',
    date: cell('Departure Date'),
    offMinutes: timeOfDayToMinutes(offTime),
    offTime,
    arrivalDate: cell('Arrival Date') || cell('Departure Date'),
    onMinutes: timeOfDayToMinutes(onTime),
    totalMinutes: Number.isFinite(total) ? Math.round(total) : NaN,
    registration: cell('Tail Number'),
    model: cell('Model'),
    landed: parseAirsideLanding(cell('Landing')),
    routed: identifier !== null,
  };
}

/**
 * Read the file once, to find out what questions to ask about it.
 *
 * Cheap on purpose — no zone arithmetic, no night calculation — because the
 * Airside step needs this before the pilot has answered anything, and needs it
 * again on every keystroke.
 */
export function surveyAirside(file: ParsedCsv): AirsideSurvey {
  const at = columnIndexes(file.headers);
  const rows = file.rows.map((row) => readRow(row, at));

  const airportCounts = new Map<string, number>();
  const prefixes = new Map<string, PrefixUse>();
  const models = new Map<string, ModelUse>();
  const unrecognised = new Set<string>();
  const unreadableLines: number[] = [];
  const zoneRows: ZoneRow[] = [];

  for (const row of rows) {
    if (!row.routed) unreadableLines.push(row.line);

    for (const code of [row.departure, row.arrival]) {
      if (code) airportCounts.set(code, (airportCounts.get(code) ?? 0) + 1);
    }

    if (row.registration) {
      const prefix = registrationPrefix(row.registration);
      if (!prefix || row.registration.includes('-')) {
        unrecognised.add(row.registration.toUpperCase());
      } else {
        const use = prefixes.get(prefix) ?? {
          prefix,
          count: 0,
          example: row.registration.toUpperCase(),
          known: KNOWN_HYPHEN_PREFIXES.includes(prefix),
        };
        use.count++;
        prefixes.set(prefix, use);
      }
    }

    if (row.model) {
      const code = row.model.toUpperCase();
      const use = models.get(code) ?? { code, count: 0, suggestion: suggestAircraftType(code) };
      use.count++;
      models.set(code, use);
    }

    if (row.routed) {
      zoneRows.push({
        line: row.line,
        departure: row.departure,
        arrival: row.arrival,
        date: row.date,
        offMinutes: row.offMinutes,
        arrivalDate: row.arrivalDate,
        onMinutes: row.onMinutes,
        totalMinutes: row.totalMinutes,
      });
    }
  }

  return {
    airports: [...airportCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1)),
    prefixes: [...prefixes.values()].sort((a, b) => b.count - a.count),
    models: [...models.values()].sort((a, b) => b.count - a.count),
    unrecognisedRegistrations: [...unrecognised].sort(),
    unreadableLines,
    zoneRows,
  };
}

// --- Adapting --------------------------------------------------------------

export interface AirsideOptions {
  /** Aerodrome code (as the file writes it) -> IANA zone name. */
  anchors: ReadonlyMap<string, string>;
  /** Whose zone stands in for a row nothing else could reach. */
  primaryAirport: string | null;
  /** Prefixes the pilot has agreed take a hyphen. */
  hyphenPrefixes: ReadonlySet<string>;
  /** Model code -> the designator to write. */
  aircraftTypes: ReadonlyMap<string, string>;
  /** Work night time out from the route, and place the landings by it. */
  computeNight: boolean;
}

export interface AirsideDeps {
  /** IATA -> ICAO. `undefined` when there is no single answer. */
  toIcao: (code: string) => string | undefined;
  /** Coordinates for an aerodrome code, for the night calculation. */
  lookupAirport: (code: string) => Airport | undefined;
}

export interface AirsideReport {
  rowsRead: number;
  /**
   * Rows that HAVE a zone question — that is, rows with a readable route.
   *
   * The denominator for `zonesResolved`, and deliberately not `rowsRead`: a row
   * whose `Flight` cell would not parse has no aerodromes and therefore no
   * clock to work out, so counting it as one this step failed to solve would
   * overstate the problem and understate the coverage.
   */
  zoneRowsRead: number;
  /** Rows whose `Flight` cell could not be read. They go through and are rejected. */
  unreadableLines: readonly number[];
  /** IATA codes with no unambiguous ICAO code. Kept as written; night still works. */
  unresolvedCodes: readonly string[];
  zones: ZoneResolution;
  /** How many rows the zone was worked out for rather than guessed at. */
  zonesResolved: number;
  /** Rows the primary anchor's zone had to stand in for. */
  zonesAssumed: readonly number[];
  /** Rows whose UTC departure date differs from the date in the file. */
  dateShifted: number;
  /**
   * Rows where the date inside the flight identifier is not the departure date.
   * The `Departure Date` column wins; this counts the disagreements.
   */
  scheduleMismatch: readonly number[];
  /** Rows a night figure was computed for. */
  nightRows: number;
  /** Night minutes this adaptation produced. */
  nightMinutes: number;
  /** Landings placed in the night column. */
  nightLandings: number;
  /** Landings that had to go in the day column because night could not be worked out. */
  unplacedLandings: number;
  /** Aerodrome codes that blocked a night calculation. */
  nightMissingAerodromes: readonly string[];
  survey: AirsideSurvey;
}

export interface AdaptedAirside {
  file: ParsedCsv;
  report: AirsideReport;
}

/**
 * Rewrite an Airside export as a plain table the importer can read.
 *
 * `file.rows` keeps its line numbers, one adapted row per source row, in order.
 */
export function adaptAirside(
  file: ParsedCsv,
  deps: AirsideDeps,
  options: AirsideOptions,
): AdaptedAirside {
  const at = columnIndexes(file.headers);
  const parsed = file.rows.map((row) => readRow(row, at));
  const survey = surveyAirside(file);
  const zones = resolveZoneOffsets(survey.zoneRows, options.anchors, options.primaryAirport);

  const unresolvedCodes = new Set<string>();
  const nightMissing = new Set<string>();
  const scheduleMismatch: number[] = [];
  let dateShifted = 0;
  let nightRows = 0;
  let nightMinutes = 0;
  let nightLandings = 0;
  let unplacedLandings = 0;

  const rows: CsvRow[] = parsed.map((row) => {
    // --- Aerodromes ------------------------------------------------------
    // An IATA code with no single ICAO twin is KEPT AS WRITTEN rather than
    // blanked. It is still a real entry in the bundled airport list — the
    // generator adds every IATA code as an alias — so the night calculation
    // still finds its coordinates and the flight still imports. The pilot is
    // told which codes these are.
    const departure = row.departure ? (deps.toIcao(row.departure) ?? row.departure) : '';
    const arrival = row.arrival ? (deps.toIcao(row.arrival) ?? row.arrival) : '';
    if (row.departure && !deps.toIcao(row.departure)) unresolvedCodes.add(row.departure);
    if (row.arrival && !deps.toIcao(row.arrival)) unresolvedCodes.add(row.arrival);

    if (row.routed && row.scheduledDate && row.date && row.scheduledDate !== row.date) {
      scheduleMismatch.push(row.line);
    }

    // --- The clock -------------------------------------------------------
    const offset = zones.byLine.get(row.line)?.offsetMinutes ?? 0;
    const shifted = row.offTime ? localToUtc(row.offTime, offset) : { time: '', dayShift: 0 };
    const utcDate = shifted.dayShift !== 0 ? addDays(row.date, shifted.dayShift) || row.date : row.date;
    if (utcDate !== row.date) dateShifted++;

    // THE ON-BLOCK IS THE OFF-BLOCK PLUS THE TOTAL, and that is not a shortcut.
    // `Total Flight Time` is the true elapsed time — the arrival's own clock is
    // in a zone this row may not have resolved, and the total is authoritative
    // for `totalMinutes` under the project's oldest domain rule anyway. Adding
    // it guarantees the stored interval agrees with the stored total, which is
    // what every later reader — night, conflicts, the duration sanity check —
    // relies on.
    const total = Number.isFinite(row.totalMinutes) ? row.totalMinutes : 0;
    const onTime =
      shifted.time && total >= 0 ? minutesToTimeOfDay(timeOfDayToMinutes(shifted.time) + total) : '';

    // --- Night, and the landing's column ---------------------------------
    let night = '';
    let landingsDay = row.landed ? 1 : 0;
    let landingsNight = 0;

    if (options.computeNight && row.routed && departure && arrival && shifted.time && onTime) {
      const suggestion = suggestNightForEntry(
        {
          entryType: 'flight',
          date: utcDate,
          offBlock: shifted.time,
          onBlock: onTime,
          depAerodrome: departure,
          arrAerodrome: arrival,
          totalMinutes: total,
        },
        deps.lookupAirport,
      );

      if (suggestion.status === 'ready') {
        nightRows++;
        nightMinutes += suggestion.nightMinutes;
        night = String(suggestion.nightMinutes);
        if (row.landed && suggestion.arrivalIsNight) {
          landingsDay = 0;
          landingsNight = 1;
          nightLandings++;
        }
      } else {
        for (const code of suggestion.missing) nightMissing.add(code);
        // A landing whose column could not be worked out goes in the day
        // column and is COUNTED, because a night landing filed as a day one is
        // a currency claim that is quietly wrong.
        if (row.landed) unplacedLandings++;
      }
    } else if (options.computeNight && row.landed) {
      unplacedLandings++;
    }

    const assumed = zones.byLine.get(row.line)?.source;
    const zoneAssumed = assumed === 'assumed' || assumed === 'none' ? formatOffset(offset) : '';

    return {
      line: row.line,
      cells: [
        row.flightNumber,
        utcDate,
        departure,
        arrival,
        shifted.time,
        onTime,
        hyphenateRegistration(row.registration, options.hyphenPrefixes),
        options.aircraftTypes.get(row.model.toUpperCase()) ?? suggestAircraftType(row.model),
        Number.isFinite(row.totalMinutes) ? String(row.totalMinutes) : '',
        night,
        String(landingsDay),
        String(landingsNight),
        zoneAssumed,
      ],
    };
  });

  return {
    file: {
      headers: [...ADAPTED_HEADERS],
      rows,
      delimiter: file.delimiter,
      hadBom: file.hadBom,
      issues: file.issues,
    },
    report: {
      rowsRead: file.rows.length,
      zoneRowsRead: survey.zoneRows.length,
      unreadableLines: survey.unreadableLines,
      unresolvedCodes: [...unresolvedCodes].sort(),
      zones,
      zonesResolved: exactlyResolvedCount(zones),
      zonesAssumed: assumedLines(zones),
      dateShifted,
      scheduleMismatch,
      nightRows,
      nightMinutes,
      nightLandings,
      unplacedLandings,
      nightMissingAerodromes: [...nightMissing].sort(),
      survey,
    },
  };
}
