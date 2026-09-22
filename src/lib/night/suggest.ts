/**
 * Night time for the entry form.
 *
 * `computeNightTime` answers a question about two points on the earth.
 * This is the layer above it that answers a question about a half-filled
 * logbook entry: it resolves the aerodrome codes, decides whether there is
 * enough typed in to say anything at all, and hands back either a number or a
 * plain reason there is no number.
 *
 * It is pure, and it takes the aerodrome lookup as an argument rather than
 * importing it. That is what lets the entry form's behaviour be tested without
 * a browser, a database or the real airport list — and it is the same shape
 * `findConflicts` uses, where the caller supplies the set to compare against.
 *
 * It never decides anything. The form applies the suggestion or does not, and
 * the pilot overrides it or does not; nothing here writes, blocks or disables.
 */
import type { EntryType } from '../domain/flight';
import type { Airport } from '../airports/types';
import { normalizeAerodromeCode } from '../airports/code';
import { computeNightTime, suggestNightMinutes } from './night';

export type NightSuggestionStatus =
  /** There is a number, and it is in `nightMinutes`. */
  | 'ready'
  /** Not enough typed in yet to say anything. Say nothing. */
  | 'incomplete'
  /** One or both aerodromes are not in the list — `missing` names them. */
  | 'unknownAerodrome'
  /** A simulator session. There is no sun in a simulator. */
  | 'notApplicable';

export interface NightSuggestion {
  status: NightSuggestionStatus;
  /** Night time in logbook minutes: rounded to the tenth and capped at the total. */
  nightMinutes: number;
  /** Exact night time before the logbook's conventions were applied. */
  exactMinutes: number;
  departureIsNight: boolean;
  arrivalIsNight: boolean;
  /** The sun sat close to the threshold; a pilot may legitimately disagree. */
  grazing: boolean;
  /**
   * The landing's column is a guess rather than a calculation — the sun was
   * near the threshold at the arrival aerodrome, and the taxi time no logbook
   * records is enough to move the answer. The form says so beside the landing
   * fields and asks; it never refuses to fill them in.
   */
  arrivalUncertain: boolean;
  /** Aerodrome codes that were typed but not found. */
  missing: readonly string[];
}

export interface NightEntryInput {
  entryType: EntryType;
  date: string;
  offBlock: string;
  onBlock: string;
  depAerodrome: string;
  arrAerodrome: string;
  /** The pilot's confirmed total, used as the cap. Zero means "not yet". */
  totalMinutes: number;
}

const NOTHING: NightSuggestion = {
  status: 'incomplete',
  nightMinutes: 0,
  exactMinutes: 0,
  departureIsNight: false,
  arrivalIsNight: false,
  grazing: false,
  arrivalUncertain: false,
  missing: [],
};

/**
 * What to suggest for the night field, given what has been typed so far.
 *
 * Runs on a form the pilot is still filling in, so half-typed input is the
 * normal case and produces `incomplete` — not an error, not a warning, and
 * nothing on the screen.
 */
export function suggestNightForEntry(
  input: NightEntryInput,
  lookup: (code: string) => Airport | undefined,
): NightSuggestion {
  // A simulator session has no aerodromes, no sun and no night column. The
  // registry already hides the field; this makes the answer explicit rather
  // than relying on the field being absent.
  if (input.entryType === 'fstd') return { ...NOTHING, status: 'notApplicable' };

  const departureCode = normalizeAerodromeCode(input.depAerodrome);
  const arrivalCode = normalizeAerodromeCode(input.arrAerodrome);
  if (!departureCode || !arrivalCode) return NOTHING;

  const departure = lookup(departureCode);
  const arrival = lookup(arrivalCode);
  const missing = [
    ...(departure ? [] : [departureCode]),
    ...(arrival ? [] : [arrivalCode]),
  ];

  if (!departure || !arrival) {
    // Only worth saying once the pilot has finished typing something that looks
    // like a code. "EN is not in the airport list" while they are still typing
    // ENGM would be noise.
    const plausible = missing.every((code) => code.length >= 3);
    return plausible
      ? { ...NOTHING, status: 'unknownAerodrome', missing }
      : NOTHING;
  }

  const result = computeNightTime({
    date: input.date,
    offBlock: input.offBlock,
    onBlock: input.onBlock,
    departure,
    arrival,
  });

  if (!result.ok) {
    // `badCoordinates` cannot happen — both aerodromes came out of the list —
    // but if the list ever ships a damaged record, "not in the airport list" is
    // the honest thing to say rather than a silent zero.
    return result.reason === 'badCoordinates'
      ? { ...NOTHING, status: 'unknownAerodrome', missing }
      : NOTHING;
  }

  return {
    status: 'ready',
    nightMinutes: suggestNightMinutes(result, input.totalMinutes),
    exactMinutes: result.nightMinutes,
    departureIsNight: result.departureIsNight,
    arrivalIsNight: result.arrivalIsNight,
    grazing: result.grazing,
    arrivalUncertain: result.arrivalUncertain,
    missing: [],
  };
}
