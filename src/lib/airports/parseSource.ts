/**
 * Reading the airport list a human supplied.
 *
 * This runs once, in the generator (`scripts/build-airports.spec.ts`), never in
 * the app. It lives in `src/` all the same, because the interesting part is
 * reading a coordinate somebody typed — degrees-minutes-seconds, hemispheres
 * written as letters or as minus signs, decimal commas — and that is precisely
 * the kind of code that fails silently and puts an aerodrome in the wrong
 * hemisphere. Silent failures need tests, and `npm test` only looks in `src/`.
 *
 * A wrong sign is the failure to fear here: it does not throw, it does not look
 * odd in a diff, and it produces a night calculation that is confidently and
 * completely wrong.
 *
 * The CSV itself is read with the app's own `import/csv` parser, which already
 * sniffs the delimiter and copes with a byte-order mark. One CSV reader.
 */
import { cellAt, parseCsv } from '../import/csv';
import { normalizeAerodromeCode } from './code';
import { SIMULATOR_AERODROME } from '../domain/flight';
import type { Airport } from './types';

/**
 * Header names that mean "the ICAO code", in order of preference.
 *
 * A source file can have more than one of these at once — OurAirports has
 * both `icao_code` (populated only for aerodromes with a real ICAO code) and
 * `ident` (populated for everything, falling back to the FAA identifier or a
 * synthetic code for the rest). Picking one column globally would starve
 * every row where the preferred column happens to be blank, so every
 * matching column is kept and each row tries them in this order until one
 * has a value.
 */
const CODE_HEADERS = ['icao', 'icao_code', 'ident', 'gps_code', 'code', 'airport', 'aerodrome'];
const IATA_HEADERS = ['iata', 'iata_code'];
const LAT_HEADERS = ['lat', 'latitude', 'lat_deg', 'latitude_deg', 'latitude_deg_dd'];
const LON_HEADERS = ['lon', 'lng', 'long', 'longitude', 'lon_deg', 'longitude_deg'];
const TYPE_HEADERS = ['type'];

/** Aerodrome types the night calculation has no use for, or that no longer exist. */
const EXCLUDED_TYPES = new Set(['heliport', 'seaplane_base', 'balloonport', 'closed']);

export interface AirportSourceReject {
  /** 1-based row number in the source file, as a spreadsheet would show it. */
  row: number;
  code: string;
  reason: string;
}

export interface AirportSource {
  airports: Airport[];
  rejected: AirportSourceReject[];
  /** Codes that appeared more than once. The first occurrence wins. */
  duplicates: string[];
  /** How many entries came from an IATA column rather than an ICAO one. */
  aliases: number;
  columns: { code: string; iata: string | null; lat: string; lon: string };
}

export type AirportSourceResult =
  | ({ ok: true } & AirportSource)
  | { ok: false; reason: string };

function findColumn(headers: readonly string[], candidates: readonly string[]): number {
  const normalized = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  for (const candidate of candidates) {
    const index = normalized.indexOf(candidate);
    if (index >= 0) return index;
  }
  return -1;
}

/** Every header that matches a candidate, in candidate-preference order — not just the first. */
function findColumns(headers: readonly string[], candidates: readonly string[]): number[] {
  const normalized = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const indices: number[] = [];
  for (const candidate of candidates) {
    const index = normalized.indexOf(candidate);
    if (index >= 0) indices.push(index);
  }
  return indices;
}

/**
 * A latitude or longitude as a human wrote it, in decimal degrees.
 *
 * Understands, because real files contain all of them:
 *
 *     60.1939            decimal
 *     60,1939            decimal, European comma
 *     -0.4614            decimal, sign for hemisphere
 *     60 11 38 N         degrees minutes seconds, hemisphere as a letter
 *     N60°11'38"         the same, punctuated
 *     601138N            the same, packed — the ARINC/AIP habit
 *     6011.63N           degrees and decimal minutes
 *
 * Returns NaN for anything else, including a value outside the range its axis
 * allows: a latitude of 118 is not a latitude, and quietly keeping it would put
 * an aerodrome somewhere impossible.
 */
