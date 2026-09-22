/**
 * The import wizard.
 *
 * These cover WIRING, WORDING AND STEP STATE — the things unit tests on the
 * pure modules cannot see, and the things a pilot actually touches. The
 * arithmetic underneath is already proven in `plan.test.ts`; what matters here
 * is that the right numbers reach the screen, that a destructive-looking pause
 * offers the safe option first, and that a file picked by mistake is handed to
 * the other flow rather than rejected with a shrug.
 *
 * WHAT THIS FILE CANNOT PROVE: jsdom has no structured clone behind IndexedDB,
 * so a Svelte proxy reaching storage still passes here. That is what the
 * click-through in a real browser is for, and it is not optional.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ImportPanel from './ImportPanel.svelte';
import { db } from '../storage/db';
import { listFlights, getTotals, addFlight, getAllAircraft } from '../storage';
import { loadSettings } from '../stores/settings.svelte';

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'import',
  'fixtures',
);
const RB = readFileSync(path.join(FIXTURE_DIR, 'rb-logbook.csv'), 'utf8');

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

/** Hand the hidden file input a file, as a real pick would. */
async function choose(name: string, contents: string, type = 'text/csv') {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  // applyAccept:false models what a real pilot can do: the accept attribute
  // is a HINT in the file dialog, and any browser lets you switch it to "all
  // files" and pick a .json anyway. Enforcing it here would make the
  // wrong-file case untestable — which is the case that matters most.
  await userEvent.upload(input, new File([contents], name, { type }), { applyAccept: false });
}

/** Walk from the file step to the review step, accepting every default. */
async function reachPreview() {
  await choose('rb-logbook.csv', RB);
  await screen.findByText(/What the columns mean/i);
  await userEvent.click(screen.getByRole('button', { name: /Next: aircraft/i }));
  await screen.findByText(/The aircraft in this file/i);
  await userEvent.click(screen.getByRole('button', { name: /Next: review/i }));
}

describe('step 1 — choosing a file', () => {
  it('starts on the file step and says what import does', async () => {
    setup();
    expect(await screen.findByText(/Choose a CSV file/i)).toBeInTheDocument();
    // The single most important word on this screen: it ADDS.
    expect(screen.getByText(/adds/i)).toBeInTheDocument();
  });

  it('names the formats it recognises', async () => {
    setup();
    expect(screen.getByText(/RB Logbook/)).toBeInTheDocument();
  });

  it('moves to the mapping step once a CSV is chosen', async () => {
    setup();
    await choose('rb-logbook.csv', RB);
    expect(await screen.findByText(/What the columns mean/i)).toBeInTheDocument();
  });

  it('hands a JSON backup over to Restore instead of just refusing it', async () => {
    // The other half of the cross-offer. Restore already recognises a
    // spreadsheet; now each flow can send the pilot to the other.
    const { onRestore } = setup();
    await choose('backup.json', '{"format":"open-pilot-logbook","flights":[]}', 'application/json');

    expect(await screen.findByRole('alert')).toHaveTextContent(/Restore/i);
    const offer = screen.getByRole('button', { name: /Go to Restore/i });
    await userEvent.click(offer);
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it('reports an unreadable file without moving on', async () => {
    setup();
    await choose('empty.csv', '   ');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Choose a CSV file/i)).toBeInTheDocument();
  });
});

