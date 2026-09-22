/**
 * Mapping and presets.
 *
 * THE RULE these tests defend: what a column means is DATA, decided once and
 * visible to the pilot before anything is written. No part of the importer may
 * recognise a column by name in code.
 *
 * The sharpest case here is preset detection. RB Logbook and our own export
 * both have a column called `Date` and one called `Aircraft Type`, so anything
 * that scored formats by shared column names would confuse the two and map a
 * file with confident, authoritative-looking nonsense.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './csv';
import {
  autoMapHeaders,
  buildMapping,
  columnForRole,
  columnsForField,
  describeTarget,
  durationSamples,
  isSimulatorValue,
  mappableFields,
  normalizeHeader,
  type ColumnTarget,
  type ImportMapping,
} from './mapping';
import { detectPreset, PRESETS, RB_PRESET, OPENLOG_PRESET } from './presets';
import { FIELDS } from '../registry/fields';
import type { DurationFormat } from './units';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const RB = readFileSync(path.join(FIXTURE_DIR, 'rb-logbook.csv'), 'utf8');
const V1_CSV = readFileSync(path.join(FIXTURE_DIR, 'v1-export.csv'), 'utf8');

const MINUTES: DurationFormat = { unit: 'minutes', decimal: '.' };

function headersOf(text: string): readonly string[] {
  const result = parseCsv(text);
  if (!result.ok) throw new Error(result.rejection.message);
  return result.file.headers;
}

const RB_HEADERS = headersOf(RB);
const V1_HEADERS = headersOf(V1_CSV);

/** The target for a named column of a built mapping. */
function targetFor(mapping: ImportMapping, headers: readonly string[], name: string): ColumnTarget {
  const index = headers.indexOf(name);
  if (index < 0) throw new Error(`no column named ${name}`);
  return mapping.targets[index];
}

describe('detectPreset', () => {
  it('recognises the RB fixture as RB Logbook', () => {
    expect(detectPreset(RB_HEADERS)?.id).toBe('rb-logbook');
  });

  it('recognises our own CSV as Open Pilot Logbook', () => {
    expect(detectPreset(V1_HEADERS)?.id).toBe('open-pilot-logbook');
  });

  it('does not mistake one for the other, despite their shared column names', () => {
    // Both formats have `Date` and `Aircraft Type`. A detector scoring overlap
    // would be torn between them; a signature is not.
    expect(RB_HEADERS).toContain('Date');
    expect(V1_HEADERS).toContain('Date');
    expect(RB_HEADERS).toContain('Aircraft Type');
    expect(V1_HEADERS).toContain('Aircraft Type');

    expect(detectPreset(RB_HEADERS)?.id).not.toBe('open-pilot-logbook');
    expect(detectPreset(V1_HEADERS)?.id).not.toBe('rb-logbook');
  });

  it('claims nothing when a signature column is missing', () => {
    const missingOne = RB_HEADERS.filter((h) => h !== 'Duty Type');
    expect(detectPreset(missingOne)).toBeUndefined();
  });

  it('claims nothing for a file it has never seen', () => {
    expect(detectPreset(['Flight Date', 'From', 'To', 'Hours'])).toBeUndefined();
  });

  it('gives every preset a distinct id and a non-empty signature', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PRESETS) expect(preset.signature.length).toBeGreaterThan(0);
  });
});

