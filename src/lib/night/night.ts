/**
 * How much of a flight was night.
 *
 * EASA night is the period between the end of evening civil twilight and the
 * beginning of morning civil twilight — that is, whenever the centre of the sun
 * sits more than 6° below the horizon. So the whole calculation is one question
 * asked repeatedly along the route: at this minute, at this point on the great
 * circle, is the sun below −6°?
 *
 * The model, stated once here and settled in `Claude Context/HOW_IT_WORKS.md`:
 *
 * - The aircraft is at the departure aerodrome at off-block and at the arrival
 *   aerodrome at on-block, covering a constant fraction of the great circle per
 *   minute. **Taxi is ignored.**
 * - The sun's altitude is taken at **sea level**. At cruise altitude the horizon
 *   dips and twilight lasts longer, so this reads slightly LESS night than an
 *   aircraft at FL350 actually sees. The logbook records no cruise altitude,
 *   and the aerodrome-based definition means the ground.
 *
 * Nothing here rounds and nothing here knows what a logbook is. The exact
 * figure comes out of `computeNightTime`; `suggestNightMinutes` is the separate
 * step that applies the logbook's tenths-of-an-hour convention — the same split
 * as `elapsedMinutes` and `suggestTotalMinutes` in `time/blockTime`.
 */
import { elapsedMinutes, isoDateToDayNumber, timeOfDayToMinutes } from '../time/blockTime';
import { interpolateGreatCircle, isValidCoordinates } from './greatCircle';
import { CIVIL_TWILIGHT_DEGREES, sunAltitudeDegrees, type Coordinates } from './solar';

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1440;
const TENTH_OF_HOUR_MINUTES = 6;

/**
 * How far from the threshold the sun has to get before the answer is safe.
 *
 * Measured on how DEEP a stretch went, not on how close the sun came at some
 * point: every crossing passes exactly through −6°, so "did it come within half
 * a degree" is true of every flight that gets dark and says nothing. What
 * matters is whether a stretch of night ever got properly dark, or a stretch of
 * day ever got properly light. A run whose deepest point is only a few tenths
 * past the threshold is one that a small error in position or timing would
 * flip, and this is the high-latitude case — a Nordic logbook is full of
 * flights where the sun tracks just under the horizon for an hour.
 */
const SHALLOW_DEGREES = 0.5;

/**
 * How long before on-block the wheels may have touched down.
 *
 * The model puts the aircraft at the arrival aerodrome at on-block, but the
 * landing happened whenever taxi-in began — and a logbook records no taxi time.
 * So the instant that decides the LANDING column is one this app does not have:
 * an aeroplane that blocks in five minutes after the end of civil twilight may
 * well have landed before it. Twenty minutes covers a long taxi at a large
 * aerodrome; it is a bound on the ignorance, not an estimate of the taxi.
 *
 * Nothing is decided from it. It only says whether the day-or-night answer for
 * the landing would have come out differently had the aircraft blocked in that
 * much earlier — which is exactly the case where the pilot, who was there,
 * knows better than the calculation does.
 */
const TAXI_IN_MINUTES = 20;

/** Whether it is night at a place and an instant. The single definition. */
export function isNightAt(when: Date, where: Coordinates): boolean {
  return sunAltitudeDegrees(when, where) < CIVIL_TWILIGHT_DEGREES;
}

export interface NightInput {
  /** ISO "YYYY-MM-DD" — the date of the flight, as the logbook records it. */
  date: string;
  /** "HH:MM" UTC. */
  offBlock: string;
  /** "HH:MM" UTC. A time earlier than `offBlock` means the flight crossed midnight. */
  onBlock: string;
  departure: Coordinates;
  arrival: Coordinates;
}

/** A stretch of night, in minutes measured from off-block. */
export interface NightSegment {
  start: number;
  end: number;
}

export type NightFailureReason = 'badDate' | 'badTimes' | 'badCoordinates';

