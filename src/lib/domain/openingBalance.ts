/**
 * The opening balance — hours flown before this logbook began.
 *
 * Any pilot who does not start from zero needs their previous total carried
 * forward, or every figure the app shows is wrong.
 *
 * IT IS A SETTING, NOT A FLIGHT. The alternative — one synthetic "previous
 * logbook" record holding the brought-forward times — would have made every
 * total pick it up for free, and was rejected: a brought-forward figure has no
 * date, no aircraft, no route and no landings on any particular day, so a
 * record holding one is a lie that then appears in the list, in every export,
 * in the CSV another app reads, and in the conflict checker.
 *
 * THE RULE THAT MATTERS: an opening balance applies to the ALL-TIME totals and
 * to nothing else. Never to a date range, never to a per-type or
 * per-registration breakdown, never to currency. There is no honest answer to
 * "how much of my brought-forward time was in the last 90 days, in a PA28",
 * so the app never pretends there is one.
 *
 * That rule is enforced by the shape of the code rather than by discipline:
 * `domain/totals` knows nothing about this module, and `applyOpeningBalance` is
 * the only thing that can add a balance to anything.
 *
 * PURE. No storage, no settings module, no clock.
 */
import { SUMMABLE_FIELDS } from '../registry/fields';
import type { TotalsSet } from './totals';

/** Brought-forward figures, keyed by registry field key. Same units as records. */
export type OpeningBalance = Readonly<Record<string, number>>;

/** Nothing carried forward. The default, and the behaviour the app had before. */
export const EMPTY_OPENING_BALANCE: OpeningBalance = Object.freeze({});

/**
 * The only field keys an opening balance may carry.
 *
 * Driven by `summable`, so it is the same set every total is built from. Note
 * what this excludes without a special case: `simulatorMinutes` is not
 * summable, so there is no such thing as a brought-forward simulator balance —
 * consistent with simulator time never being flight time.
 */
export function openingBalanceKeys(): string[] {
  return SUMMABLE_FIELDS.map((f) => f.key);
}

function isAllowedKey(key: string): boolean {
  return SUMMABLE_FIELDS.some((f) => f.key === key);
}

/** A brought-forward figure must be a whole, non-negative number. */
function isUsableValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Read a stored balance leniently: keep what is usable, drop what is not.
 *
 * Used on the way OUT of settings, where the alternative to dropping an
 * unrecognised key is trusting it. A key that is not a summable field cannot be
 * added to any total without inventing a column, and a negative or fractional
 * value is not a number of minutes.
 *
 * Zero-valued entries are dropped too, so an empty balance has exactly one
 * representation and `isEmptyOpeningBalance` cannot disagree with itself.
 */
export function sanitizeOpeningBalance(raw: unknown): OpeningBalance {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_OPENING_BALANCE;
  const balance: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAllowedKey(key)) continue;
    if (!isUsableValue(value)) continue;
    if (value === 0) continue;
    balance[key] = value;
  }
  return balance;
}

/**
 * Read a balance out of a backup file STRICTLY: anything wrong is reported
 * rather than dropped.
 *
 * Different rules from `sanitizeOpeningBalance` on purpose. Silently discarding
 * part of a damaged backup is the behaviour restore refuses everywhere else —
 * a truncated restore that reports success is the worst outcome available — so
 * a damaged balance is a reason to refuse the whole file, exactly like a
 * damaged aircraft list.
 *
 * An ABSENT key is not damage: it means the logbook that wrote the file had no
 * opening balance, or was written before this key existed.
 */
export function readOpeningBalance(
  raw: unknown,
): { balance: OpeningBalance | null } | { errors: string[] } {
  if (raw === undefined || raw === null) return { balance: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['"openingBalance" is present but is not a set of figures.'] };
  }

  const errors: string[] = [];
  const balance: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAllowedKey(key)) {
      errors.push(`Unknown opening balance column: "${key}".`);
      continue;
    }
    if (!isUsableValue(value)) {
      errors.push(`Opening balance for "${key}" is not a whole non-negative number.`);
      continue;
    }
    if (value !== 0) balance[key] = value;
  }

  return errors.length > 0 ? { errors } : { balance };
}

/** Whether anything is actually carried forward. */
export function isEmptyOpeningBalance(balance: OpeningBalance | null | undefined): boolean {
  if (!balance) return true;
  return Object.values(balance).every((v) => v === 0);
}

/**
 * Add a brought-forward balance to a totals set.
 *
 * Returns a NEW object; the input is never mutated. Only ever called with the
 * ALL-TIME totals — see the rule at the top of this file.
 */
export function applyOpeningBalance(totals: TotalsSet, balance: OpeningBalance): TotalsSet {
  const combined: TotalsSet = { ...totals };
  for (const [key, value] of Object.entries(balance)) {
    if (!isAllowedKey(key) || !isUsableValue(value)) continue;
    combined[key] = (combined[key] ?? 0) + value;
  }
  return combined;
}