describe('the RB preset', () => {
  const mapping = buildMapping(RB_HEADERS, RB_PRESET, MINUTES);
  const target = (name: string) => targetFor(mapping, RB_HEADERS, name);

  it('maps every column the format document says it does', () => {
    // One row per documented RB Logbook mapping.
    const expected: Record<string, string> = {
      Date: 'date',
      Departure: 'depAerodrome',
      Arrival: 'arrAerodrome',
      'Aircraft Type': 'aircraftType',
      Out: 'offBlock',
      In: 'onBlock',
      'Total Block': 'totalMinutes',
      PIC: 'picMinutes',
      SIC: 'coPilotMinutes',
      Night: 'nightMinutes',
      'Dual Received': 'dualMinutes',
      'Dual Given': 'instructorMinutes',
      Instructor: 'instructorMinutes',
      IFR: 'ifrMinutes',
      Simulator: 'simulatorMinutes',
      'Day Landing': 'landingsDay',
      'Night Landing': 'landingsNight',
      Remarks: 'remarks',
    };
    for (const [column, key] of Object.entries(expected)) {
      expect({ column, ...target(column) }).toEqual({ column, kind: 'field', key });
    }
  });

  it('makes Duty Type the discriminator rather than a stored field', () => {
    expect(target('Duty Type')).toEqual({ kind: 'role', role: 'entryTypeDiscriminator' });
    expect(columnForRole(mapping, 'entryTypeDiscriminator')).toBe(1);
  });

  it('makes Aircraft ID a role, because its destination depends on the row', () => {
    // Registration on a flight, device id on a session. One column, two homes.
    expect(target('Aircraft ID')).toEqual({ kind: 'role', role: 'aircraftIdentifier' });
  });

  it('IGNORES Off and On rather than mapping them to the block times', () => {
    // Airborne times, empty in every row of the real file. Mapping them
    // would write the wrong number into offBlock the day RB starts filling
    // them in — ignoring is the safe reading of a column never seen populated.
    expect(target('Off')).toEqual({ kind: 'ignore' });
    expect(target('On')).toEqual({ kind: 'ignore' });
  });

  it('sends both instructor columns to the same field', () => {
    // Dual given IS instructor time. Two columns, one field, and a merge rule
    // in `transform` — not a role, because nothing here needs one.
    const indices = columnsForField(mapping, 'instructorMinutes');
    expect(indices).toHaveLength(2);
    expect(indices.map((i) => RB_HEADERS[i])).toEqual(['Dual Given', 'Instructor']);
  });

  it('preserves the columns with no schema home, rather than dropping them', () => {
    for (const column of [
      'PICUS',
      'Actual Instrument',
      'Simulated Instrument',
      'X-Country',
      'Day Takeoff',
      'Night Takeoff',
      'Pilot Flying',
    ]) {
      expect({ column, ...target(column) }).toEqual({ column, kind: 'extra', key: column });
    }
  });

  it('never maps Pilot Flying onto a pilot function field', () => {
    // PF/PM says who was handling the aircraft, not who was in command.
    const pf = target('Pilot Flying');
    expect(pf.kind).toBe('extra');
  });

  it('sends the 80-odd columns it does not mention to extra, under their own names', () => {
    const crew = target('Crew PIC');
    expect(crew).toEqual({ kind: 'extra', key: 'Crew PIC' });
    const approach = target('Approach1');
    expect(approach).toEqual({ kind: 'extra', key: 'Approach1' });
  });

  it('treats only "1" as a simulator row', () => {
    expect(isSimulatorValue('1', mapping)).toBe(true);
    expect(isSimulatorValue('0', mapping)).toBe(false);
    expect(isSimulatorValue('', mapping)).toBe(false);
    expect(isSimulatorValue('2', mapping)).toBe(false);
  });

  it('produces a target for all 105 columns', () => {
    expect(mapping.targets).toHaveLength(105);
    expect(mapping.presetId).toBe('rb-logbook');
  });
});

describe('the Open Pilot Logbook preset', () => {
  const mapping = buildMapping(V1_HEADERS, OPENLOG_PRESET, { unit: 'decimalHours', decimal: '.' });

  it('is generated from the registry, so it cannot drift from the exporter', () => {
    // Every registry column has a target. Adding a field adds its column here
    // with no edit to the preset — the point of the registry owning names.
    for (const f of FIELDS) {
      expect(OPENLOG_PRESET.columns[f.easaColumn]).toBeDefined();
    }
  });

  it('maps a v1-era file, whose v2 and v3 columns simply do not exist', () => {
    expect(targetFor(mapping, V1_HEADERS, 'Total Time of Flight')).toEqual({
      kind: 'field',
      key: 'totalMinutes',
    });
    expect(targetFor(mapping, V1_HEADERS, 'Name PIC')).toEqual({ kind: 'field', key: 'picName' });
    // v2 columns are absent from a v1 file, and that is not an error.
    expect(V1_HEADERS).not.toContain('Pilot Function Time Dual');
    expect(V1_HEADERS).not.toContain('Entry Type');
  });

  it('makes Entry Type the discriminator, exactly as Duty Type is for RB', () => {
    expect(OPENLOG_PRESET.columns['Entry Type']).toEqual({
      kind: 'role',
      role: 'entryTypeDiscriminator',
    });
    expect(isSimulatorValue('fstd', { ...mapping, simulatorValues: ['fstd'] })).toBe(true);
    expect(isSimulatorValue('flight', { ...mapping, simulatorValues: ['fstd'] })).toBe(false);
  });
});

