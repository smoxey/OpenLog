import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { serializeCsv } from './csv';
import { SPREADSHEET_PROFILES, type SpreadsheetFormat } from './types';
import { FIELDS } from '../registry/fields';
import { SAMPLE_FLIGHTS, SAMPLE_AIRCRAFT } from './fixtures/sample-logbook';
import type { Flight } from '../domain/flight';

const BUNDLE = { flights: SAMPLE_FLIGHTS, aircraft: SAMPLE_AIRCRAFT };
const BOM = '﻿';

/** See json.test.ts — `import.meta.url` is unreliable here on Windows. */
const FIXTURE_DIR = path.resolve(process.cwd(), 'src/lib/export/fixtures');

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

function csvFor(format: SpreadsheetFormat) {
  return serializeCsv(BUNDLE, { spreadsheetFormat: format });
}

/** Parse back with the matching delimiter so assertions run on cells, not text. */
function parseRows(csv: string, format: SpreadsheetFormat): string[][] {
  const { delimiter } = SPREADSHEET_PROFILES[format];
  const result = Papa.parse<string[]>(csv.replace(BOM, ''), {
    delimiter,
    newline: '\r\n',
    skipEmptyLines: true,
  });
  return result.data;
}

function flightWith(overrides: Partial<Flight>): Flight {
  return { ...SAMPLE_FLIGHTS[1], ...overrides };
}

describe('columns come from the registry', () => {
  it('header matches the registry easaColumn order exactly', () => {
    const [header] = parseRows(csvFor('standard').csv, 'standard');
    const registryColumns = FIELDS.map((f) => f.easaColumn);
    // Assert against the registry, never a hardcoded string: adding a field
    // must not be able to break this silently.
    expect(header.slice(0, registryColumns.length)).toEqual(registryColumns);
  });

  it('appends extra columns after the registry columns, alphabetically', () => {
    const [header] = parseRows(csvFor('standard').csv, 'standard');
    const tail = header.slice(FIELDS.length);
    expect(tail).toEqual(['approaches', 'customTag', 'instructor', 'selfBriefed']);
    expect([...tail].sort()).toEqual(tail);
  });

  it('gives flights lacking an extra key an empty cell', () => {
    const rows = parseRows(csvFor('standard').csv, 'standard');
    const header = rows[0];
    const aborted = rows.find((r) => r[header.indexOf('Aircraft Registration')] === 'N0123')!;
    expect(aborted[header.indexOf('approaches')]).toBe('');
    expect(aborted[header.indexOf('selfBriefed')]).toBe('');
  });
});

describe('non-scalar extra values', () => {
  it('omits the column and reports a warning instead of stringifying it', () => {
    const { csv, warnings } = csvFor('standard');
    const [header] = parseRows(csv, 'standard');

    expect(header).not.toContain('crew');
    expect(header).not.toContain('waypoints');
    expect(warnings.map((w) => w.key).sort()).toEqual(['crew', 'waypoints']);
    // Nothing resembling a serialized object leaked into the file.
    expect(csv).not.toContain('[object Object]');
    expect(csv).not.toContain('A. Nordmann');
  });

  it('keeps flat scalars — string, number, boolean, null', () => {
    const flight = flightWith({
      extra: { s: 'text', n: 42, bTrue: true, bFalse: false, nil: null },
    });
    const { csv, warnings } = serializeCsv({ flights: [flight], aircraft: [] }, {
      spreadsheetFormat: 'standard',
    });
    const rows = parseRows(csv, 'standard');
    const [header, row] = rows;
    expect(warnings).toEqual([]);
    expect(row[header.indexOf('s')]).toBe('text');
    expect(row[header.indexOf('n')]).toBe('42');
    expect(row[header.indexOf('bTrue')]).toBe('true');
    expect(row[header.indexOf('bFalse')]).toBe('false');
    expect(row[header.indexOf('nil')]).toBe('');
  });
});

