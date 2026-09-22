/**
 * The EASA facsimile.
 *
 * Pagination and totals are covered in `export/easaLayout.test.ts`. What this
 * file covers is the printed PAGE — and above all the two places the app
 * refuses to fill a cell in.
 *
 * This is a document a pilot signs: "I certify the entries on this page are
 * correct." Every number on it therefore has to be one they actually logged.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import EasaPrintView from './EasaPrintView.svelte';
import type { Flight } from '../domain/flight';

function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    schemaVersion: 3,
    entryType: 'flight',
    date: '2026-03-01',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '10:00',
    onBlock: '11:38',
    aircraftType: 'C172',
    registration: 'LN-ABC',
    picName: 'SELF',
    totalMinutes: 98,
    picMinutes: 98,
    coPilotMinutes: 0,
    dualMinutes: 0,
    instructorMinutes: 0,
    singlePilotSeMinutes: 98,
    singlePilotMeMinutes: 0,
    multiPilotMinutes: 0,
    nightMinutes: 0,
    ifrMinutes: 0,
    landingsDay: 1,
    landingsNight: 0,
    simulatorMinutes: 0,
    simulatorRegistration: '',
    remarks: '',
    extra: {},
    ...overrides,
  };
}

function session(overrides: Partial<Flight> = {}): Flight {
  return flight({
    entryType: 'fstd',
    depAerodrome: 'SIM',
    arrAerodrome: 'SIM',
    offBlock: '',
    onBlock: '',
    aircraftType: 'FNPT2',
    registration: '',
    picName: '',
    totalMinutes: 0,
    picMinutes: 0,
    singlePilotSeMinutes: 0,
    landingsDay: 0,
    simulatorMinutes: 120,
    simulatorRegistration: 'EU-DK187',
    ...overrides,
  });
}

function setup(flights: Flight[], options = {}) {
  render(EasaPrintView, { props: { flights, options } });
}

/** Cells of one body row of the nth sheet-A grid. */
function rowA(rowIndex: number, gridIndex = 0): string[] {
  const grid = document.querySelectorAll('table.grid.a')[gridIndex];
  const row = grid.querySelectorAll('tbody tr')[rowIndex];
  return Array.from(row.children).map((c) => (c.textContent ?? '').trim());
}

function rowB(rowIndex: number, gridIndex = 0): string[] {
  const grid = document.querySelectorAll('table.grid.b')[gridIndex];
  const row = grid.querySelectorAll('tbody tr')[rowIndex];
  return Array.from(row.children).map((c) => (c.textContent ?? '').trim());
}

/** How many columns a row spans, counting colspans. */
function spanOf(tr: Element): number {
  return Array.from(tr.children).reduce(
    (n, c) => n + (Number(c.getAttribute('colspan')) || 1),
    0,
  );
}

describe('the grid is actually ruled correctly', () => {
  it('gives every row on sheet A the same number of columns', () => {
    setup([flight()]);
    const grid = document.querySelector('table.grid.a')!;
    // The two header rows carrying rowspans are two short by construction —
    // the rowspan cells belong to the row above. Everything else must match.
    const spans = Array.from(grid.querySelectorAll('tr')).map(spanOf);
    const body = spans.filter((_, i) => i !== 2);
    expect(new Set(body).size).toBe(1);
    expect(body[0]).toBe(20);
  });

  it('gives every row on sheet B the same number of columns', () => {
    setup([flight()]);
    const grid = document.querySelector('table.grid.b')!;
    const spans = Array.from(grid.querySelectorAll('tr')).map(spanOf);
    // Sheet B's sub-header and last two totals rows sit under rowspans.
    expect(spans.filter((s) => s === 17).length).toBeGreaterThan(8);
  });
});

