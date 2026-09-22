/**
 * Regenerate the byte-exact export fixtures.
 *
 * The files in `src/lib/export/fixtures/` are the committed expectation for what
 * an export looks like on disk, down to the byte — BOM, line endings and column
 * order included. They encode the record schema, so a schema change necessarily
 * changes them.
 *
 * This exists so regeneration is a deliberate, reviewable act rather than
 * someone hand-editing a fixture until a test goes green.
 *
 *   npm run fixtures:regenerate
 *
 * Then READ THE DIFF before committing. If it contains anything you did not
 * intend, the exporter changed behaviour and that is a finding — not a licence
 * to keep the new output.
 *
 * It is written as a vitest spec because vitest is the only TypeScript runner
 * this project has, and adding one would mean a new dependency. It lives in
 * `scripts/` and ends in `.spec.ts`, which the default test glob
 * (`src/ * * / *.{test,spec}.ts`) deliberately does not match, so an ordinary
 * `npm test` never runs it.
 */
import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { serializeJson } from '../src/lib/export/json';
import { serializeCsv } from '../src/lib/export/csv';
import {
  SAMPLE_AIRCRAFT,
  SAMPLE_APP_VERSION,
  SAMPLE_EXPORTED_AT,
  SAMPLE_FLIGHTS,
} from '../src/lib/export/fixtures/sample-logbook';

const FIXTURE_DIR = path.resolve(process.cwd(), 'src/lib/export/fixtures');
const BUNDLE = { flights: SAMPLE_FLIGHTS, aircraft: SAMPLE_AIRCRAFT };

function write(name: string, contents: string): void {
  // Binary write: the fixtures are byte-exact and must not be touched by any
  // newline translation on the way out.
  writeFileSync(path.join(FIXTURE_DIR, name), Buffer.from(contents, 'utf8'));
  console.log(`  wrote ${name} (${Buffer.byteLength(contents, 'utf8')} bytes)`);
}

describe('regenerate export fixtures', () => {
  it('writes the JSON fixture', () => {
    write(
      'sample-export.json',
      serializeJson(BUNDLE, {
        exportedAt: SAMPLE_EXPORTED_AT,
        appVersion: SAMPLE_APP_VERSION,
      }),
    );
  });

  it('writes both CSV fixtures', () => {
    for (const format of ['standard', 'european'] as const) {
      const { csv, warnings } = serializeCsv(BUNDLE, { spreadsheetFormat: format });
      write(`sample-export.${format}.csv`, csv);
      for (const w of warnings) console.log(`    ${format} warning: ${w}`);
    }
  });
});