describe('spreadsheet format bundle', () => {
  it.each(['standard', 'european'] as const)('%s starts with a BOM', (format) => {
    expect(csvFor(format).csv.startsWith(BOM)).toBe(true);
  });

  it('standard uses a comma delimiter and a dot decimal', () => {
    const { csv } = csvFor('standard');
    const firstLine = csv.replace(BOM, '').split('\r\n')[0];
    expect(firstLine).toContain('Date,Departure Place');
    expect(csv).toContain(',2.3,');
  });

  it('european uses a semicolon delimiter and a comma decimal', () => {
    const { csv } = csvFor('european');
    const firstLine = csv.replace(BOM, '').split('\r\n')[0];
    expect(firstLine).toContain('Date;Departure Place');
    expect(csv).toContain(';2,3;');
  });

  it('138 minutes exports as 2.3 standard and 2,3 european', () => {
    const flight = flightWith({ totalMinutes: 138 });
    const bundle = { flights: [flight], aircraft: [] };
    const totalIndex = FIELDS.findIndex((f) => f.key === 'totalMinutes');

    const std = parseRows(serializeCsv(bundle, { spreadsheetFormat: 'standard' }).csv, 'standard');
    const eur = parseRows(serializeCsv(bundle, { spreadsheetFormat: 'european' }).csv, 'european');
    expect(std[1][totalIndex]).toBe('2.3');
    expect(eur[1][totalIndex]).toBe('2,3');
  });

  it('exports decimal hours regardless of the display setting — no setting is read', () => {
    // serializeCsv takes no display mode at all; this asserts the shape of the
    // API, which is what makes the guarantee structural rather than incidental.
    const zero = flightWith({ totalMinutes: 0 });
    const rows = parseRows(
      serializeCsv({ flights: [zero], aircraft: [] }, { spreadsheetFormat: 'standard' }).csv,
      'standard',
    );
    expect(rows[1][FIELDS.findIndex((f) => f.key === 'totalMinutes')]).toBe('0.0');
  });
});

describe('escaping', () => {
  it.each(['standard', 'european'] as const)(
    '%s survives commas, semicolons, quotes, newlines and non-ASCII in remarks',
    (format) => {
      const nasty =
        'comma, semicolon; "quoted" and \'apostrophe\'\nsecond line\ttab — æøå ÄÖÜ 日本語';
      const flight = flightWith({ remarks: nasty });
      const { csv } = serializeCsv({ flights: [flight], aircraft: [] }, {
        spreadsheetFormat: format,
      });
      const rows = parseRows(csv, format);
      const remarksIndex = FIELDS.findIndex((f) => f.key === 'remarks');
      expect(rows[1][remarksIndex]).toBe(nasty);
    },
  );

  it.each(['standard', 'european'] as const)(
    '%s survives a remarks value containing the active delimiter',
    (format) => {
      const { delimiter } = SPREADSHEET_PROFILES[format];
      const remarks = `before${delimiter}after${delimiter}end`;
      const flight = flightWith({ remarks });
      const { csv } = serializeCsv({ flights: [flight], aircraft: [] }, {
        spreadsheetFormat: format,
      });
      const rows = parseRows(csv, format);
      expect(rows[1][FIELDS.findIndex((f) => f.key === 'remarks')]).toBe(remarks);
      // The column count must not have grown — the delimiter stayed escaped.
      expect(rows[1]).toHaveLength(rows[0].length);
    },
  );

  it('round-trips the embedded newline in the sample fixture', () => {
    const rows = parseRows(csvFor('standard').csv, 'standard');
    const remarksIndex = FIELDS.findIndex((f) => f.key === 'remarks');
    const nightRow = rows.find((r) => r[remarksIndex]?.includes('Night xc'))!;
    expect(nightRow[remarksIndex]).toContain('\n');
    expect(nightRow[remarksIndex]).toContain('Ålesund');
  });
});

describe('determinism and edge cases', () => {
  it.each(['standard', 'european'] as const)('%s is byte-stable across two exports', (format) => {
    expect(csvFor(format).csv).toBe(csvFor(format).csv);
  });

  it('an empty logbook produces headers and no data rows, and does not throw', () => {
    const { csv, warnings } = serializeCsv({ flights: [], aircraft: [] }, {
      spreadsheetFormat: 'standard',
    });
    const rows = parseRows(csv, 'standard');
    expect(warnings).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(FIELDS.map((f) => f.easaColumn));
    expect(csv.startsWith(BOM)).toBe(true);
  });

  it('keeps a leading-zero registration as text in the file', () => {
    // Excel may still coerce it on open — that is Excel, not the file. The
    // bytes we write are correct.
    const rows = parseRows(csvFor('standard').csv, 'standard');
    const regIndex = FIELDS.findIndex((f) => f.key === 'registration');
    expect(rows.some((r) => r[regIndex] === 'N0123')).toBe(true);
  });

  it('matches the committed sample fixtures byte for byte', () => {
    expect(csvFor('standard').csv).toBe(fixture('sample-export.standard.csv'));
    expect(csvFor('european').csv).toBe(fixture('sample-export.european.csv'));
  });
});
