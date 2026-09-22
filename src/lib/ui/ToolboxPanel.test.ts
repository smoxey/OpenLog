/**
 * The toolbox screen.
 *
 * The planning is covered in `domain/bulkAdjust.test.ts` and the writing in
 * `storage/bulkAdjust.test.ts`. What this file covers is what the SCREEN says
 * and does — which is where the Phase 4 lesson applies: three wording bugs in
 * the entry form's warning were invisible to 700 passing tests because none of
 * them were wrong in the domain, only on the screen.
 *
 * Three things in particular, because getting any of them wrong rewrites a
 * logbook the pilot cannot get back:
 *
 *  - the affected COUNT is on screen before anything can be applied;
 *  - Apply does not write — it asks first, and Cancel leaves the logbook alone;
 *  - "Add" is explained as filling the column with the entry's own time, so
 *    nobody has to infer that from a number.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ToolboxPanel from './ToolboxPanel.svelte';
import { db } from '../storage/db';
import { addFlight, getAllFlights, type NewFlightInput } from '../storage';
import { loadSettings } from '../stores/settings.svelte';

function input(overrides: Partial<NewFlightInput> = {}): NewFlightInput {
  return {
    date: '2026-07-18',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '10:00',
    onBlock: '11:30',
    aircraftType: 'A320',
    registration: 'LN-ABC',
    picName: '',
    totalMinutes: 90,
    ...overrides,
  } as NewFlightInput;
}

const noop = () => {};

/**
 * Rendered text with its line breaks collapsed.
 *
 * Svelte keeps the source newlines inside a text node, so a sentence that wraps
 * across two lines in the template arrives here as "…and\n   ME time". Matching
 * against the raw `textContent` would make every assertion below depend on
 * where the markup happens to wrap, which is not what any of them are about.
 */
function text(node: HTMLElement): string {
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

beforeEach(async () => {
  await db.flights.clear();
  await db.aircraft.clear();
  await db.settings.clear();
  await loadSettings();
});

/** Build the commonest sentence: fill Multi-Pilot on every A320. */
async function fillMultiPilotOnA320(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText('Time column'), 'multiPilotMinutes');
  await user.type(screen.getByLabelText('Aircraft type'), 'A320');
}

describe('the count', () => {
  it('is on screen before anything can be applied', async () => {
    await addFlight(input({ registration: 'LN-AAA' }));
    await addFlight(input({ registration: 'LN-BBB' }));
    await addFlight(input({ aircraftType: 'C172', registration: 'LN-CCC' }));

    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');

    await fillMultiPilotOnA320(user);

    const outcome = await screen.findByRole('status', { name: 'Adjustment summary' });
    expect(text(outcome)).toMatch(/2\s*entries will change/);
    expect(text(outcome)).toMatch(/2 flights/);
  });

  it('says what matched nothing rather than offering an empty run', async () => {
    await addFlight(input());

    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');

    await user.selectOptions(screen.getByLabelText('Time column'), 'multiPilotMinutes');
    await user.type(screen.getByLabelText('Aircraft type'), 'B738');

    expect(text(await screen.findByRole('status', { name: 'Adjustment summary' }))).toMatch(/Nothing in the logbook/);
    expect(screen.getByRole('button', { name: 'Apply adjustment' })).toBeDisabled();
  });

  it('keeps Apply disabled until a complete sentence is built', async () => {
    await addFlight(input());
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');
    expect(screen.getByRole('button', { name: 'Apply adjustment' })).toBeDisabled();
  });
});

describe('what add and remove say they do', () => {
  it('explains Add as filing the whole time into the column', async () => {
    await addFlight(input());
    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');

    await user.selectOptions(screen.getByLabelText('Time column'), 'multiPilotMinutes');
    expect(
      screen.getByText(/puts each entry's whole time into the Multi-Pilot column/i),
    ).toBeTruthy();
  });

  it('explains Remove as zeroing the column, total untouched', async () => {
    await addFlight(input());
    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');

    await user.selectOptions(screen.getByLabelText('Time column'), 'ifrMinutes');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText(/sets the IFR column to zero/i)).toBeTruthy();
    expect(screen.getByText(/total time is not touched/i)).toBeTruthy();
  });

  it('says plainly that there is no VFR column', async () => {
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');
    expect(screen.getByText(/no VFR column in an EASA logbook/i)).toBeTruthy();
  });

  it('never offers a yardstick column', async () => {
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');
    const options = [...screen.getByLabelText<HTMLSelectElement>('Time column').options].map(
      (o) => o.value,
    );
    expect(options).not.toContain('totalMinutes');
    expect(options).not.toContain('simulatorMinutes');
    expect(options).toContain('multiPilotMinutes');
  });
});