export interface NightDetail {
  /** Exact night time in minutes. Not rounded, and not capped at anything. */
  nightMinutes: number;
  /** Block time in minutes, for whoever needs to cap a suggestion against it. */
  elapsedMinutes: number;
  /** Every stretch of night, in order, measured in minutes from off-block. */
  segments: readonly NightSegment[];
  /** Was the sun below −6° at the departure aerodrome at off-block? */
  departureIsNight: boolean;
  /** …and at the arrival aerodrome at on-block? */
  arrivalIsNight: boolean;
  /** Night from off-block to on-block, with no daylight in it at all. */
  allNight: boolean;
  /** No night at any point. The commonest answer, and the cheapest. */
  allDay: boolean;
  /**
   * The sun tracked close to the threshold without committing to either side —
   * a stretch of night that never got properly dark, or a stretch of day that
   * never got properly light.
   *
   * The answer is then a judgement call rather than a calculation, and a pilot
   * comparing it against what they logged may legitimately disagree. It is a
   * high-latitude phenomenon: near the solstice the sun can sit within a degree
   * of civil twilight for an hour at a time.
   */
  grazing: boolean;
  /**
   * Which column the LANDING belongs in is a coin-toss.
   *
   * True when the sun crossed civil twilight at the arrival aerodrome within
   * `TAXI_IN_MINUTES` of block-in — so the taxi time the logbook does not
   * record is enough to change the answer — or when it sat within
   * `SHALLOW_DEGREES` of the threshold there, where a small error in position
   * or timing would flip it.
   *
   * Distinct from `grazing`, which is about the night MINUTES over the whole
   * route: a flight can have an hour of unambiguous night in it and still block
   * in right on the boundary, and one can graze for an hour in the middle and
   * land in broad daylight.
   */
  arrivalUncertain: boolean;
}

export type NightResult =
  | ({ ok: true } & NightDetail)
  | { ok: false; reason: NightFailureReason };

/**
 * Night time for one flight.
 *
 * Never throws. A half-typed form, an aerodrome with no coordinates and a
 * malformed time are all ordinary outcomes with a reason attached — the same
 * shape `readBackup` uses, and for the same reason: this runs on a form the
 * pilot is still filling in.
 *
 * Cost is about one sun evaluation per minute of block time — roughly 1,100 for
 * a long-haul sector, each a few dozen floating-point operations. Sub-
 * millisecond, which is what lets the entry form call it on a change rather
 * than behind a button.
 */
export function computeNightTime(input: NightInput): NightResult {
  const dayNumber = isoDateToDayNumber(input.date ?? '');
  if (Number.isNaN(dayNumber)) return { ok: false, reason: 'badDate' };

  const offMinutes = timeOfDayToMinutes(input.offBlock ?? '');
  const elapsed = elapsedMinutes(input.offBlock ?? '', input.onBlock ?? '');
  if (Number.isNaN(offMinutes) || Number.isNaN(elapsed)) {
    return { ok: false, reason: 'badTimes' };
  }

  if (!isValidCoordinates(input.departure) || !isValidCoordinates(input.arrival)) {
    return { ok: false, reason: 'badCoordinates' };
  }

  // Off-block as an absolute instant. The date plus the time of day, in UTC —
  // the two halves the records store separately.
  const startMs = (dayNumber * MINUTES_PER_DAY + offMinutes) * MS_PER_MINUTE;

  const positionAt = (minute: number): Coordinates =>
    elapsed === 0
      ? input.departure
      : interpolateGreatCircle(input.departure, input.arrival, minute / elapsed);

  const altitudeAt = (minute: number): number =>
    sunAltitudeDegrees(new Date(startMs + minute * MS_PER_MINUTE), positionAt(minute));

  const departureIsNight = altitudeAt(0) < CIVIL_TWILIGHT_DEGREES;
  const arrivalIsNight = altitudeAt(elapsed) < CIVIL_TWILIGHT_DEGREES;

  // Whether the landing's column is safe. Asked at the point the aircraft
  // ENDED at, held still while the clock is wound back: taxi moves the landing
  // in time, not along the great circle. At `elapsed === 0` that point is the
  // departure aerodrome, which is the same one `arrivalIsNight` uses there.
  const landingPoint = positionAt(elapsed);
  const landingAltitudeAt = (minute: number): number =>
    sunAltitudeDegrees(new Date(startMs + minute * MS_PER_MINUTE), landingPoint);
  // Never further back than off-block: on a 12-minute sector the landing was
  // inside those 12 minutes, whatever a large aerodrome's taxi usually costs.
  const taxiIn = Math.min(TAXI_IN_MINUTES, elapsed);
  const arrivalUncertain =
    arrivalIsNight !== (landingAltitudeAt(elapsed - taxiIn) < CIVIL_TWILIGHT_DEGREES) ||
    Math.abs(landingAltitudeAt(elapsed) - CIVIL_TWILIGHT_DEGREES) < SHALLOW_DEGREES;

  if (elapsed === 0) {
    // A zero-duration entry — the aborted-before-taxi case that already exists
    // in the sample logbook. There is no time to be night IN, but the question
    // "was it dark?" still has an answer.
    return {
      ok: true,
      nightMinutes: 0,
      elapsedMinutes: 0,
      segments: [],
      departureIsNight,
      arrivalIsNight: departureIsNight,
      allNight: false,
      allDay: !departureIsNight,
      grazing: Math.abs(altitudeAt(0) - CIVIL_TWILIGHT_DEGREES) < SHALLOW_DEGREES,
      arrivalUncertain,
    };
  }

  // One sample per minute, plus the closing one at on-block.
  const segments: NightSegment[] = [];
  let grazing = false;
  let previousMinute = 0;
  const firstAltitude = altitudeAt(0);
  let previousIsNight = firstAltitude < CIVIL_TWILIGHT_DEGREES;
  let segmentStart = previousIsNight ? 0 : -1;

  // The deepest the current unbroken run of night (or of day) has got. See
  // SHALLOW_DEGREES: it is the depth of a run, not the closeness of a crossing,
  // that says whether the answer is safe.
  let runExtreme = firstAltitude;
  const runIsShallow = (extreme: number, night: boolean): boolean =>
    night
      ? extreme > CIVIL_TWILIGHT_DEGREES - SHALLOW_DEGREES
      : extreme < CIVIL_TWILIGHT_DEGREES + SHALLOW_DEGREES;

  for (let minute = 1; minute <= elapsed; minute++) {
    const altitude = altitudeAt(minute);
    const night = altitude < CIVIL_TWILIGHT_DEGREES;

    if (night !== previousIsNight) {
      if (runIsShallow(runExtreme, previousIsNight)) grazing = true;
      runExtreme = altitude;

      const crossing = refineCrossing(altitudeAt, previousMinute, minute);
      if (night) segmentStart = crossing;
      else {
        segments.push({ start: segmentStart, end: crossing });
        segmentStart = -1;
      }
    } else {
      // A night run is measured by how dark it got, a day run by how light.
      runExtreme = night
        ? Math.min(runExtreme, altitude)
        : Math.max(runExtreme, altitude);
    }

    previousMinute = minute;
    previousIsNight = night;
  }

  if (previousIsNight) segments.push({ start: segmentStart, end: elapsed });
  if (runIsShallow(runExtreme, previousIsNight)) grazing = true;

  const nightMinutes = segments.reduce((sum, s) => sum + (s.end - s.start), 0);

  return {
    ok: true,
    nightMinutes,
    elapsedMinutes: elapsed,
    segments,
    departureIsNight,
    arrivalIsNight,
    allNight: segments.length === 1 && segments[0].start === 0 && segments[0].end === elapsed,
    allDay: segments.length === 0,
    grazing,
    arrivalUncertain,
  };
}