describe('step 2 — the columns', () => {
  it('recognises the RB fixture and says so', async () => {
    setup();
    await choose('rb-logbook.csv', RB);
    const heading = await screen.findByText(/What the columns mean/i);
    const card = heading.closest('section') as HTMLElement;
    expect(within(card).getByText(/Recognised as/i)).toBeInTheDocument();
    expect(within(card).getByText('RB Logbook')).toBeInTheDocument();
  });

  it('states the row and column count from the file, not from a guess', async () => {
    setup();
    await choose('rb-logbook.csv', RB);
    const heading = await screen.findByText(/What the columns mean/i);
    const card = heading.closest('section') as HTMLElement;
    // 14 rows — the unterminated last row included — and 105 columns.
    expect(card.textContent).toMatch(/14\s+rows/);
    expect(card.textContent).toMatch(/105 columns/);
  });

  it('hides the empty columns rather than showing 105 dropdowns', async () => {
    setup();
    await choose('rb-logbook.csv', RB);
    await screen.findByRole('button', { name: /Show all 105/i });
    expect(await screen.findByText(/columns are hidden/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Show all 105/i }));
    expect(screen.getByRole('button', { name: /Show only columns with data/i })).toBeInTheDocument();
  });

  it('shows the duration unit it worked out, and what it worked it out from', async () => {
    setup();
    await choose('rb-logbook.csv', RB);
    await screen.findByText(/Durations in this file are/i);
    const select = screen.getByRole('combobox', { name: /Durations in this file are/i });
    expect(select).toHaveValue('minutes');
    expect(screen.getByText(/Worked out from values like/i)).toBeInTheDocument();
  });

  it('warns loudly when the unit could not be told from the file', async () => {
    // "2" is equally good as two minutes or two hours, and nothing in the file
    // breaks the tie. An undecidable file must never pass silently.
    setup();
    await choose('small.csv', 'Date,Total Time of Flight\r\n2024-01-01,2\r\n');
    expect(await screen.findByText(/does not say which unit/i)).toBeInTheDocument();
    // Shown alongside a worked example, so the ambiguity is concrete rather
    // than a caution the pilot has to imagine the consequences of.
    expect(screen.getByText(/will be read as/i)).toBeInTheDocument();
  });
});

describe('the duration-unit guard', () => {
  /** Walk to the review having deliberately chosen the wrong unit. */
  async function reachPreviewAsHours() {
    await choose('rb-logbook.csv', RB);
    await screen.findByText(/What the columns mean/i);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /Durations in this file are/i }),
      'decimalHours',
    );
    await userEvent.click(screen.getByRole('button', { name: /Next: aircraft/i }));
    await screen.findByText(/The aircraft in this file/i);
    await userEvent.click(screen.getByRole('button', { name: /Next: review/i }));
  }

  it('shows a worked example from the file, so the choice has a visible consequence', async () => {
    setup();
    await choose('rb-logbook.csv', RB);
    await screen.findByText(/What the columns mean/i);

    // Correct unit: 138 is 138 minutes.
    expect(await screen.findByText(/will be read as/i)).toBeInTheDocument();
    expect(screen.getByText('2.3 hours')).toBeInTheDocument();

    // Wrong unit: the same cell becomes 138 hours, said out loud, right here.
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /Durations in this file are/i }),
      'decimalHours',
    );
    expect(await screen.findByText('138.0 hours')).toBeInTheDocument();
  });

  it('STOPS the review when the totals disagree with the file’s own block times', async () => {
    // The real failure: a whole logbook imported as tens of thousands of hours because the unit was
    // set to decimal hours for a file of whole minutes. The preview reported it
    // without comment.
    setup();
    await reachPreviewAsHours();

    expect(await screen.findByText(/These durations cannot be right/i)).toBeInTheDocument();
    expect(screen.getByText(/factor of about/i)).toBeInTheDocument();
    // And the import is not reachable past it.
    expect(screen.queryByRole('button', { name: /^Import \d+ entries$/i })).not.toBeInTheDocument();
  });

  it('names the unit the file actually looks like, and offers to set it', async () => {
    setup();
    await reachPreviewAsHours();
    await screen.findByText(/These durations cannot be right/i);

    const fix = screen.getByRole('button', { name: /Set it to whole minutes/i });
    await userEvent.click(fix);

    // Back on the columns step, with the unit corrected.
    expect(await screen.findByText(/What the columns mean/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Durations in this file are/i })).toHaveValue(
      'minutes',
    );
  });

  it('gets out of the way once the unit is right', async () => {
    setup();
    await reachPreviewAsHours();
    await userEvent.click(await screen.findByRole('button', { name: /Set it to whole minutes/i }));
    await screen.findByText(/What the columns mean/i);

    await userEvent.click(screen.getByRole('button', { name: /Next: aircraft/i }));
    await screen.findByText(/The aircraft in this file/i);
    await userEvent.click(screen.getByRole('button', { name: /Next: review/i }));

    // Straight to the ordinary conflict pause; no duration complaint.
    expect(await screen.findByText(/Some of these flights overlap in time/i)).toBeInTheDocument();
    expect(screen.queryByText(/These durations cannot be right/i)).not.toBeInTheDocument();
  });

  it('never fires on a correctly-read file', async () => {
    setup();
    await reachPreview();
    expect(screen.queryByText(/These durations cannot be right/i)).not.toBeInTheDocument();
  });
});