describe('confirmation', () => {
  it('asks before writing, and Cancel leaves the logbook alone', async () => {
    await addFlight(input());

    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');
    await fillMultiPilotOnA320(user);

    await user.click(await screen.findByRole('button', { name: 'Apply adjustment' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(text(dialog)).toMatch(/Change 1 entry\?/);
    expect(text(dialog)).toMatch(/no undo/i);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect((await getAllFlights())[0].multiPilotMinutes).toBe(0);
  });

  it('writes only once confirmed, and reports how many changed', async () => {
    await addFlight(input({ registration: 'LN-AAA', totalMinutes: 95 }));
    await addFlight(input({ registration: 'LN-BBB', totalMinutes: 145 }));

    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');
    await fillMultiPilotOnA320(user);

    await user.click(await screen.findByRole('button', { name: 'Apply adjustment' }));
    await user.click(await screen.findByRole('button', { name: 'Change them' }));

    await screen.findByText(/2 entries updated\./);

    const flights = await getAllFlights();
    for (const flight of flights) {
      expect(flight.multiPilotMinutes).toBe(flight.totalMinutes);
    }
  });
});

describe('the mutually exclusive columns', () => {
  it('warns without blocking when a sibling column is already set', async () => {
    await addFlight(input({ totalMinutes: 90, singlePilotMeMinutes: 90 } as Partial<NewFlightInput>));

    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');
    await fillMultiPilotOnA320(user);

    expect(text(await screen.findByRole('status', { name: 'Adjustment summary' }))).toMatch(
      /would then hold both Multi-Pilot and ME time/,
    );
    // Advisory, exactly like the overlap warning in the entry form.
    expect(screen.getByRole('button', { name: 'Apply adjustment' })).not.toBeDisabled();
  });
});

/**
 * The review list.
 *
 * The count says how MANY entries a sentence is about; this says WHICH, and it
 * is the last thing between a pilot and a rewrite they cannot undo. Two things
 * have to hold, and both of them are about the screen rather than the plan:
 *
 *  - every affected entry can be read, not just the first few;
 *  - a ticked-off entry is genuinely left alone by the write, and is still
 *    on screen afterwards to be ticked back on.
 */
describe('the review list', () => {
  /** Six, so the list is longer than the five-row sample. */
  async function sixA320s() {
    for (const reg of ['LN-AAA', 'LN-BBB', 'LN-CCC', 'LN-DDD', 'LN-EEE', 'LN-FFF']) {
      await addFlight(input({ registration: reg }));
    }
  }

  it('ticks every affected entry from the start', async () => {
    await sixA320s();
    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');
    await fillMultiPilotOnA320(user);

    const ticks = await screen.findAllByRole('checkbox');
    expect(ticks).toHaveLength(5);
    for (const tick of ticks) expect(tick).toBeChecked();
  });

  it('shows all of the affected entries when the list is opened', async () => {
    await sixA320s();
    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');
    await fillMultiPilotOnA320(user);

    // WHICH of the six is held back is not something to assert on: ids are
    // uuids and `getAllFlights` returns primary-key order, so the sample is
    // five arbitrary entries of the six. Naming one made this test fail in
    // isolation and pass in a full run for two sessions. What the tool actually
    // promises is the COUNT — five until asked, then all of them — and that the
    // one held back is ticked like the rest when it appears.
    const sampled = screen.getAllByRole('checkbox');
    expect(sampled).toHaveLength(5);
    const shown = new Set(sampled.map((tick) => tick.getAttribute('aria-label')));

    await user.click(await screen.findByRole('button', { name: 'Review all 6 entries' }));

    const all = await screen.findAllByRole('checkbox');
    expect(all).toHaveLength(6);
    const held = all.find((tick) => !shown.has(tick.getAttribute('aria-label')));
    expect(held, 'the sixth entry should appear once the list is opened').toBeTruthy();
    expect(held).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(5);
  });

  it('leaves an unticked entry exactly as it was, and changes the rest', async () => {
    await addFlight(input({ registration: 'LN-AAA', totalMinutes: 95 }));
    await addFlight(input({ registration: 'LN-BBB', totalMinutes: 145 }));

    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');
    await fillMultiPilotOnA320(user);

    await user.click(await screen.findByRole('checkbox', { name: /LN-BBB/ }));
    expect(text(await screen.findByRole('status', { name: 'Adjustment summary' }))).toMatch(/1\s*entry will change/);

    await user.click(screen.getByRole('button', { name: 'Apply adjustment' }));
    await user.click(await screen.findByRole('button', { name: 'Change them' }));
    await screen.findByText(/1 entry updated\./);

    const flights = await getAllFlights();
    const byReg = Object.fromEntries(flights.map((f) => [f.registration, f]));
    expect(byReg['LN-AAA'].multiPilotMinutes).toBe(95);
    expect(byReg['LN-BBB'].multiPilotMinutes).toBe(0);
  });

  it('keeps an unticked entry on screen so it can be ticked back on', async () => {
    await addFlight(input({ registration: 'LN-AAA' }));
    await addFlight(input({ registration: 'LN-BBB' }));

    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');
    await fillMultiPilotOnA320(user);

    await user.click(await screen.findByRole('checkbox', { name: /LN-BBB/ }));
    expect(screen.getByRole('checkbox', { name: /LN-BBB/ })).not.toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: /LN-BBB/ }));
    expect(screen.getByRole('checkbox', { name: /LN-BBB/ })).toBeChecked();
    expect(text(await screen.findByRole('status', { name: 'Adjustment summary' }))).toMatch(/2\s*entries will change/);
  });

  it('will not run once everything is unticked, but still shows the entries', async () => {
    await addFlight(input({ registration: 'LN-AAA' }));

    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');
    await fillMultiPilotOnA320(user);

    await user.click(await screen.findByRole('checkbox', { name: /LN-AAA/ }));
    expect(screen.getByRole('button', { name: 'Apply adjustment' })).toBeDisabled();
    expect(text(await screen.findByRole('status', { name: 'Adjustment summary' }))).toMatch(/Nothing will change/);
    expect(screen.getByRole('checkbox', { name: /LN-AAA/ })).toBeTruthy();
  });

  it('ticks everything again when the sentence changes', async () => {
    await addFlight(input({ registration: 'LN-AAA' }));
    await addFlight(input({ registration: 'LN-BBB' }));

    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');
    await fillMultiPilotOnA320(user);

    await user.click(await screen.findByRole('checkbox', { name: /LN-BBB/ }));
    expect(screen.getByRole('checkbox', { name: /LN-BBB/ })).not.toBeChecked();

    // A different column is a different question, so the ticks start over.
    await user.selectOptions(screen.getByLabelText('Time column'), 'ifrMinutes');
    expect(await screen.findByRole('checkbox', { name: /LN-BBB/ })).toBeChecked();
    expect(text(await screen.findByRole('status', { name: 'Adjustment summary' }))).toMatch(/2\s*entries will change/);
  });

  it('says in the confirmation that the unticked entries are left alone', async () => {
    await addFlight(input({ registration: 'LN-AAA' }));
    await addFlight(input({ registration: 'LN-BBB' }));

    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');
    await fillMultiPilotOnA320(user);

    await user.click(await screen.findByRole('checkbox', { name: /LN-BBB/ }));
    await user.click(screen.getByRole('button', { name: 'Apply adjustment' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(text(dialog)).toMatch(/Change 1 entry\?/);
    expect(text(dialog)).toMatch(/1 entry you unticked is not part of this/);
  });

  it('puts every entry back on with Tick all', async () => {
    await addFlight(input({ registration: 'LN-AAA' }));
    await addFlight(input({ registration: 'LN-BBB' }));

    const user = userEvent.setup();
    render(ToolboxPanel, { props: { onBack: noop, onExport: noop } });
    await screen.findByLabelText('Time column');
    await fillMultiPilotOnA320(user);

    await user.click(await screen.findByRole('checkbox', { name: /LN-AAA/ }));
    await user.click(await screen.findByRole('checkbox', { name: /LN-BBB/ }));
    await user.click(await screen.findByRole('button', { name: 'Tick all' }));

    for (const tick of screen.getAllByRole('checkbox')) expect(tick).toBeChecked();
    expect(text(await screen.findByRole('status', { name: 'Adjustment summary' }))).toMatch(/2\s*entries will change/);
  });
});