export function parseCoordinate(raw: unknown, axis: 'lat' | 'lon'): number {
  let text = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (!text) return NaN;

  // Hemisphere as a letter, wherever it sits. Removed before the digits are read.
  const hemisphere = /[NSEW]/.exec(text)?.[0] ?? '';
  if (hemisphere) text = text.replace(/[NSEW]/g, ' ');

  // A single comma with no other separator is a decimal mark; anything else is
  // a separator between degrees, minutes and seconds.
  const commas = (text.match(/,/g) ?? []).length;
  text = commas === 1 && !/[.\s°'"′″]/.test(text) ? text.replace(',', '.') : text.replace(/,/g, ' ');
  text = text.replace(/[°'"′″:]/g, ' ');

  const parts = text.match(/-?\d+(?:\.\d+)?/g);
  if (!parts || parts.length === 0) return NaN;

  const negative = parts[0].startsWith('-') || hemisphere === 'S' || hemisphere === 'W';
  const first = Math.abs(Number(parts[0]));
  let degrees: number;

  if (parts.length >= 3) {
    degrees = first + Number(parts[1]) / 60 + Number(parts[2]) / 3600;
  } else if (parts.length === 2) {
    degrees = first + Number(parts[1]) / 60;
  } else if (hemisphere && !parts[0].includes('.') && parts[0].replace('-', '').length >= 4) {
    // Packed: DDMMSS, DDDMMSS, DDMM or DDDMM. Read from the right, because the
    // degrees field is two digits for a latitude and three for a longitude.
    const digits = parts[0].replace('-', '');
    if (digits.length >= 6) {
      degrees =
        Number(digits.slice(0, -4)) +
        Number(digits.slice(-4, -2)) / 60 +
        Number(digits.slice(-2)) / 3600;
    } else {
      degrees = Number(digits.slice(0, -2)) + Number(digits.slice(-2)) / 60;
    }
  } else {
    degrees = first;
  }

  if (!Number.isFinite(degrees)) return NaN;
  const signed = negative ? -degrees : degrees;
  const limit = axis === 'lat' ? 90 : 180;
  return Math.abs(signed) <= limit ? signed : NaN;
}

/**
 * Turn a supplied CSV into the airport list.
 *
 * Everything it decides rather than reads comes back in the result — the
 * columns it picked, the rows it dropped and why, the codes that appeared
 * twice. The generator prints all of it, because an import that silently drops
 * a fifth of a file is worse than one that refuses.
 *
 * The first occurrence of a code wins, and an ICAO entry always beats an IATA
 * one: `lookupAirport` is asked for whatever the logbook stored, and the
 * logbook stores ICAO.
 */
export function parseAirportSource(text: string, options: { iata?: boolean } = {}): AirportSourceResult {
  const parsed = parseCsv(text);
  if (!parsed.ok) return { ok: false, reason: parsed.rejection.message };

  const { headers, rows } = parsed.file;
  const codeIndices = findColumns(headers, CODE_HEADERS);
  const latIndex = findColumn(headers, LAT_HEADERS);
  const lonIndex = findColumn(headers, LON_HEADERS);
  const iataIndex = options.iata === false ? -1 : findColumn(headers, IATA_HEADERS);
  const typeIndex = findColumn(headers, TYPE_HEADERS);

  if (codeIndices.length === 0) {
    return { ok: false, reason: `no code column found — looked for ${CODE_HEADERS.join(', ')}` };
  }
  if (latIndex < 0 || lonIndex < 0) {
    return {
      ok: false,
      reason: `no latitude/longitude columns found — looked for ${LAT_HEADERS.join(', ')} and ${LON_HEADERS.join(', ')}`,
    };
  }

  const byCode = new Map<string, Airport>();
  const rejected: AirportSourceReject[] = [];
  const duplicates: string[] = [];
  const pendingAliases: { code: string; airport: Airport }[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 2; // +1 for the header, +1 for 1-based counting

    // First column in preference order that actually has a value for this
    // row — a source can populate `icao_code` for some rows and leave it to
    // `ident` for others, and a single global column choice would starve
    // whichever rows don't use it.
    let code = '';
    for (const idx of codeIndices) {
      code = normalizeAerodromeCode(cellAt(row, idx));
      if (code) break;
    }

    if (typeIndex >= 0) {
      const type = String(cellAt(row, typeIndex) ?? '')
        .trim()
        .toLowerCase();
      if (EXCLUDED_TYPES.has(type)) {
        rejected.push({ row: rowNumber, code, reason: `excluded type: ${type}` });
        return;
      }
    }

    const lat = parseCoordinate(cellAt(row, latIndex), 'lat');
    const lon = parseCoordinate(cellAt(row, lonIndex), 'lon');

    if (!code) {
      rejected.push({ row: rowNumber, code: '', reason: 'no code' });
      return;
    }
    if (!/^[A-Z0-9]{2,6}$/.test(code)) {
      rejected.push({ row: rowNumber, code, reason: 'code is not 2–6 letters or digits' });
      return;
    }
    if (code === SIMULATOR_AERODROME) {
      // "SIM" is the sentinel every FSTD entry stores in both aerodrome
      // fields, and it is also a real IATA code (Simbai, Papua New Guinea).
      // A simulator session that resolved to a place in the highlands of PNG
      // would be handed a night calculation for a flight that never left the
      // ground. `lookupAirport` refuses it too; this refuses to ship it.
      rejected.push({ row: rowNumber, code, reason: 'reserved: the simulator sentinel' });
      return;
    }
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      rejected.push({
        row: rowNumber,
        code,
        reason: `unreadable coordinates: ${cellAt(row, latIndex)} / ${cellAt(row, lonIndex)}`,
      });
      return;
    }

    if (byCode.has(code)) duplicates.push(code);
    else byCode.set(code, { code, lat, lon });

    if (iataIndex >= 0) {
      const iata = normalizeAerodromeCode(cellAt(row, iataIndex));
      // Held back until every ICAO code is in: an IATA code must never displace
      // an ICAO one, and the file's row order does not decide that.
      if (/^[A-Z0-9]{3}$/.test(iata) && iata !== SIMULATOR_AERODROME) {
        pendingAliases.push({ code: iata, airport: { code: iata, lat, lon } });
      }
    }
  });

  let aliases = 0;
  for (const { code, airport } of pendingAliases) {
    if (byCode.has(code)) continue;
    byCode.set(code, airport);
    aliases++;
  }

  return {
    ok: true,
    airports: [...byCode.values()],
    rejected,
    duplicates: [...new Set(duplicates)],
    aliases,
    columns: {
      code: codeIndices.map((idx) => headers[idx]).join(' > '),
      iata: iataIndex >= 0 ? headers[iataIndex] : null,
      lat: headers[latIndex],
      lon: headers[lonIndex],
    },
  };
}
