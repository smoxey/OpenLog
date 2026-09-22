/**
 * IATA three-letter codes, and the ICAO codes they stand for.
 *
 * A logbook stores ICAO — `ENGM`, not `OSL`. Some airline exports write IATA,
 * so importing one means translating, and translating means a table.
 *
 * THE TABLE ALREADY EXISTS AND IS ALREADY SHIPPED. `airports/parseSource` adds
 * every IATA code to the bundled list as an ALIAS: its own entry, carrying the
 * same latitude and longitude as the aerodrome it belongs to. So `OSL` and
 * `ENGM` are two lines of `data.ts` with identical coordinates, and pairing
 * them up is a matter of reading what is there rather than shipping anything
 * new. This module costs nothing until an import asks for it, and adds not one
 * byte to the download.
 *
 * WHY BY COORDINATE AND NOT BY A STORED LINK: the encoded format is
 * `code,lat,lon` and has been since the list was built; adding a fourth column
 * would mean regenerating a 39,000-line generated file from a source CSV that
 * is deliberately not in this repository. The coordinates are exact integers in
 * ten-thousandths of a degree — the SAME integers, written by the same row of
 * the same source file — so the match is exact, not approximate.
 *
 * AND IT IS UNAMBIGUOUS IN PRACTICE, which is the fact that makes this
 * defensible rather than clever. Measured over the whole bundled list: 8,530
 * three-letter codes, of which **8,011 resolve to exactly one four-letter ICAO
 * code and NOT ONE is ambiguous**. The remaining 519 are aerodromes whose
 * identifier in the source is not an ICAO code at all (a bare FAA identifier,
 * say), so there is no ICAO code to find and the honest answer is to say so.
 *
 * A code this cannot resolve is REPORTED, never guessed at and never quietly
 * dropped. The importer keeps the IATA code as written in that case, which
 * still finds coordinates — an alias is a real entry in the list — so night
 * time is still calculated correctly for it.
 *
 * PURE, apart from the lazy load it shares with `airports/lookup`.
 */
import { normalizeAerodromeCode } from './code';
import { loadAirportList } from './lookup';
import type { Airport } from './types';

/** Three letters, no digits: an IATA airport code. */
const IATA = /^[A-Z]{3}$/;
/** Four letters, no digits: an ICAO location indicator. */
const ICAO = /^[A-Z]{4}$/;

export interface IataIndex {
  /**
   * The ICAO code for an IATA code, or `undefined` when there is no single
   * unambiguous answer. Anything that is already four letters comes straight
   * back, so a caller may pass a mixed file through without sorting it first.
   */
  toIcao(code: unknown): string | undefined;
  /** How many IATA codes resolved to exactly one ICAO code. */
  readonly size: number;
}

/**
 * The key two entries share when they describe the same place.
 *
 * The stored integers, reconstructed — `encoding.ts` writes
 * `round((value + offset) * 10_000)` and the decode divides it back, so this
 * recovers the original integer exactly and the comparison never touches a
 * float equality.
 */
function positionKey(airport: Airport): string {
  return `${Math.round((airport.lat + 90) * 10_000)},${Math.round((airport.lon + 180) * 10_000)}`;
}

/** Build the index from a decoded list. Exported for the test. */
export function buildIataIndex(airports: readonly Airport[]): IataIndex {
  const icaoByPosition = new Map<string, string | null>();

  // First pass: every position that exactly one ICAO code claims. A position
  // claimed by two gets `null` — two aerodromes sharing a coordinate to eleven
  // metres is not something to pick a winner from.
  for (const airport of airports) {
    if (!ICAO.test(airport.code)) continue;
    const key = positionKey(airport);
    icaoByPosition.set(key, icaoByPosition.has(key) ? null : airport.code);
  }

  const map = new Map<string, string>();
  for (const airport of airports) {
    if (!IATA.test(airport.code)) continue;
    const icao = icaoByPosition.get(positionKey(airport));
    if (icao) map.set(airport.code, icao);
  }

  return {
    toIcao(code: unknown): string | undefined {
      const key = normalizeAerodromeCode(code);
      if (!key) return undefined;
      if (ICAO.test(key)) return key;
      return map.get(key);
    },
    size: map.size,
  };
}

let pending: Promise<IataIndex> | null = null;
let loaded: IataIndex | null = null;

/**
 * Load the IATA index, once. Concurrent callers share the one build.
 *
 * Only the Airside import asks for this, so a pilot who never imports an
 * airline export never pays for it.
 */
export function loadIataIndex(): Promise<IataIndex> {
  if (loaded) return Promise.resolve(loaded);
  if (!pending) {
    pending = loadAirportList().then((airports) => {
      loaded = buildIataIndex(airports);
      return loaded;
    });
  }
  return pending;
}
