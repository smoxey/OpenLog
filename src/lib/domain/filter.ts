/**
 * Search and filter — one definition of what a filter means.
 *
 * PURE: flights and criteria in, flights out. No storage, no settings, no
 * clock, no DOM. It runs on every keystroke against the whole logbook, so it
 * has to be cheap as well as testable: the budget is 2,000 flights and the list
 * must stay interactive.
 *
 * EVERY CRITERION NARROWS. They compose with AND, always — type AND date range
 * AND aerodrome. There is no mode, no toggle and no OR, because a filter that
 * sometimes widens is a filter a pilot cannot predict.
 *
 * This module deliberately does NOT total the filtered set. That was considered
 * and left out: it would quietly become a second totals implementation with
 * different rules about simulator time and the opening balance, and the moment
 * the two disagreed the app would be lying on one of the two screens.
 */
import { normalizeRegistration } from './aircraft';
import type { Flight } from './flight';

export interface FilterCriteria {
  /** Free text over remarks, aerodromes, registration and type. */
  text: string;
  /** Inclusive ISO date bounds. Empty means unbounded on that side. */
  from: string;
  to: string;
  aircraftType: string;
  registration: string;
  /** Matched against EITHER aerodrome — "flights that touched ENBR". */
  aerodrome: string;
}

export const EMPTY_CRITERIA: FilterCriteria = {
  text: '',
  from: '',
  to: '',
  aircraftType: '',
  registration: '',
  aerodrome: '',
};

/** Whether anything is actually being filtered. */
export function isEmptyCriteria(criteria: FilterCriteria): boolean {
  return (
    norm(criteria.text) === '' &&
    criteria.from.trim() === '' &&
    criteria.to.trim() === '' &&
    norm(criteria.aircraftType) === '' &&
    norm(criteria.registration) === '' &&
    norm(criteria.aerodrome) === ''
  );
}

/** Trim, collapse inner whitespace, and casefold. The one normalization used. */
function norm(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Text of a flight the free-text box searches. */
function haystack(flight: Flight): string {
  return norm(
    [
      flight.remarks,
      flight.depAerodrome,
      flight.arrAerodrome,
      flight.registration,
      flight.aircraftType,
      // A simulator session has no registration; its device id is the nearest
      // thing, and a pilot searching "EU-DK187" means that session.
      flight.simulatorRegistration,
    ].join(' '),
  );
}

/**
 * Narrow a set of flights.
 *
 * Order is preserved: the caller has already sorted, and re-sorting here would
 * make a filter silently change the list's ordering as well as its contents.
 */
export function filterFlights(
  flights: readonly Flight[],
  criteria: FilterCriteria,
): Flight[] {
  if (isEmptyCriteria(criteria)) return [...flights];

  const text = norm(criteria.text);
  const from = criteria.from.trim();
  const to = criteria.to.trim();
  const type = norm(criteria.aircraftType);
  // Through the one function that decides registration identity, so `ln-abc`
  // finds `LN-ABC` here exactly as it does in the aircraft store.
  const registration = normalizeRegistration(criteria.registration);
  const aerodrome = norm(criteria.aerodrome);

  return flights.filter((flight) => {
    if (text !== '' && !haystack(flight).includes(text)) return false;

    const date = typeof flight.date === 'string' ? flight.date : '';
    // A record with no usable date cannot satisfy a date bound. It is only
    // excluded when a bound is actually set, so an unfiltered list keeps it.
    if (from !== '' && (date === '' || date < from)) return false;
    if (to !== '' && (date === '' || date > to)) return false;

    if (type !== '' && !norm(flight.aircraftType).includes(type)) return false;

    if (registration !== '') {
      const own = normalizeRegistration(String(flight.registration ?? ''));
      const device = normalizeRegistration(String(flight.simulatorRegistration ?? ''));
      if (!own.includes(registration) && !device.includes(registration)) return false;
    }

    if (aerodrome !== '') {
      const dep = norm(flight.depAerodrome);
      const arr = norm(flight.arrAerodrome);
      // EITHER end. "Show me everything that touched ENBR" is the question a
      // pilot is actually asking; requiring both would answer a different one.
      if (!dep.includes(aerodrome) && !arr.includes(aerodrome)) return false;
    }

    return true;
  });
}
