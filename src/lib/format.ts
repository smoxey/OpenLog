/**
 * Shared display + parse helpers so no component does inline duration math.
 * Everything funnels through the pure conversions in `./time/duration`.
 */
import {
  minutesToDecimal,
  minutesToHhmm,
  decimalToMinutes,
  hhmmToMinutes,
} from './time/duration';
import { formatTimeOfDay, type ClockDisplay } from './time/timeOfDay';
import type { FieldDefinition } from './registry/types';
import type { Flight } from './domain/flight';

export type DurationDisplay = 'decimal' | 'hhmm';

/** Format integer minutes for display, per the user's chosen setting. */
export function formatDuration(minutes: number, mode: DurationDisplay): string {
  return mode === 'hhmm' ? minutesToHhmm(minutes) : minutesToDecimal(minutes);
}

/**
 * Parse duration input text into integer minutes.
 * Returns `null` for invalid input so callers can show an inline error without
 * discarding what the user typed. Empty input is treated as 0 (valid).
 *
 * Decimal mode accepts "1.5", "1,5" and bare "2" (-> 2.0).
 * hh:mm mode accepts "1:25".
 */
export function parseDurationInput(text: string, mode: DurationDisplay): number | null {
  const t = text.trim();
  if (t === '') return 0;

  if (mode === 'hhmm') {
    const minutes = hhmmToMinutes(t);
    return Number.isNaN(minutes) ? null : minutes;
  }

  const normalized = t.replace(',', '.');
  if (normalized === '.' || !/^\d*\.?\d*$/.test(normalized)) return null;
  const hours = Number(normalized);
  if (!Number.isFinite(hours) || hours < 0) return null;
  return decimalToMinutes(hours);
}

/** Read a field's value off a flight, honoring core vs extra storage. */
export function readFieldValue(flight: Flight, field: FieldDefinition): unknown {
  if (field.storage === 'extra') return flight.extra?.[field.key];
  return (flight as unknown as Record<string, unknown>)[field.key];
}

/**
 * Format a single flight field for a list/table cell, per the display settings.
 *
 * `clock` defaults to the 24-hour clock rather than being required, because
 * that is what every record actually holds: a caller that has no opinion gets
 * the stored value back unchanged.
 */
export function formatCell(
  flight: Flight,
  field: FieldDefinition,
  mode: DurationDisplay,
  clock: ClockDisplay = '24h',
): string {
  const raw = readFieldValue(flight, field);
  switch (field.type) {
    case 'durationMinutes':
      return formatDuration(typeof raw === 'number' ? raw : 0, mode);
    case 'count':
      return String(typeof raw === 'number' ? raw : 0);
    case 'timeOfDay':
      return formatTimeOfDay(typeof raw === 'string' ? raw : '', clock);
    default:
      return raw == null ? '' : String(raw);
  }
}