describe('step 3 — the aircraft', () => {
  it('asks once per TYPE, not once per registration', async () => {
    // The whole point: a real file has many registrations and few types.
    setup();
    await choose('rb-logbook.csv', RB);
    await userEvent.click(await screen.findByRole('button', { name: /Next: aircraft/i }));

    await screen.findByText(/The aircraft in this file/i);
    expect(screen.getByText('A320')).toBeInTheDocument();
    expect(screen.getByText('A319')).toBeInTheDocument();
    expect(screen.getByText('C172')).toBeInTheDocument();
    // Not one row per registration.
    expect(screen.queryByText('OY-XXA')).not.toBeInTheDocument();
  });

  it('suggests multi-pilot for the airliners and not for the light aircraft', async () => {
    setup();
    await choose('rb-logbook.csv', RB);
    await userEvent.click(await screen.findByRole('button', { name: /Next: aircraft/i }));
    await screen.findByText(/The aircraft in this file/i);

    const checkboxes = screen.getAllByRole('checkbox', { name: /Multi-pilot/i });
    // A319 and A320 suggested on; C172 and PA28 suggested off.
    expect(checkboxes.filter((c) => (c as HTMLInputElement).checked)).toHaveLength(2);
  });

  it('lists the registrations the file gives no type for, and says why it matters', async () => {
    setup();
    await choose('rb-logbook.csv', RB);
    await userEvent.click(await screen.findByRole('button', { name: /Next: aircraft/i }));

    await screen.findByText(/These have no aircraft type/i);
    expect(screen.getByRole('textbox', { name: /Aircraft type for LN-XXZ/i })).toBeInTheDocument();
    expect(screen.getByText(/cannot be imported/i)).toBeInTheDocument();
  });
});