/**
 * Where between two samples the sun crossed the threshold, to within a second.
 *
 * Bisection rather than linear interpolation: the sun's altitude is a sine, not
 * a line, and at high latitude around the solstice it is a very flat one — the
 * case where a straight-line estimate is worst is exactly the case a Nordic
 * logbook is full of. Sixteen halvings of a one-minute bracket is well under a
 * hundredth of a second, so the loop is capped by precision rather than by
 * patience.
 */
function refineCrossing(
  altitudeAt: (minute: number) => number,
  dayMinute: number,
  nightMinute: number,
): number {
  let low = dayMinute;
  let high = nightMinute;
  // The two ends differ by construction, so only one of them has to be read.
  const lowIsNight = altitudeAt(low) < CIVIL_TWILIGHT_DEGREES;

  for (let i = 0; i < 16; i++) {
    const mid = (low + high) / 2;
    if ((altitudeAt(mid) < CIVIL_TWILIGHT_DEGREES) === lowIsNight) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * The night time to put in the logbook, from the night time that was flown.
 *
 * Three logbook conventions, none of which belong in the physics:
 *
 * - **Rounded to the tenth of an hour**, because that is what a logbook records
 *   and what `suggestTotalMinutes` already does to the total.
 * - **Capped at the total**, because night time longer than the flight is
 *   nonsense and `validateFlight` has rejected it since Phase 1. Pass the total
 *   the pilot has confirmed; a total of zero (nothing entered yet) falls back
 *   to the block time.
 * - **A flight that was night throughout is logged as night for exactly the
 *   total.** Not a computed 98 minutes against a logged 102: if every moment of
 *   it was night then the night time IS the total time, whatever the block
 *   times rounded to.
 */
export function suggestNightMinutes(night: NightDetail, totalMinutes: number): number {
  const cap = totalMinutes > 0 ? totalMinutes : night.elapsedMinutes;
  if (!(cap > 0)) return 0;
  if (night.allNight) return cap;

  const rounded =
    Math.round(night.nightMinutes / TENTH_OF_HOUR_MINUTES) * TENTH_OF_HOUR_MINUTES;
  return Math.min(rounded, cap);
}
