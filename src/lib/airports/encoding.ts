/**
 * How the airport list is written down.
 *
 * The list is bundled with the app — never fetched, because a request to a
 * server for a table of numbers that has not changed since the 1940s would
 * break the one claim this project actually makes. Bundled means every byte is
 * shipped to every device, so the format is chosen for size:
 *
 *     ENGM,3dd8k,3lz3k
 *
 * One line per aerodrome. The two numbers are the latitude and longitude in
 * ten-thousandths of a degree — about 11 metres, which is far finer than
 * anything the night calculation can notice — offset to be positive and written
 * in base 36. That is 17 bytes or so per aerodrome, against 25 for plain
 * decimals, and it compresses about as well.
 *
 * The pairing of `encodeAirports` and `decodeAirports` is the whole contract,
 * and both live here so the generator and the app cannot drift apart: the
 * generator imports this module rather than reimplementing the format in a
 * build script. A format with two implementations has two formats.
 */
import type { Airport } from './types';

/** Ten-thousandths of a degree: about 11 m, and 5 base-36 digits. */
const SCALE = 10_000;
const LAT_OFFSET = 90;
const LON_OFFSET = 180;

function encodeValue(value: number, offset: number): string {
  return Math.round((value + offset) * SCALE).toString(36);
}

function decodeValue(text: string, offset: number): number {
  const raw = Number.parseInt(text, 36);
  if (!Number.isFinite(raw)) return NaN;
  return raw / SCALE - offset;
}

/** One aerodrome as one line. Exported for the round-trip test. */
export function encodeAirport(airport: Airport): string {
  return `${airport.code},${encodeValue(airport.lat, LAT_OFFSET)},${encodeValue(airport.lon, LON_OFFSET)}`;
}

/** The whole list as one string, one aerodrome per line, sorted by code.
 *  Sorted so that a regenerated file produces a reviewable diff rather than a
 *  reshuffle. */
export function encodeAirports(airports: readonly Airport[]): string {
  return [...airports]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map(encodeAirport)
    .join('\n');
}

/**
 * Read the bundled list back.
 *
 * Skips anything malformed rather than throwing. A damaged line costs one
 * aerodrome — which shows up as "not in the airport list" and no night
 * suggestion — where an exception would cost the whole entry form.
 */
export function decodeAirports(data: string): Airport[] {
  const airports: Airport[] = [];
  for (const line of data.split('\n')) {
    if (!line) continue;
    const comma = line.indexOf(',');
    const secondComma = line.indexOf(',', comma + 1);
    if (comma < 1 || secondComma < 0) continue;

    const code = line.slice(0, comma);
    const lat = decodeValue(line.slice(comma + 1, secondComma), LAT_OFFSET);
    const lon = decodeValue(line.slice(secondComma + 1), LON_OFFSET);
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;

    airports.push({ code, lat, lon });
  }
  return airports;
}