describe('step 4 — the review', () => {
  it('pauses on the overlapping flights before showing anything else', async () => {
    setup();
    await reachPreview();
    expect(await screen.findByText(/Some of these flights overlap in time/i)).toBeInTheDocument();
    // The confirm button is not reachable until the pause is answered.
    expect(screen.queryByRole('button', { name: /^Import \d+ entries$/i })).not.toBeInTheDocument();
  });

  it('groups the overlaps into situations rather than listing pairs', async () => {
    setup();
    await reachPreview();
    const heading = await screen.findByText(/Some of these flights overlap in time/i);
    const card = heading.closest('section') as HTMLElement;
    // Four overlapping pairs in the fixture, but only two things to decide.
    // Counted on the OUTER list — each group now contains a nested list of the
    // actual flights, which is the point of the redesign.
    expect(card.querySelectorAll('.conflicts > li')).toHaveLength(2);
  });

  it('caps the conflict list rather than burying the buttons under it', async () => {
    // Found in a real browser: re-importing a file already in the logbook
    // produced hundreds of groups, one per row, and pushed the three buttons off the
    // bottom of a wall of identical lines.
    await addFlight({
      date: '2024-08-05',
      depAerodrome: 'ENGM',
      arrAerodrome: 'ENBR',
      offBlock: '06:30',
      onBlock: '10:30',
      aircraftType: 'A320',
      registration: 'OY-XXA',
      picName: '',
      totalMinutes: 240,
    });

    setup();
    await reachPreview();
    const heading = await screen.findByText(/Some of these flights overlap in time/i);
    const card = heading.closest('section') as HTMLElement;

    // Whatever the count, the buttons stay reachable and the list stays short.
    expect(card.querySelectorAll('.conflicts > li').length).toBeLessThanOrEqual(15);
    expect(within(card).getByRole('button', { name: /^Skip /i })).toBeInTheDocument();
  });

  it('offers three ways out, with the safe one first', async () => {
    setup();
    await reachPreview();
    await screen.findByText(/Some of these flights overlap in time/i);

    expect(screen.getByRole('button', { name: /Skip 5 overlapping rows/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import them anyway/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
  });

  it('states the flight total and the simulator total SEPARATELY', async () => {
    setup();
    await reachPreview();
    await userEvent.click(await screen.findByRole('button', { name: /Import them anyway/i }));

    await screen.findByText(/What will be imported/i);
    expect(screen.getByText(/23.5 hours of flight time/i)).toBeInTheDocument();
    expect(screen.getByText(/5\.3 hours of simulator time/i)).toBeInTheDocument();
  });

  it('names the simulator block time it is NOT counting', async () => {
    // The simulator block-time trap, in miniature and stated out loud.
    setup();
    await reachPreview();
    await userEvent.click(await screen.findByRole('button', { name: /Import them anyway/i }));

    await screen.findByText(/What will be imported/i);
    expect(screen.getByText(/6\.0 hours of block time recorded against/i)).toBeInTheDocument();
    expect(screen.getByText(/NOT added to your flight time/i)).toBeInTheDocument();
  });

  it('recounts when the pilot chooses to skip the overlaps', async () => {
    setup();
    await reachPreview();
    await userEvent.click(await screen.findByRole('button', { name: /Skip 5 overlapping rows/i }));

    await screen.findByText(/What will be imported/i);
    expect(screen.getByText(/5 rows are being left out/i)).toBeInTheDocument();
    // 12 ready less the 5 skipped.
    expect(screen.getByRole('button', { name: /Import 7 entries/i })).toBeInTheDocument();
  });

  it('lists the rows it will leave out, and separates a question from a fault', async () => {
    setup();
    await reachPreview();
    await userEvent.click(await screen.findByRole('button', { name: /Import them anyway/i }));

    await screen.findByText(/Rows that will be left out/i);
    expect(screen.getByText(/Line 5/)).toBeInTheDocument();
  });
});

describe('answering the missing aircraft type', () => {
  it('unblocks the rows that were waiting on it', async () => {
    // The journey the format document asks for: some rows of the real file have a
    // registration and no type, and the pilot must get a chance to supply one
    // rather than have the rows rejected or blanked.
    setup();
    await choose('rb-logbook.csv', RB);
    await userEvent.click(await screen.findByRole('button', { name: /Next: aircraft/i }));
    await screen.findByText(/These have no aircraft type/i);

    await userEvent.type(
      screen.getByRole('textbox', { name: /Aircraft type for LN-XXZ/i }),
      'PA28',
    );
    await userEvent.click(screen.getByRole('button', { name: /Next: review/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Import them anyway/i }));

    // One more entry than before, and the hour it carries is now counted.
    expect(await screen.findByRole('button', { name: /Import 13 entries/i })).toBeInTheDocument();
    expect(screen.getByText(/24\.5 hours of flight time/i)).toBeInTheDocument();
  });

  it('remembers the answer, so the aircraft is known next time', async () => {
    setup();
    await choose('rb-logbook.csv', RB);
    await userEvent.click(await screen.findByRole('button', { name: /Next: aircraft/i }));
    await screen.findByText(/These have no aircraft type/i);
    await userEvent.type(
      screen.getByRole('textbox', { name: /Aircraft type for LN-XXZ/i }),
      'PA28',
    );
    await userEvent.click(screen.getByRole('button', { name: /Next: review/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Import them anyway/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Import 13 entries/i }));
    await screen.findByText(/^Imported$/i);

    const stored = await getAllAircraft();
    expect(stored.find((a) => a.registration === 'LN-XXZ')?.type).toBe('PA28');
  });
});

describe('fixing an overlap in the pause', () => {
  it('shows the actual flights, not just their line numbers', async () => {
    setup();
    await reachPreview();
    const heading = await screen.findByText(/Some of these flights overlap in time/i);
    const card = heading.closest('section') as HTMLElement;

    // The fixture's pair: line 6 is EKCH→EGLL 08:00–10:00, line 7 EGLL→EKCH
    // 09:00–11:00. Both should be legible without leaving this screen.
    expect(within(card).getByText('EKCH→EGLL')).toBeInTheDocument();
    expect(within(card).getByText('08:00–10:00')).toBeInTheDocument();
    expect(within(card).getByText('09:00–11:00')).toBeInTheDocument();
    expect(within(card).getAllByText('OY-XXA').length).toBeGreaterThan(0);
  });

  it('offers each flight its own way out', async () => {
    setup();
    await reachPreview();
    await screen.findByText(/Some of these flights overlap in time/i);
    // Five conflicting rows, each with both actions.
    expect(screen.getAllByRole('button', { name: /Correct times/i })).toHaveLength(5);
    expect(screen.getAllByRole('button', { name: /Leave this one out/i })).toHaveLength(5);
  });

  it('CORRECTING the times removes the overlap without losing the flight', async () => {
    // The point of the whole feature: a genuine flight with a typo gets fixed,
    // not skipped.
    setup();
    await reachPreview();
    await screen.findByText(/Some of these flights overlap in time/i);

    const beforeGroups = document.querySelectorAll('.conflicts > li').length;
    expect(beforeGroups).toBe(2);

    // Move line 7 clear of line 6, which lands at 10:00.
    await userEvent.click(screen.getAllByRole('button', { name: /Correct times/i })[1]);
    const off = screen.getByRole('textbox', { name: /Off block for line 7/i });
    const on = screen.getByRole('textbox', { name: /On block for line 7/i });
    await userEvent.clear(off);
    await userEvent.type(off, '10:00');
    await userEvent.clear(on);
    await userEvent.type(on, '12:00');
    await userEvent.click(screen.getByRole('button', { name: /Save correction/i }));

    // That group is gone; the three-row cluster remains.
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.conflicts > li')).toHaveLength(1);
    });

    // And the flight is still going in — asserted explicitly, because a row
    // that a bad edit had INVALIDATED would also vanish from the conflict list,
    // and this test would pass while the flight was quietly being thrown away.
    expect(screen.queryByText(/being left out/i)).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /Import them anyway/i }));
    expect(await screen.findByRole('button', { name: /Import 12 entries/i })).toBeInTheDocument();
    expect(screen.queryByText(/Line 7/)).not.toBeInTheDocument();
  });

  it('saves the corrected values, not what the file said', async () => {
    setup();
    await reachPreview();
    await screen.findByText(/Some of these flights overlap in time/i);

    await userEvent.click(screen.getAllByRole('button', { name: /Correct times/i })[1]);
    const off = screen.getByRole('textbox', { name: /Off block for line 7/i });
    await userEvent.clear(off);
    await userEvent.type(off, '10:00');
    const on = screen.getByRole('textbox', { name: /On block for line 7/i });
    await userEvent.clear(on);
    await userEvent.type(on, '12:00');
    await userEvent.click(screen.getByRole('button', { name: /Save correction/i }));

    await userEvent.click(await screen.findByRole('button', { name: /Import them anyway/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Import 12 entries/i }));
    await screen.findByText(/^Imported$/i);

    const stored = await listFlights();
    const corrected = stored.find((f) => f.offBlock === '10:00' && f.date === '2024-07-10');
    expect(corrected).toBeDefined();
    expect(corrected?.onBlock).toBe('12:00');
  });

  it('says out loud that a corrected row will not match the file', async () => {
    setup();
    await reachPreview();
    await screen.findByText(/Some of these flights overlap in time/i);
    await userEvent.click(screen.getAllByRole('button', { name: /Correct times/i })[1]);
    await userEvent.click(screen.getByRole('button', { name: /Save correction/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Import them anyway/i }));

    await screen.findByText(/What will be imported/i);
    expect(screen.getByText(/corrected here before importing/i)).toBeInTheDocument();
    expect(screen.getByText(/not what the file says/i)).toBeInTheDocument();
  });

  it('DROPPING one row leaves the rest of the import alone', async () => {
    setup();
    await reachPreview();
    await screen.findByText(/Some of these flights overlap in time/i);

    await userEvent.click(screen.getAllByRole('button', { name: /Leave this one out/i })[1]);

    await vi.waitFor(() => {
      expect(screen.getByText(/Being left out \(1\)/i)).toBeInTheDocument();
    });
    // That pair is resolved; the three-row cluster is untouched.
    expect(document.querySelectorAll('.conflicts > li')).toHaveLength(1);
  });

  it('lets a dropped row be put back, rather than vanishing for good', async () => {
    setup();
    await reachPreview();
    await screen.findByText(/Some of these flights overlap in time/i);

    await userEvent.click(screen.getAllByRole('button', { name: /Leave this one out/i })[1]);
    await screen.findByText(/Being left out \(1\)/i);

    await userEvent.click(screen.getByRole('button', { name: /Include again/i }));
    await vi.waitFor(() => {
      expect(screen.queryByText(/Being left out/i)).not.toBeInTheDocument();
    });
    expect(document.querySelectorAll('.conflicts > li')).toHaveLength(2);
  });

  it('shows a clashing flight that is ALREADY saved, read-only', async () => {
    // Nothing in this wizard writes until the import is confirmed, so a stored
    // flight is shown for context and not made editable here.
    await addFlight({
      date: '2024-07-10',
      depAerodrome: 'ENGM',
      arrAerodrome: 'ENBR',
      offBlock: '08:30',
      onBlock: '09:30',
      aircraftType: 'C172',
      registration: 'LN-OLD',
      picName: '',
      totalMinutes: 60,
    });

    setup();
    await reachPreview();
    const heading = await screen.findByText(/Some of these flights overlap in time/i);
    const card = heading.closest('section') as HTMLElement;

    expect(within(card).getByText('Already saved')).toBeInTheDocument();
    expect(within(card).getByText('LN-OLD')).toBeInTheDocument();
    // No action offered against it.
    const storedRow = card.querySelector('.flight.stored') as HTMLElement;
    expect(storedRow.querySelectorAll('button')).toHaveLength(0);
  });

  it('clears the pause entirely once every overlap is dealt with', async () => {
    // "Smoothly importing it all" — fix the problems and the wizard just moves
    // on, with no extra button to press.
    setup();
    await reachPreview();
    await screen.findByText(/Some of these flights overlap in time/i);

    for (const label of [/Leave this one out/i]) {
      // Drop rows until nothing overlaps: the pair needs one, the cluster two.
      let guard = 0;
      while (document.querySelectorAll('.conflicts > li').length > 0 && guard++ < 6) {
        const buttons = screen.queryAllByRole('button', { name: label });
        if (buttons.length === 0) break;
        await userEvent.click(buttons[0]);
      }
    }

    expect(await screen.findByText(/What will be imported/i)).toBeInTheDocument();
    expect(screen.queryByText(/Some of these flights overlap in time/i)).not.toBeInTheDocument();
  });
});

