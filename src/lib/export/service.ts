/**
 * Export orchestration: read the database, call a pure serializer, deliver the
 * file, and record the backup only if it actually landed.
 *
 * This is the layer allowed to touch storage and settings. The serializers it
 * calls are pure — it reads the spreadsheet format here and passes it in, so
 * `csv.ts` never has to know a settings module exists.
 *
 * Dependencies are injectable so the delivery route and the clock can be
 * stubbed in tests without a DOM.
 */
import { listFlights, getAllAircraft, getSettings, updateSettings } from '../storage';
import { serializeJson } from './json';
import { serializeCsv } from './csv';
import { exportFilename, EXPORT_MIME } from './filename';
import { deliverExport, makeExportFile, type DeliveryMode, type DeliveryResult } from './share';
import type { ExportBundle, ExportKind, ExportWarning } from './types';

export interface ExportOutcome {
  ok: boolean;
  kind: ExportKind;
  filename: string;
  route: 'share' | 'download';
  cancelled: boolean;
  /** Columns CSV could not represent. Always empty for JSON. */
  warnings: ExportWarning[];
  /** Written only on success — mirrors what was persisted. */
  backedUpAt: string | null;
  error?: string;
}

export interface ExportDeps {
  loadBundle: () => Promise<ExportBundle>;
  deliver: (file: File, mode: DeliveryMode) => Promise<DeliveryResult>;
  now: () => Date;
  appVersion: string;
}

/** App version, injected at build time by Vite. See vite.config.ts. */
declare const __APP_VERSION__: string;

function defaultDeps(): ExportDeps {
  return {
    loadBundle: async () => {
      const [flights, aircraft, settings] = await Promise.all([
        listFlights(),
        getAllAircraft(),
        getSettings(),
      ]);
      return { flights, aircraft, openingBalance: settings.openingBalance };
    },
    deliver: deliverExport,
    now: () => new Date(),
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0',
  };
}

/**
 * Run an export end to end.
 *
 * `lastBackupAt` is written ONLY when delivery reports success. A cancelled
 * share sheet and a failed download both leave the stored timestamp untouched,
 * so the reminder keeps asking until a backup really happens.
 */
export async function exportLogbook(
  kind: ExportKind,
  mode: DeliveryMode = 'auto',
  overrides: Partial<ExportDeps> = {},
): Promise<ExportOutcome> {
  const deps = { ...defaultDeps(), ...overrides };
  const now = deps.now();
  const filename = exportFilename(kind, now);

  try {
    const bundle = await deps.loadBundle();

    let contents: string;
    let warnings: ExportWarning[] = [];
    if (kind === 'json') {
      contents = serializeJson(bundle, {
        appVersion: deps.appVersion,
        exportedAt: now.toISOString(),
      });
    } else {
      // Read the format here and hand it to the pure serializer.
      const { spreadsheetFormat } = await getSettings();
      const result = serializeCsv(bundle, { spreadsheetFormat });
      contents = result.csv;
      warnings = result.warnings;
    }

    const file = makeExportFile(contents, filename, EXPORT_MIME[kind]);
    const delivery = await deps.deliver(file, mode);

    if (!delivery.ok) {
      return {
        ok: false,
        kind,
        filename,
        route: delivery.route,
        cancelled: delivery.cancelled,
        warnings,
        backedUpAt: null,
        error: delivery.error,
      };
    }

    const backedUpAt = now.toISOString();
    await updateSettings({ lastBackupAt: backedUpAt, lastBackupFormat: kind });

    return {
      ok: true,
      kind,
      filename,
      route: delivery.route,
      cancelled: false,
      warnings,
      backedUpAt,
    };
  } catch (error) {
    return {
      ok: false,
      kind,
      filename,
      route: 'download',
      cancelled: false,
      warnings: [],
      backedUpAt: null,
      error: error instanceof Error ? error.message : 'Export failed.',
    };
  }
}
