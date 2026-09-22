/**
 * Finding an aerodrome's coordinates.
 *
 * The list is a separate chunk, pulled in with a dynamic `import()` the first
 * time anything asks for an aerodrome. Two reasons, both deliberate:
 *
 * - **It is not in the startup path.** The app opens, the list opens the first
 *   time a flight is entered. A logbook that took a moment longer to show the
 *   flight list because of a table of coordinates would be a bad trade.
 * - **The service worker precaches it anyway**, so it is there offline — which
 *   is the point of bundling it rather than fetching it from somewhere.
 *
 * The parse happens once and the result is cached for the life of the page. Ten
 * thousand aerodromes take a few milliseconds to turn into a `Map`.
 */
import { normalizeAerodromeCode } from './code';
import { decodeAirports } from './encoding';
import { SIMULATOR_AERODROME } from '../domain/flight';
import type { Airport } from './types';

export interface AirportIndex {
  /** The aerodrome with this code, or undefined. Normalizes the code first. */
  get(code: unknown): Airport | undefined;
  /** How many aerodromes the list holds. */
  readonly size: number;
}

let pending: Promise<AirportIndex> | null = null;
let loaded: AirportIndex | null = null;
let pendingList: Promise<readonly Airport[]> | null = null;
let loadedList: readonly Airport[] | null = null;

/**
 * The whole list, decoded once and shared.
 *
 * `loadAirports` wants a map keyed by code; `airports/iata` wants to walk every
 * entry looking for the ICAO twin of an IATA code. Both want the same 39,000
 * lines parsed, and parsing them twice would cost a few milliseconds and a
 * second copy in memory for nothing. So the decode happens here, once, and both
 * indexes are built on top of it.
 */
export function loadAirportList(): Promise<readonly Airport[]> {
  if (loadedList) return Promise.resolve(loadedList);
  if (!pendingList) {
    pendingList = import('./data')
      .then(({ AIRPORT_DATA }) => {
        loadedList = decodeAirports(AIRPORT_DATA);
        return loadedList;
      })
      .catch((error) => {
        // A failed chunk load must not poison every later attempt: clear the
        // promise so the next caller tries again. An empty list means "no
        // aerodrome found", which every caller already knows how to say.
        pendingList = null;
        console.error('Airport list failed to load', error);
        return [];
      });
  }
  return pendingList;
}

function buildIndex(airports: readonly Airport[]): AirportIndex {
  const map = new Map<string, Airport>();
  for (const airport of airports) map.set(airport.code, airport);

  return {
    get(code: unknown): Airport | undefined {
      const key = normalizeAerodromeCode(code);
      // A simulator session stores "SIM" in both aerodrome fields. It is also a
      // real IATA code, so this is a guard against a right answer to the wrong
      // question — a device in a building has no sunset. The generator drops it
      // from the data as well; neither check makes the other redundant, because
      // one protects the file and one protects the caller.
      if (!key || key === SIMULATOR_AERODROME) return undefined;
      return map.get(key);
    },
    size: map.size,
  };
}

/**
 * Load the airport list, once. Concurrent callers share the one load.
 */
export function loadAirports(): Promise<AirportIndex> {
  if (loaded) return Promise.resolve(loaded);
  if (!pending) {
    // The decode and its failure handling both live in `loadAirportList`, so a
    // failed load arrives here as an empty list and becomes an empty index.
    pending = loadAirportList().then((airports) => {
      loaded = buildIndex(airports);
      return loaded;
    });
  }
  return pending;
}

/** One aerodrome, loading the list if it has not been loaded yet. */
export async function findAirport(code: unknown): Promise<Airport | undefined> {
  const index = await loadAirports();
  return index.get(code);
}

/**
 * The index, but only if it is already in memory.
 *
 * For the one caller that cannot wait — a `$derived` in a component, which is
 * synchronous. It returns undefined until the load finishes rather than
 * blocking, so the caller must be happy to be told "not yet" and to be woken
 * again. Anything that can await should call `loadAirports` instead.
 */
export function airportsIfLoaded(): AirportIndex | null {
  return loaded;
}
