/**
 * The aircraft step — asking the pilot the fewest questions that will do.
 *
 * The naive shape is one question per registration. Measured against the real
 * RB export that is **78 questions** — and pointless ones, because those 78
 * registrations carry only THREE type designators between them. A pilot asked
 * whether OY-XXA is multi-pilot, and then asked the same about 40 more A320s,
 * will stop reading and start clicking.
 *
 * So the questions are grouped BY TYPE:
 *
 *   - one row per type designator: single- or multi-engine, and multi-pilot.
 *     A handful of answers cover almost all of a real file's rows.
 *   - one row per registration the file gives NO type for: the pilot supplies a
 *     designator. A real file had a handful of these,
 *     and none of them appear with a type anywhere else, so there is nothing to
 *     infer them from.
 *
 * Eleven answers instead of seventy-eight, for exactly the same result: one
 * aircraft record per registration, which is what the aircraft store holds and
 * what `deriveAircraftTimes` reads.
 *
 * PURE: no storage, no settings, no clock. The fallback class arrives from the
 * caller, as everywhere else.
 */
import { normalizeAircraft, type Aircraft, type AircraftClass } from '../domain/aircraft';
import type { AircraftNeed } from './transform';

/** The registrations sharing one type designator. */
export interface AircraftTypeGroup {
  /** The designator, or `''` for the group that has none. */
  type: string;
  registrations: string[];
  /** How many flight rows this group accounts for. */
  rowCount: number;
}

/** What the pilot decided about a type. */
export interface TypeProfile {
  class: AircraftClass;
  multiPilot: boolean;
}

export interface AircraftAnswers {
  /** Type designator -> what it is. */
  byType: Record<string, TypeProfile>;
  /** Registration -> the designator the pilot supplied, for rows the file left blank. */
  typeByRegistration: Record<string, string>;
}

/**
 * Group the file's aircraft by type designator.
 *
 * A registration seen with more than one designator lands under the first, and
 * the others still appear — a file that disagrees with itself about an aircraft
 * is a thing the pilot should see rather than a thing to silently resolve.
 * The untyped group, if any, always sorts LAST: it is the one that needs work,
 * and burying it between two finished rows would hide it.
 */
export function groupAircraftByType(needs: readonly AircraftNeed[]): AircraftTypeGroup[] {
  const groups = new Map<string, AircraftTypeGroup>();

  for (const need of needs) {
    const type = need.typesSeen[0] ?? '';
    const group = groups.get(type) ?? { type, registrations: [], rowCount: 0 };
    if (!group.registrations.includes(need.registration)) group.registrations.push(need.registration);
    group.rowCount += need.rowCount;
    groups.set(type, group);
  }

  return [...groups.values()].sort((a, b) => {
    if (a.type === '') return 1;
    if (b.type === '') return -1;
    return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
  });
}

/**
 * Designators that look like transport-category aircraft.
 *
 * A PREFILL FOR A CHECKBOX THE PILOT CONFIRMS — never a rule, and never applied
 * without being shown. The actual import rule is about `multiPilot` on the
 * aircraft record, which is why `transform.ts` contains no type strings at all
 * and has a test forbidding them. This lives up here in the answering step, on
 * the correct side of that line: it saves three ticks on a screen the pilot is
 * already reading, and it is wrong harmlessly, because a wrong suggestion is
 * visible and one click from being right.
 */
const TRANSPORT_TYPE = /^(A2\d|A3\d|A(19|22|31|32|33|34|35|38)|B7\d|E1\d|E2\d|E(70|75|90|95)|CRJ|AT[47]|DH8|MD8|SF3|RJ\d)/i;

/**
 * A starting suggestion for a type the pilot has not answered yet.
 *
 * `fallbackClass` is the `defaultAircraftClass` setting, read by the caller —
 * the same value the entry form uses when a registration is unknown, so the
 * import and the form guess alike.
 */
export function suggestTypeProfile(type: string, fallbackClass: AircraftClass): TypeProfile {
  const designator = type.trim().toUpperCase();
  if (TRANSPORT_TYPE.test(designator)) return { class: 'ME', multiPilot: true };
  // A single-engine piston designator is usually a C-, PA-, DA- or similar. Rather
  // than build a second list, fall back to the pilot's own default class and
  // assume single-pilot, which is the commoner case for everything else.
  if (/^(C1|C2|PA|DA|SR2|AA5|BE2|G11|P28|DR4)/i.test(designator)) {
    return { class: 'SE', multiPilot: false };
  }
  return { class: fallbackClass, multiPilot: false };
}

/**
 * Seed the answer sheet: what is already known, then what is suggested.
 *
 * An aircraft ALREADY in the store answers for its own type, because the pilot
 * has confirmed it before and re-asking would be rude. Otherwise a suggestion.
 */
export function seedAnswers(
  groups: readonly AircraftTypeGroup[],
  known: readonly Aircraft[],
  fallbackClass: AircraftClass,
): AircraftAnswers {
  const knownByRegistration = new Map(known.map((a) => [a.registration, a]));
  const byType: Record<string, TypeProfile> = {};

  for (const group of groups) {
    if (group.type === '') continue;

    const confirmed = group.registrations
      .map((registration) => knownByRegistration.get(registration))
      .find((aircraft) => aircraft?.type.toUpperCase() === group.type.toUpperCase());

    byType[group.type] = confirmed
      ? { class: confirmed.class, multiPilot: confirmed.multiPilot }
      : suggestTypeProfile(group.type, fallbackClass);
  }

  // Registrations the file gave no type for. Prefilled from the store when the
  // pilot has met this aircraft before, so a second import asks nothing.
  const typeByRegistration: Record<string, string> = {};
  const untyped = groups.find((group) => group.type === '');
  for (const registration of untyped?.registrations ?? []) {
    typeByRegistration[registration] = knownByRegistration.get(registration)?.type ?? '';
  }

  return { byType, typeByRegistration };
}

/**
 * Turn the answers into one aircraft record per registration.
 *
 * A registration whose type is still blank is LEFT OUT rather than written with
 * an empty type. Its rows will report `missing-aircraft` and be held back,
 * which is the correct outcome: an aircraft with no type is not an answer, and
 * writing one would put a permanently useless record in the store.
 */
export function resolveAircraft(
  needs: readonly AircraftNeed[],
  answers: AircraftAnswers,
  fallbackClass: AircraftClass,
): Aircraft[] {
  const resolved: Aircraft[] = [];

  for (const need of needs) {
    const type = (need.typesSeen[0] ?? answers.typeByRegistration[need.registration] ?? '').trim();
    if (!type) continue;

    const profile = answers.byType[type] ?? suggestTypeProfile(type, fallbackClass);
    resolved.push(
      normalizeAircraft({
        registration: need.registration,
        type,
        class: profile.class,
        multiPilot: profile.multiPilot,
      }),
    );
  }

  return resolved;
}

/** How many answers are still missing — a type the pilot has not supplied. */
export function unansweredCount(groups: readonly AircraftTypeGroup[], answers: AircraftAnswers): number {
  const untyped = groups.find((group) => group.type === '');
  if (!untyped) return 0;
  return untyped.registrations.filter(
    (registration) => !(answers.typeByRegistration[registration] ?? '').trim(),
  ).length;
}
