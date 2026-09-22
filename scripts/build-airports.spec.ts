/**
 * Build `src/lib/airports/data.ts` from a CSV of aerodrome coordinates.
 *
 *   npm run airports:build
 *
 * It reads `data/airports.csv` if that file exists, and falls back to
 * `data/airports.seed.csv` — the fifty-odd well-known aerodromes committed to
 * the repo so the night feature is testable and demonstrable before a real list
 * arrives. Point it somewhere else with `AIRPORTS_SRC=path/to/file.csv`.
 *
 * **What the source file has to contain:** one row per aerodrome, with a column
 * of codes (`icao`, `ident`, `gps_code` and `code` are all recognised) and
 * columns of latitude and longitude. Any column order, any delimiter, header
 * row required, and every other column ignored. Coordinates may be decimal
 * degrees or degrees-minutes-seconds — see `parseCoordinate` for the forms it
 * reads. An `iata` column, if present, is indexed as well, and never displaces
 * an ICAO code.
 *
 * Then READ WHAT IT PRINTS. It reports every row it dropped and why, every code
 * that appeared twice, and the size of the file it wrote. A list that silently
 * lost a fifth of its rows would produce an app that silently declines to
 * calculate night time for a fifth of a logbook.
 *
 * It is a vitest spec for the same reason `regenerate-export-fixtures.spec.ts`
 * is: vitest is the only TypeScript runner this project has, and adding another
 * would mean another dependency. Living in `scripts/` keeps it out of the
 * `src/**` glob that `npm test` uses, so an ordinary test run never writes
 * anything.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeAirports } from '../src/lib/airports/encoding';
import { parseAirportSource } from '../src/lib/airports/parseSource';

const OUT = path.resolve(process.cwd(), 'src/lib/airports/data.ts');
const REAL = path.resolve(process.cwd(), 'data/airports.csv');
const SEED = path.resolve(process.cwd(), 'data/airports.seed.csv');

function sourcePath(): string {
  const override = process.env.AIRPORTS_SRC;
  if (override) return path.resolve(process.cwd(), override);
  return existsSync(REAL) ? REAL : SEED;
}

function label(file: string): string {
  return path.basename(file) === 'airports.seed.csv' ? 'seed' : path.basename(file);
}

describe('build the airport list', () => {
  it('writes src/lib/airports/data.ts', () => {
    const source = sourcePath();
    expect(existsSync(source), `no source file at ${source}`).toBe(true);

    const result = parseAirportSource(readFileSync(source, 'utf8'));
    if (!result.ok) throw new Error(`could not read ${source}: ${result.reason}`);

    const data = encodeAirports(result.airports);
    const contents = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by \`npm run airports:build\` from ${label(source)}. The format is
 * defined by \`encodeAirports\` / \`decodeAirports\` in ./encoding.ts, which is
 * the only place that knows it.
 */

/** Which source file this was built from. */
export const AIRPORT_SOURCE = ${JSON.stringify(label(source))};

/** How many aerodromes the list holds, including any IATA aliases. */
export const AIRPORT_COUNT = ${result.airports.length};

export const AIRPORT_DATA = \`${data}\`;
`;

    // Written with an explicit newline convention so a Windows checkout and a
    // Linux one produce the same file. The data itself is newline-separated and
    // a stray carriage return would end up inside an aerodrome's longitude.
    writeFileSync(OUT, contents.replace(/\r\n/g, '\n'), 'utf8');

    const bytes = Buffer.byteLength(contents, 'utf8');
    console.log(`  source           : ${source}`);
    console.log(`  columns          : code=${result.columns.code} lat=${result.columns.lat} lon=${result.columns.lon} iata=${result.columns.iata ?? '(none)'}`);
    console.log(`  aerodromes       : ${result.airports.length} (${result.aliases} from IATA)`);
    console.log(`  duplicate codes  : ${result.duplicates.length}`);
    console.log(`  rejected rows    : ${result.rejected.length}`);
    console.log(`  written          : ${OUT} (${(bytes / 1024).toFixed(1)} KB)`);

    if (result.duplicates.length) {
      console.log(`  duplicates       : ${result.duplicates.slice(0, 40).join(' ')}`);
    }
    for (const reject of result.rejected.slice(0, 40)) {
      console.log(`  dropped row ${reject.row} ${reject.code || '(no code)'}: ${reject.reason}`);
    }
    if (result.rejected.length > 40) {
      console.log(`  …and ${result.rejected.length - 40} more dropped rows`);
    }

    expect(result.airports.length).toBeGreaterThan(0);
  });
});