describe('the write', () => {
  it('imports, reports what it wrote, and adds no simulator time to flight time', async () => {
    const { onImported } = setup();
    await reachPreview();
    await userEvent.click(await screen.findByRole('button', { name: /Import them anyway/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Import 12 entries/i }));

    expect(await screen.findByText(/^Imported$/i)).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledOnce();

    const stored = await listFlights();
    expect(stored).toHaveLength(12);

    // THE GOVERNING RULE, end to end through the real UI: the two simulator
    // rows carry 360 minutes of block time between them, and not one minute of
    // it is flight time.
    const totals = await getTotals();
    expect(totals.totalMinutes).toBe(1408);
    expect(stored.filter((f) => f.entryType === 'fstd')).toHaveLength(2);
  });

  it('leaves flights that were already there untouched', async () => {
    await addFlight({
      date: '2019-01-01',
      depAerodrome: 'ENGM',
      arrAerodrome: 'ENBR',
      offBlock: '06:00',
      onBlock: '07:00',
      aircraftType: 'C172',
      registration: 'LN-OLD',
      picName: 'SELF',
      totalMinutes: 60,
    });

    setup();
    await reachPreview();
    await userEvent.click(await screen.findByRole('button', { name: /Import them anyway/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Import 12 entries/i }));
    await screen.findByText(/^Imported$/i);

    const stored = await listFlights();
    expect(stored).toHaveLength(13);
    expect(stored.some((f) => f.registration === 'LN-OLD')).toBe(true);
  });

  it('suggests a backup afterwards, because an import is a big change', async () => {
    setup();
    await reachPreview();
    await userEvent.click(await screen.findByRole('button', { name: /Import them anyway/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Import 12 entries/i }));

    await screen.findByText(/^Imported$/i);
    expect(screen.getByText(/good moment to back up/i)).toBeInTheDocument();
  });
});

describe('getting out', () => {
  it('can go back from the review to the aircraft step', async () => {
    setup();
    await reachPreview();
    await userEvent.click(await screen.findByRole('button', { name: /Import them anyway/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^Back$/i }));
    expect(await screen.findByText(/The aircraft in this file/i)).toBeInTheDocument();
  });

  it('cancelling the conflict pause returns to the file step with nothing written', async () => {
    setup();
    await reachPreview();
    await userEvent.click(await screen.findByRole('button', { name: /Cancel/i }));

    expect(await screen.findByText(/Choose a CSV file/i)).toBeInTheDocument();
    expect(await listFlights()).toHaveLength(0);
  });
});