describe('autoMapHeaders — a file no preset claims', () => {
  it('matches an exact EASA column name', () => {
    const targets = autoMapHeaders(['Total Time of Flight', 'Aircraft Registration']);
    expect(targets[0]).toEqual({ kind: 'field', key: 'totalMinutes' });
    expect(targets[1]).toEqual({ kind: 'field', key: 'registration' });
  });

  it('matches loosely on case, spaces and punctuation', () => {
    const targets = autoMapHeaders(['total_time_of_flight', 'AIRCRAFT REGISTRATION']);
    expect(targets[0]).toEqual({ kind: 'field', key: 'totalMinutes' });
    expect(targets[1]).toEqual({ kind: 'field', key: 'registration' });
  });

  it('matches a field label or key as well as its EASA column', () => {
    expect(autoMapHeaders(['Registration'])[0]).toEqual({ kind: 'field', key: 'registration' });
    expect(autoMapHeaders(['nightMinutes'])[0]).toEqual({ kind: 'field', key: 'nightMinutes' });
  });

  it('sends anything it cannot place to extra, not to nothing', () => {
    // Landing in `extra` is a success: the value keeps its name and survives
    // into every JSON export.
    const targets = autoMapHeaders(['Fuel Burn', 'Captain Mood']);
    expect(targets[0]).toEqual({ kind: 'extra', key: 'Fuel Burn' });
    expect(targets[1]).toEqual({ kind: 'extra', key: 'Captain Mood' });
  });

  it('refuses to map a second column onto an already-claimed field', () => {
    // Two columns sharing a field is a deliberate statement a preset makes. A
    // guess on an unknown file must never decide it.
    const mapping = buildMapping(
      ['Total Time of Flight', 'Total Time of Flight'],
      undefined,
      MINUTES,
    );
    expect(mapping.targets[0]).toEqual({ kind: 'field', key: 'totalMinutes' });
    // Kept as extra — and renamed, because an extra key equal to a registry
    // column name would give CSV export two columns with the same heading.
    expect(mapping.targets[1]).toEqual({ kind: 'extra', key: 'Total Time of Flight (2)' });
  });

  it('never lets an extra key shadow a registry column name', () => {
    // If it did, CSV export would emit two columns headed "Total Time of
    // Flight" — the registry's and the extra's — and a re-import could bind
    // either one.
    const mapping = buildMapping(['Total Time of Flight', 'registration'], undefined, MINUTES);
    const keys = mapping.targets.filter((t) => t.kind === 'extra').map((t) => t.key);
    for (const key of keys) {
      expect(FIELDS.some((f) => f.easaColumn === key || f.key === key)).toBe(false);
    }
  });

  it('ignores a blank heading, since an extra key needs a name', () => {
    expect(autoMapHeaders([''])[0]).toEqual({ kind: 'ignore' });
  });

  it('never guesses entryType from a column', () => {
    // It is DECIDED by the discriminator. Letting a column fill it in would let
    // a file contradict its own row kinds.
    const targets = autoMapHeaders(['Entry Type']);
    expect(targets[0]).not.toEqual({ kind: 'field', key: 'entryType' });
    expect(mappableFields().some((f) => f.key === 'entryType')).toBe(false);
  });
});

describe('extra keys are kept distinct', () => {
  it('suffixes a repeated extra key rather than writing one over the other', () => {
    const mapping = buildMapping(['Notes', 'Notes', 'Notes'], undefined, MINUTES);
    expect(mapping.targets).toEqual([
      { kind: 'extra', key: 'Notes' },
      { kind: 'extra', key: 'Notes (2)' },
      { kind: 'extra', key: 'Notes (3)' },
    ]);
  });
});