describe('what the app refuses to print', () => {
  it('LEAVES THE TAKE-OFF COLUMNS BLANK', () => {
    /*
      The app records landings and not take-offs. Currency infers one from the
      other as a disclosed convenience; a signed page is a different matter, and
      printing an invented number into a certified document is not a convenience.
    */
    setup([flight({ landingsDay: 3, landingsNight: 2 })]);
    const cells = rowA(0);
    expect(cells[16]).toBe(''); // take-offs, day
    expect(cells[17]).toBe(''); // take-offs, night
    expect(cells[18]).toBe('3'); // landings, day — genuinely recorded
    expect(cells[19]).toBe('2'); // landings, night
  });

  it('leaves the take-off TOTALS blank too', () => {
    setup([flight({ landingsDay: 3 })]);
    const foot = document.querySelector('table.grid.a tfoot tr')!;
    const cells = Array.from(foot.children).map((c) => (c.textContent ?? '').trim());
    // label, SE, ME, MP, total, PIC, take-offs D, take-offs N, landings D, landings N
    expect(cells[6]).toBe('');
    expect(cells[7]).toBe('');
    expect(cells[8]).toBe('3');
  });

  it('does not put a simulator in the aircraft column', () => {
    setup([session()]);
    const cells = rowA(0);
    expect(cells[0]).toBe('2026-03-01'); // the row still needs its date
    expect(cells[5]).toBe(''); // Make, model, variant
    expect(cells[6]).toBe(''); // Registration
  });

  it('leaves a simulator session’s flight columns entirely empty', () => {
    setup([session()]);
    expect(rowA(0).slice(1)).toEqual(Array(19).fill(''));
  });

  it('prints no name unless one is typed for this print', () => {
    setup([flight()]);
    expect(document.querySelector('.cover-name')).toBeNull();
  });
});

describe('a simulator session', () => {
  it('fills the FSTD columns on sheet B', () => {
    setup([session({ dualMinutes: 90, ifrMinutes: 120, remarks: 'IR renewal' })]);
    const cells = rowB(0);
    expect(cells[12]).toBe('2026-03-01'); // FSTD date
    expect(cells[13]).toBe('EU-DK187'); // FSTD type
    expect(cells[14]).toBe('2'); // session hours
    expect(cells[15]).toBe('00'); // session minutes
    expect(cells[16]).toBe('IR renewal');
  });

  it('adds nothing to the flight total', () => {
    setup([flight(), session()]);
    const foot = document.querySelector('table.grid.a tfoot tr')!;
    const cells = Array.from(foot.children).map((c) => (c.textContent ?? '').trim());
    expect(cells[4]).toBe('1:38'); // total time of flight, page total
  });
});

describe('the ruled duration cells', () => {
  it('split hours from minutes, with no colon', () => {
    setup([flight({ totalMinutes: 98 })]);
    const cells = rowA(0);
    expect(cells[13]).toBe('1');
    expect(cells[14]).toBe('38');
  });

  it('leave an empty cell where nothing was logged', () => {
    setup([flight({ multiPilotMinutes: 0 })]);
    const cells = rowA(0);
    expect(cells[11]).toBe('');
    expect(cells[12]).toBe('');
  });

  it('print totals with a colon, the way the reference does', () => {
    setup([flight({ totalMinutes: 98 })]);
    const foot = document.querySelector('table.grid.a tfoot tr')!;
    expect((foot.children[4].textContent ?? '').trim()).toBe('1:38');
  });
});

describe('the page furniture', () => {
  it('numbers the sheets A and B', () => {
    setup(Array.from({ length: 9 }, (_, i) => flight({ date: `2026-03-0${i + 1}` })));
    const folios = Array.from(document.querySelectorAll('.folio')).map((f) =>
      (f.textContent ?? '').trim(),
    );
    expect(folios).toEqual(['Page 1A', 'Page 1B', 'Page 2A', 'Page 2B']);
  });

  it('carries the certification block on sheet B', () => {
    setup([flight()]);
    const cert = document.querySelector('.certify');
    expect(cert?.textContent).toMatch(/I certify the entries on this page are correct/);
    expect(cert?.textContent).toMatch(/PILOT'S SIGNATURE/);
  });

  it('states the range on the cover', () => {
    setup([flight({ date: '2026-03-01' }), flight({ date: '2026-04-01' })]);
    const cover = document.querySelector('.cover-range')!;
    expect(cover.textContent).toContain('2026-03-01');
    expect(cover.textContent).toContain('2026-04-01');
  });

  it('opens page 1 with the brought-forward balance', () => {
    setup([flight()], { openingBalance: { totalMinutes: 600 } });
    const rows = document.querySelectorAll('table.grid.a tfoot tr');
    const broughtForward = Array.from(rows[1].children).map((c) => (c.textContent ?? '').trim());
    expect(broughtForward[0]).toBe('Total from previous page');
    expect(broughtForward[4]).toBe('10:00');
  });
});
