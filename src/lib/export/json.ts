/**
 * JSON export — the canonical, lossless backup format.
 *
 * Whole `Flight` records, `extra` and `schemaVersion` included, nothing
 * stripped or reformatted. Durations stay as INTEGER MINUTES: this file is for
 * machines, and the decimal-hours presentation belongs to CSV and the UI.
 *
 * PURE: records in, string out. No DOM, no storage, no settings, no clock —
 * `exportedAt` and `appVersion` are supplied by the caller.
 */
import {
  EXPORT_FORMAT_ID,
  EXPORT_FORMAT_VERSION,
  type ExportBundle,
  type ExportEnvelope,
  type JsonExportOptions,
} from './types';
import { CURRENT_SCHEMA_VERSION } from '../domain/flight';
import { isEmptyOpeningBalance, sanitizeOpeningBalance } from '../domain/openingBalance';
import { orderAircraft, orderFlight, sortAircraft, sortFlights } from './order';

/**
 * Build the export envelope as a plain object (useful for assertions and for
 * the Phase 3b importer's tests). `serializeJson` is the on-disk form.
 */
export function buildEnvelope(bundle: ExportBundle, options: JsonExportOptions): ExportEnvelope {
  const flights = sortFlights(bundle.flights).map(orderFlight);
  const aircraft = sortAircraft(bundle.aircraft).map(orderAircraft);

  const envelope: ExportEnvelope = {
    format: EXPORT_FORMAT_ID,
    formatVersion: EXPORT_FORMAT_VERSION,
    // The records inside carry their own version; this is the writer's.
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: options.appVersion,
    exportedAt: options.exportedAt,
    flightCount: flights.length,
    flights,
    aircraft,
  };

  /*
    OMITTED WHEN EMPTY, and that is the whole design.

    A logbook with nothing carried forward writes exactly the bytes it wrote
    before this key existed, so the permanent export fixtures are untouched and
    `formatVersion` stays 1 — an additive key that is absent by default is not
    a new envelope. Sanitized first, because the balance is the one part of the
    bundle that can have arrived from a file.

    Appended AFTER `aircraft` for the same reason our own columns are appended
    after the EASA set in the registry: anything reading the file finds the keys
    it expects, where it expects them, and can ignore the tail.
  */
  const balance = sanitizeOpeningBalance(bundle.openingBalance);
  if (!isEmptyOpeningBalance(balance)) {
    envelope.openingBalance = { ...balance };
  }

  return envelope;
}

/**
 * Serialize the envelope. Indented two spaces and newline-terminated so the
 * file reads sensibly to a human who opens it to check their backup is real.
 */
export function serializeJson(bundle: ExportBundle, options: JsonExportOptions): string {
  return `${JSON.stringify(buildEnvelope(bundle, options), null, 2)}\n`;
}