describe('buildMapping without a preset', () => {
  it('falls back to guessing and carries the default simulator values', () => {
    const mapping = buildMapping(['Date', 'Mystery'], undefined, MINUTES);
    expect(mapping.presetId).toBeUndefined();
    expect(mapping.targets[0]).toEqual({ kind: 'field', key: 'date' });
    expect(mapping.simulatorValues).toContain('1');
  });

  it('treats an unrecognised discriminator value as a flight, never as a session', () => {
    // Defaulting the other way would turn an unfamiliar value into a record
    // with no flight time, silently removing hours from the logbook.
    const mapping = buildMapping(['X'], undefined, MINUTES);
    expect(isSimulatorValue('whatever', mapping)).toBe(false);
    expect(isSimulatorValue('sim', mapping)).toBe(true);
  });
});

describe('durationSamples — where the unit sniff gets its evidence', () => {
  it('samples ONLY the columns mapped to a duration field', () => {
    // The defect this exists to prevent: `Departure Time` holds "08:00", which
    // looks exactly like an hh:mm DURATION. Sampling by header name pulls it in,
    // the file is judged to be in hh:mm, and our own export's "1.2" decimal
    // hours then parses as 1 minute instead of 72. Sampling by MAPPING cannot
    // make that mistake, because `offBlock` is a timeOfDay field, not a duration.
    const file = parseCsv(V1_CSV);
    if (!file.ok) throw new Error('fixture did not parse');
    const mapping = buildMapping(V1_HEADERS, OPENLOG_PRESET, MINUTES);
    const samples = durationSamples(file.file.rows, mapping);

    expect(samples).not.toContain('08:00');
    expect(samples).not.toContain('21:30');
    expect(samples).toContain('1.2');
  });

  it('skips empty cells, which say nothing about the unit', () => {
    const file = parseCsv('Total Time of Flight\r\n\r\n2.3\r\n');
    if (!file.ok) throw new Error('did not parse');
    const mapping = buildMapping(file.file.headers, undefined, MINUTES);
    expect(durationSamples(file.file.rows, mapping)).toEqual(['2.3']);
  });

  it('gathers from every duration column, not just the first', () => {
    const file = parseCsv('Total Time of Flight,Operational Condition Time Night\r\n2.3,0.5\r\n');
    if (!file.ok) throw new Error('did not parse');
    const mapping = buildMapping(file.file.headers, undefined, MINUTES);
    expect(durationSamples(file.file.rows, mapping)).toEqual(['2.3', '0.5']);
  });
});

describe('helpers', () => {
  it('normalizes a header for loose comparison', () => {
    expect(normalizeHeader('Total Time of Flight')).toBe('totaltimeofflight');
    expect(normalizeHeader('X-Country')).toBe('xcountry');
    expect(normalizeHeader('  ')).toBe('');
  });

  it('describes every kind of target in words', () => {
    // The registry's label, so the mapping UI and the entry form use one word
    // for one field rather than inventing a second name for it here.
    expect(describeTarget({ kind: 'field', key: 'totalMinutes' })).toBe('Total');
    expect(describeTarget({ kind: 'role', role: 'entryTypeDiscriminator' })).toMatch(/simulator/i);
    expect(describeTarget({ kind: 'extra', key: 'Fuel' })).toMatch(/Fuel/);
    expect(describeTarget({ kind: 'ignore' })).toBe('Ignore');
  });

  it('returns -1 for a role no column carries', () => {
    const mapping = buildMapping(['Date'], undefined, MINUTES);
    expect(columnForRole(mapping, 'aircraftIdentifier')).toBe(-1);
  });

  it('offers every applicable registry field as a mapping target', () => {
    const keys = mappableFields().map((f) => f.key);
    expect(keys).toContain('totalMinutes');
    expect(keys).toContain('simulatorMinutes');
    expect(keys).toContain('registration');
    expect(keys).not.toContain('entryType');
  });
});
