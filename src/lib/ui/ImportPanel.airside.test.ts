/**
 * The Airside step of the import wizard.
 *
 * A separate file from `ImportPanel.test.ts` because it is a separate step with
 * a separate job: everything here is about a file that has to be REWRITTEN
 * before the ordinary wizard can read it, and about the promise that the
 * rewriting is stated rather than silent.
 *
 * The same limit applies as to the file beside it: jsdom is not a browser, so
 * this proves wiring, wording and step state and not that the thing looks right
 * or that a proxy never reaches IndexedDB.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ImportPanel from './ImportPanel.svelte';
import { db } from '../storage/db';
import { listFlights } from '../storage';
import { loadSettings } from '../stores/settings.svelte';

/*
 * The step offers the DEVICE's zone as the first anchor, and the fixture is an
 * Oslo-based pilot's file. Pinned, so the expected UTC times do not depend on
 * the clock of whichever machine runs the suite — CI runs on UTC.
 */
vi.mock('../time/zoneOffset', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../time/zoneOffset')>()),
  deviceTimeZone: () => 'Europe/Oslo',
}));

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'import',
  'fixtures',
  'airside.csv',
);
const AIRSIDE = readFileSync(FIXTURE, 'utf8');

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
  await loadSettings();
});

function setup() {
  const onBack = vi.fn();
  const onRestore = vi.fn();
  const onImported = vi.fn();
  render(ImportPanel, { props: { onBack, onRestore, onImported } });
  return { onBack, onRestore, onImported };
}

/**
 * The text of the one paragraph that contains a phrase.
 *
 * Several of these sentences put a number in a `<strong>`, which splits them
 * across text nodes and makes `getByText` either miss them or match every
 * ancestor. Reading a paragraph's `textContent` asks the question the test
 * actually means: does this sentence appear on the screen, whole.
 */
function sentence(phrase: string | RegExp): string {
  const test = typeof phrase === 'string' ? (t: string) => t.includes(phrase) : (t: string) => phrase.test(t);
  for (const node of document.querySelectorAll('p, li, label')) {
    const content = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (test(content)) return content;
  }
  return '';
}

async function choose(contents = AIRSIDE) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await userEvent.upload(input, new File([contents], 'airside.csv', { type: 'text/csv' }), {
    applyAccept: false,
  });
}

/** Get as far as the Airside step, with the aerodrome tables loaded. */
async function reachAirside() {
  await choose();
  await screen.findByText(/This is an Airside export/i);
  // The tables are a lazy chunk; the step renders before they arrive and the
  // counts appear once they have.
  await screen.findByText(/worked out exactly/i, undefined, { timeout: 5000 });
}

describe('recognising an Airside file', () => {
  it('names Airside among the formats it knows', async () => {
    setup();
    expect(await screen.findByText(/Airside/)).toBeInTheDocument();
  });

  it('goes to the Airside step rather than straight to the columns', async () => {
    setup();
    await choose();
    expect(await screen.findByText(/This is an Airside export/i)).toBeInTheDocument();
    expect(screen.queryByText(/What the columns mean/i)).not.toBeInTheDocument();
  });

  it('adds the step to the progress list', async () => {
    setup();
    await choose();
    await screen.findByText(/This is an Airside export/i);
    const progress = screen.getByRole('list', { name: /Import progress/i });
    expect(progress.textContent).toMatch(/Airside/);
  });
});

describe('the zone question', () => {
  it('offers the busiest aerodrome with a zone to confirm', async () => {
    setup();
    await reachAirside();
    // OSL touches twelve of the fixture's sectors, more than any other.
    expect(screen.getByText('OSL')).toBeInTheDocument();
    expect(screen.getByLabelText(/Time zone for OSL/i)).toBeInTheDocument();
  });

  it('says how much of the file it worked out, and how much it assumed', async () => {
    setup();
    await reachAirside();
    await userEvent.clear(screen.getByLabelText(/Time zone for OSL/i));
    await userEvent.type(screen.getByLabelText(/Time zone for OSL/i), 'Europe/Oslo');

    // Fourteen of the fifteen rows have a route and therefore a clock to work
    // out; eleven come out of the file's own arithmetic and three touch nothing
    // any answer reaches. The fifteenth has no route at all, so it is not
    // counted here — it is not a zone this step failed to solve.
    expect(sentence(/rows worked out exactly/)).toMatch(/11 of 14 rows worked out exactly/);
    expect(sentence(/rows worked out exactly/)).toMatch(/other 3 will be read as/);
  });

  it('names the rows it had to assume rather than only counting them', async () => {
    setup();
    await reachAirside();
    await userEvent.click(screen.getByRole('button', { name: /Show the .* assumed/i }));
    expect(await screen.findByText(/Line 8/)).toBeInTheDocument();
  });

  it('says so when a zone name is not one the browser knows', async () => {
    setup();
    await reachAirside();
    const field = screen.getByLabelText(/Time zone for OSL/i);
    await userEvent.clear(field);
    await userEvent.type(field, 'Europe/Nowhere');
    expect(await screen.findByText(/not a zone this browser knows/i)).toBeInTheDocument();
  });

  it('covers more of the file when a second aerodrome is named', async () => {
    setup();
    await reachAirside();
    expect(sentence(/rows worked out exactly/)).toMatch(/11 of 14/);

    await userEvent.selectOptions(screen.getByLabelText(/Add an aerodrome/i), 'ARN');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    await userEvent.clear(screen.getByLabelText(/Time zone for ARN/i));
    await userEvent.type(screen.getByLabelText(/Time zone for ARN/i), 'Europe/Stockholm');

    // Naming Stockholm settles the Tallinn sector that nothing else reached.
    expect(sentence(/rows worked out exactly/)).toMatch(/12 of 14/);
  });
});

