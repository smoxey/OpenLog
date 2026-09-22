/**
 * Export filenames. Pure — the caller supplies the date.
 *
 * `open-pilot-logbook-YYYY-MM-DD.json` / `.csv`. Local date, not UTC: the file
 * lands in the user's Files app next to other things they saved "today", and a
 * UTC date would read as wrong to anyone west of Greenwich in the evening.
 */
import type { ExportKind } from './types';

export const EXPORT_FILENAME_STEM = 'open-pilot-logbook';

/** MIME types used for both the download blob and the Web Share file. */
export const EXPORT_MIME: Record<ExportKind, string> = {
  json: 'application/json',
  csv: 'text/csv',
};

function localDateStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function exportFilename(kind: ExportKind, date: Date): string {
  return `${EXPORT_FILENAME_STEM}-${localDateStamp(date)}.${kind}`;
}