describe('the transforms it states', () => {
  it('shows the registration change and lets it be turned off', async () => {
    setup();
    await reachAirside();
    const swedish = screen.getByRole('checkbox', { name: /SEXAA/ });
    expect(swedish).toBeChecked();
    expect(screen.getByText('SE-XAA')).toBeInTheDocument();

    await userEvent.click(swedish);
    expect(screen.queryByText('SE-XAA')).not.toBeInTheDocument();
  });

  it('says which registrations it will not touch', async () => {
    setup();
    await reachAirside();
    expect(sentence(/carry no prefix this app recognises/)).toMatch(/N12345/);
  });

  it('offers a designator for each model code, editable', async () => {
    setup();
    await reachAirside();
    const field = screen.getByLabelText(/Type designator for 32N/i) as HTMLInputElement;
    expect(field.value).toBe('A320');
    await userEvent.clear(field);
    await userEvent.type(field, 'A20N');
    expect(field.value).toBe('A20N');
  });

  it('names the aerodromes it could not translate', async () => {
    setup();
    await reachAirside();
    expect(screen.getByText(/imported as written/i)).toBeInTheDocument();
  });

  it('says the departure that slipped past midnight will move a day', async () => {
    setup();
    await reachAirside();
    expect(screen.getByText(/logged on the previous day/i)).toBeInTheDocument();
  });
});

describe('night time', () => {
  it('is offered, on by default, with what it produced', async () => {
    setup();
    await reachAirside();
    const toggle = screen.getByRole('checkbox', {
      name: /Work out night time and place the landings/i,
    });
    expect(toggle).toBeChecked();
    expect(sentence(/of night time/)).toMatch(/rows worked out, adding [\d.]+ hours of night time/);
  });

  it('says plainly what turning it off costs', async () => {
    setup();
    await reachAirside();
    await userEvent.click(
      screen.getByRole('checkbox', { name: /Work out night time and place the landings/i }),
    );
    // Including the part a pilot would not otherwise find out: the toolbox can
    // fill night time in later, but it never moves a landing.
    expect(await screen.findByText(/does not move landings/i)).toBeInTheDocument();
  });
});

describe('carrying on into the ordinary wizard', () => {
  it('shows the rewritten file in the columns step', async () => {
    setup();
    await reachAirside();
    await userEvent.click(screen.getByRole('button', { name: /Next: columns/i }));

    await screen.findByText(/What the columns mean/i);
    // The columns the adapter produced, not the nine the file had — the
    // rewriting is shown rather than hidden behind the step. Read off the
    // column names themselves, because every field label also appears in every
    // row's target dropdown.
    const columns = [...document.querySelectorAll('.col-name')].map((el) => el.textContent);
    expect(columns).toEqual([
      'Flight Number',
      'Date',
      'Departure',
      'Arrival',
      'Block Off',
      'Block On',
      'Registration',
      'Aircraft Type',
      'Total Time',
      'Night',
      'Ldg Day',
      'Ldg Night',
      'Zone Assumed',
    ]);
  });

  it('does not ask for a file-wide time zone a second time', async () => {
    // The Airside step answered it per aerodrome and per date. A second
    // file-wide offset here would shift every row again.
    setup();
    await reachAirside();
    await userEvent.click(screen.getByRole('button', { name: /Next: columns/i }));
    await screen.findByText(/What the columns mean/i);

    expect(screen.queryByText(/Block times in this file are in/i)).not.toBeInTheDocument();
    expect(screen.getByText(/converted to UTC in the Airside step/i)).toBeInTheDocument();
  });

  it('goes back to the Airside step and keeps the answers', async () => {
    setup();
    await reachAirside();
    const field = screen.getByLabelText(/Type designator for 32N/i) as HTMLInputElement;
    await userEvent.clear(field);
    await userEvent.type(field, 'A20N');

    await userEvent.click(screen.getByRole('button', { name: /Next: columns/i }));
    await screen.findByText(/What the columns mean/i);
    await userEvent.click(screen.getByRole('button', { name: /^Back$/ }));

    await screen.findByText(/This is an Airside export/i);
    expect((screen.getByLabelText(/Type designator for 32N/i) as HTMLInputElement).value).toBe(
      'A20N',
    );
  });

  it('imports, and writes UTC times worked out from the local ones', async () => {
    setup();
    await reachAirside();
    await userEvent.click(screen.getByRole('button', { name: /Next: columns/i }));
    await screen.findByText(/What the columns mean/i);
    await userEvent.click(screen.getByRole('button', { name: /Next: aircraft/i }));
    await screen.findByText(/The aircraft in this file/i);
    await userEvent.click(screen.getByRole('button', { name: /Next: review/i }));

    // The overlap the fixture carries stops the wizard before the review card:
    // lines 2 and 16 both depart Oslo that morning, found by the same
    // `findConflicts` the entry form uses. The safe answer is offered first.
    await screen.findByRole('button', { name: /Import them anyway/i });
    await userEvent.click(screen.getByRole('button', { name: /Import them anyway/i }));

    await screen.findByText(/What will be imported/i);
    await userEvent.click(screen.getByRole('button', { name: /^Import \d+ entries$/ }));

    await screen.findByText(/Imported/i);
    const flights = await listFlights();
    const sector = flights.find((flight) => flight.extra['Flight Number'] === 'XY1001');
    expect(sector).toBeDefined();
    // 08:00 at Oslo on 15 January is 07:00Z, and the 55-minute total puts the
    // on-block at 07:55Z.
    expect(sector!.offBlock).toBe('07:00');
    expect(sector!.onBlock).toBe('07:55');
    expect(sector!.depAerodrome).toBe('ENGM');
    expect(sector!.registration).toBe('SE-XAA');
  });
});
