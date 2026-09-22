<script lang="ts">
  /**
   * Import from another logbook — a four-step wizard.
   *
   * THE PROMISE: nothing reaches the logbook until the pilot has seen what will
   * happen. Every step is reversible, the preview states what was inferred as
   * well as what was read, and the write happens once, at the end, atomically.
   *
   * This component holds NO import logic. Parsing, mapping, transforming,
   * planning and answering all live in pure modules under `lib/import/`, which
   * is why the hard parts are unit-tested without a browser. What is here is
   * wiring, wording and step state.
   */
  import { onMount } from 'svelte';
  import { parseCsv, type ParsedCsv } from '../import/csv';
  import {
    buildMapping,
    durationSamples,
    mappableFields,
    type ColumnTarget,
    type ImportMapping,
  } from '../import/mapping';
  import { detectPreset, PRESETS } from '../import/presets';
  import { looksLikeAirside } from '../import/airside/format';
  import {
    adaptAirside,
    surveyAirside,
    type AdaptedAirside,
    type AirsideSurvey,
  } from '../import/airside/adapt';
  import { AIRSIDE_PRESET, AIRSIDE_PRESET_ID } from '../import/airside/preset';
  import { loadIataIndex, type IataIndex } from '../airports/iata';
  import { loadAirports, type AirportIndex } from '../airports/lookup';
  import {
    deviceTimeZone,
    isValidTimeZone,
    listTimeZones,
    zoneOffsetOnDate,
  } from '../time/zoneOffset';
  import type { ImportPreset } from '../import/mapping';
  import { buildImportPlan, type ConflictGroup, type PlannedRow } from '../import/plan';
  import { collectAircraftNeeds, type RowEdit } from '../import/transform';
  import { getField } from '../registry/fields';
  import {
    groupAircraftByType,
    resolveAircraft,
    seedAnswers,
    unansweredCount,
    type AircraftAnswers,
  } from '../import/aircraftAnswers';
  import { parseDuration, sniffDurationFormat, type DurationUnit } from '../import/units';
  import { getAllAircraft, importFlights, listFlights, type Flight } from '../storage';
  import type { Aircraft } from '../domain/aircraft';
  import { settings } from '../stores/settings.svelte';
  import { decimalToMinutes, minutesToDecimal } from '../time/duration';
  import {
    UTC_OFFSETS,
    entryLocalToUtc,
    formatOffset,
    formatTimeOfDay,
    parseTimeOfDayInput,
  } from '../time/timeOfDay';

  interface Props {
    onBack: () => void;
    /** Hand the pilot over to Restore when they picked a backup by mistake. */
    onRestore: () => void;
    /** Called after a successful import so the list and counts refresh. */
    onImported?: () => void;
  }

  let { onBack, onRestore, onImported }: Props = $props();

  type Step = 'file' | 'airside' | 'mapping' | 'aircraft' | 'preview' | 'done';

  let step = $state<Step>('file');
  let error = $state('');
  /** Set when the chosen file looks like a backup rather than a spreadsheet. */
  let offerRestore = $state(false);

  /**
   * `$state.raw` throughout for anything that reaches storage.
   *
   * Not a micro-optimisation: plain `$state` deep-PROXIES what it holds, and
   * IndexedDB cannot structured-clone a Proxy — a DataCloneError that no unit
   * test can see. That is exactly how Prompt 3b-1 shipped its only bug. Raw
   * state is also the honest description here: every one of these is replaced
   * wholesale, never mutated in place.
   */
  let file = $state.raw<ParsedCsv | null>(null);
  let fileName = $state('');
  let preset = $state.raw<ImportPreset | undefined>(undefined);
  let targets = $state.raw<ColumnTarget[]>([]);
  let durationUnit = $state<DurationUnit>('minutes');
  let decimalMark = $state<'.' | ','>('.');
  let unitWasGuessed = $state(false);
  /** What the sniff decided, kept so an override can be told from agreement. */
  let sniffedUnit = $state<DurationUnit>('minutes');
  let unitAmbiguous = $state(false);
  let unitSamples = $state.raw<string[]>([]);
  /**
   * The zone this FILE's block times are written in, minutes east of UTC.
   *
   * Starts at UTC, and is never guessed. A duration column can be sniffed
   * because minutes, decimal hours and `hh:mm` have different shapes; `08:00`
   * has the same shape in every zone on Earth, so there is nothing to read. The
   * honest move is to ask once, show what the answer does to a real row, and
   * default to the thing a logbook is supposed to hold.
   */
  let timeZoneOffset = $state(0);

  // --- The Airside step ---------------------------------------------------
  // An Airside export cannot be read as a mapping — one of its columns holds
  // four values, its aerodromes are IATA, its registrations have lost their
  // hyphen and its block times are on two different local clocks. So the file
  // is REWRITTEN first, here, into a plain table the rest of the wizard reads
  // like any other. Everything this step collects is an answer to a question
  // about that rewrite; nothing it does is hidden from the columns step, which
  // shows the rewritten file in full.
  //
  // `$state.raw` for the collections, and every change replaces them whole:
  // mutating a raw Map in place would not re-run the adaptation.

  /** The file as it came off the disk, before adaptation. */
  let airsideFile = $state.raw<ParsedCsv | null>(null);
  let airsideSurvey = $state.raw<AirsideSurvey | null>(null);
  /** Aerodrome code -> IANA zone name. The pilot's answers, not a table. */
  let airsideAnchors = $state.raw<Map<string, string>>(new Map());
  /** Whose zone stands in for a row nothing else could reach. */
  let airsidePrimary = $state('');
  /** Registration prefixes the pilot agrees take a hyphen. */
  let airsideHyphens = $state.raw<Set<string>>(new Set());
  /** Model code -> the ICAO designator to write. */
  let airsideModels = $state.raw<Map<string, string>>(new Map());
  let airsideNight = $state(true);
  /**
   * The airport tables, loaded once and only for an Airside file.
   *
   * A pilot who never imports an airline export never pays for either of them.
   */
  let airsideIndexes = $state.raw<{ iata: IataIndex; airports: AirportIndex } | null>(null);
  let airsideAddCode = $state('');
  let showAllAirports = $state(false);
  let showAssumed = $state(false);

  /** The zone names this browser knows, for the anchor field's suggestions. */
  const TIME_ZONES = listTimeZones();

  let existingFlights = $state.raw<Flight[]>([]);
  let existingAircraft = $state.raw<Aircraft[]>([]);

  /** The answer sheet. Plain `$state` because the form mutates it field by field. */
  let answers = $state<AircraftAnswers>({ byType: {}, typeByRegistration: {} });

  /**
   * Lines left out of the import — the bulk "skip" answer and individually
   * dropped rows alike. One list, because they mean the same thing.
   */
  let skipLines = $state.raw<number[]>([]);
  /** Corrections made in the conflict pause, keyed by source line. */
  let edits = $state.raw<Map<number, RowEdit>>(new Map());
  /** null while the pause is unanswered. */
  let conflictChoice = $state<null | 'skip' | 'anyway'>(null);

  let fileInput = $state<HTMLInputElement | null>(null);
  let showAllColumns = $state(false);
  let busy = $state(false);
  let result = $state.raw<{ flights: number; aircraft: number } | null>(null);

  const FIELD_OPTIONS = mappableFields();

  /**
   * The pilot's clock, for every time this panel SHOWS. It never touches what
   * is read from the file or written to storage — those are always the
   * canonical 24-hour "HH:MM".
   */
  const clock = $derived(settings.clockDisplay);
  /** One stored time, on that clock. */
  const showTime = (value: string) => formatTimeOfDay(value, clock);

  /**
   * How many conflict groups the pause lists before summarising.
   *
   * Re-importing a file already in the logbook produces one group per row —
   * hundreds of them for a real RB export. Listing them all buries the three
   * buttons under a wall of identical lines.
   */
  const MAX_LISTED_CONFLICTS = 15;

  onMount(async () => {
    [existingFlights, existingAircraft] = await Promise.all([listFlights(), getAllAircraft()]);
  });

  /** The live mapping, rebuilt whenever a target or the unit changes. */
  const mapping = $derived<ImportMapping | null>(
    file
      ? {
          targets,
          duration: { unit: durationUnit, decimal: decimalMark },
          timeZoneOffsetMinutes: timeZoneOffset,
          simulatorValues: preset?.simulatorValues ?? ['1', 'fstd', 'sim', 'simulator'],
          presetId: preset?.id,
        }
      : null,
  );

  /** Which columns hold anything at all — the real file has 24 of 105. */
  const columnHasData = $derived.by(() => {
    if (!file) return [];
    const has = new Array(file.headers.length).fill(false);
    for (const row of file.rows) {
      for (let i = 0; i < has.length; i++) if (!has[i] && row.cells[i] !== '') has[i] = true;
    }
    return has;
  });

  const visibleColumns = $derived.by(() => {
    if (!file) return [];
    return file.headers
      .map((header, index) => ({ header, index }))
      .filter(({ index }) => showAllColumns || columnHasData[index]);
  });

  const hiddenColumnCount = $derived(
    file ? file.headers.length - visibleColumns.length : 0,
  );

  /**
   * A real duration value from this file, and what the chosen unit makes of it.
   *
   * Recomputed live as the unit changes, so the pilot sees the consequence of
   * the choice at the moment they make it. Takes the first non-empty cell in a
   * duration-mapped column — a value they can find in their own file.
   */
  const unitExample = $derived.by(() => {
    if (!file || !mapping) return null;
    for (let index = 0; index < mapping.targets.length; index++) {
      const target = mapping.targets[index];
      if (target.kind !== 'field') continue;
      if (getField(target.key)?.type !== 'durationMinutes') continue;
      for (const row of file.rows) {
        const raw = row.cells[index];
        if (!raw) continue;
        const minutes = parseDuration(raw, { unit: durationUnit, decimal: decimalMark });
        if (minutes === null) continue;
        // Always in the app's own display format, so the two readings are
        // directly comparable: "2.3 hours" against "138.0 hours" is a stark
        // difference, where mixing units would bury it.
        return { column: file.headers[index], raw, reading: `${minutesToDecimal(minutes)} hours` };
      }
    }
    return null;
  });

  /**
   * A REAL ROW from this file, and what the chosen zone does to its departure.
   *
   * The same argument as `unitExample` above, applied to the mistake this
   * choice can make. Getting the zone wrong does not produce an obviously
   * absurd number the way the duration unit did — it produces times that are
   * plausibly wrong by an hour or two, and dates that are wrong by one on the
   * sectors that cross midnight. Showing the date moving on a row out of the
   * pilot's own file is the only way that consequence is visible before it is
   * written.
   *
   * Deliberately picks a row with a date AND an off-block: a row missing either
   * would demonstrate nothing.
   */
  const zoneExample = $derived.by(() => {
    if (!file || !mapping) return null;

    const columnFor = (key: string) =>
      mapping.targets.findIndex((t) => t.kind === 'field' && t.key === key);
    const dateColumn = columnFor('date');
    const offColumn = columnFor('offBlock');
    const onColumn = columnFor('onBlock');
    if (dateColumn < 0 || offColumn < 0) return null;

    for (const row of file.rows) {
      const date = (row.cells[dateColumn] ?? '').trim();
      const off = parseTimeOfDayInput(row.cells[offColumn] ?? '');
      if (!date || !off) continue;
      const on = parseTimeOfDayInput(onColumn >= 0 ? (row.cells[onColumn] ?? '') : '') ?? '';
      const utc = entryLocalToUtc({ date, offBlock: off, onBlock: on }, timeZoneOffset);
      return {
        line: row.line,
        raw: `${date} ${off}`,
        stored: `${utc.date} ${utc.offBlock}`,
        dateMoved: utc.date !== date,
      };
    }
    return null;
  });

  /**
   * The rewritten Airside file, recomputed as the answers change.
   *
   * Pure, so the whole Airside step is a view of a function's return value —
   * nothing is decided until the pilot presses Next, and pressing Back and
   * changing an answer re-decides all of it.
   */
  const airsideAdapted = $derived.by<AdaptedAirside | null>(() => {
    const indexes = airsideIndexes;
    if (!airsideFile || !indexes) return null;
    return adaptAirside(
      airsideFile,
      {
        toIcao: (code) => indexes.iata.toIcao(code),
        lookupAirport: (code) => indexes.airports.get(code),
      },
      {
        anchors: airsideAnchors,
        primaryAirport: airsidePrimary || null,
        hyphenPrefixes: airsideHyphens,
        aircraftTypes: airsideModels,
        computeNight: airsideNight,
      },
    );
  });

  /** The zone standing behind every assumed row, for saying so on screen. */
  const airsidePrimaryZone = $derived(
    airsidePrimary ? (airsideAnchors.get(airsidePrimary) ?? '') : '',
  );

  /** Aerodromes in the file that have no zone yet, busiest first. */
  const airsideUnanchored = $derived(
    (airsideSurvey?.airports ?? []).filter((airport) => !airsideAnchors.has(airport.code)),
  );

  /**
   * The rows whose zone had to be assumed, with enough of each to recognise it.
   *
   * Read off the ADAPTED rows, so what is listed is what would be written.
   */
  const airsideAssumedRows = $derived.by(() => {
    const adapted = airsideAdapted;
    if (!adapted) return [];
    const lines = new Set(adapted.report.zonesAssumed);
    return adapted.file.rows
      .filter((row) => lines.has(row.line))
      .map((row) => ({
        line: row.line,
        date: row.cells[1],
        route: `${row.cells[2]}–${row.cells[3]}`,
        offBlock: row.cells[4],
      }));
  });

  /** Cheap: no transform pass, so it can drive the aircraft step directly. */
  const needs = $derived(file && mapping ? collectAircraftNeeds(file.rows, mapping) : []);
  const groups = $derived(groupAircraftByType(needs));
  const stillUnanswered = $derived(unansweredCount(groups, answers));

  /** The confirmed aircraft, as the transform and the write will both see them. */
  const resolvedAircraft = $derived(
    resolveAircraft(needs, answers, settings.defaultAircraftClass),
  );

  /**
   * The dry run.
   *
   * `$derived` is lazy, so this only runs when the preview markup reads it —
   * the aircraft step does not pay for a full transform pass on every keystroke.
   */
  const plan = $derived.by(() => {
    if (!file || !mapping) return null;
    const confirmed = new Map(resolvedAircraft.map((a) => [a.registration, a]));
    return buildImportPlan(
      file,
      mapping,
      {
        aircraft: confirmed,
        fallbackClass: settings.defaultAircraftClass,
        makeId: () => crypto.randomUUID(),
      },
      existingFlights,
      resolvedAircraft,
      { skipLines, edits },
    );
  });

  async function onFileChosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const chosen = input.files?.[0];
    input.value = '';
    if (!chosen) return;

    error = '';
    offerRestore = false;

    let text: string;
    try {
      text = await chosen.text();
    } catch {
      error = 'That file could not be opened.';
      return;
    }

    const parsed = parseCsv(text);
    if (!parsed.ok) {
      error = parsed.rejection.message;
      // The other half of the cross-offer: restore already recognises a
      // spreadsheet and says so. Now each flow can hand the pilot to the other.
      offerRestore = parsed.rejection.code === 'looks-like-json';
      return;
    }

    fileName = chosen.name;

    // Airside is recognised BEFORE `detectPreset`, because it is not a preset:
    // it is a file shape that has to be rewritten before a mapping can describe
    // it at all. See `import/airside/adapt.ts`.
    if (looksLikeAirside(parsed.file.headers)) {
      startAirside(parsed.file);
      return;
    }

    file = parsed.file;
    preset = detectPreset(parsed.file.headers);

    // Build the mapping FIRST, then sniff the duration unit from the columns it
    // marks as durations. Sniffing by header name would pull in "Departure
    // Time" — "08:00" — and judge the whole file to be in hh:mm.
    const provisional = buildMapping(parsed.file.headers, preset, {
      unit: 'minutes',
      decimal: '.',
    });
    const guess = sniffDurationFormat(durationSamples(parsed.file.rows, provisional));
    durationUnit = guess.format.unit;
    sniffedUnit = guess.format.unit;
    decimalMark = guess.format.decimal;
    unitWasGuessed = true;
    unitAmbiguous = guess.ambiguous || guess.mixed;
    unitSamples = guess.samples;
    targets = [...provisional.targets];

    step = 'mapping';
  }

  /**
   * Set up the Airside step from a file that looks like one.
   *
   * Every default here is a SUGGESTION the step then shows: the busiest
   * aerodrome as the anchor, this device's own zone as its zone, the
   * registration prefixes this app is confident about, and the designator each
   * model code usually means. None of them is applied without being on screen
   * with a count beside it.
   */
  function startAirside(parsed: ParsedCsv) {
    const survey = surveyAirside(parsed);
    airsideFile = parsed;
    airsideSurvey = survey;

    const primary = survey.airports[0]?.code ?? '';
    airsidePrimary = primary;
    // The device's zone is a starting point and nothing more. A pilot enters
    // last year's flying from wherever they happen to be, so this is offered
    // where they can see it and change it, never read silently at import time.
    airsideAnchors = new Map(primary ? [[primary, deviceTimeZone() ?? 'UTC']] : []);
    airsideHyphens = new Set(survey.prefixes.filter((p) => p.known).map((p) => p.prefix));
    airsideModels = new Map(survey.models.map((m) => [m.code, m.suggestion]));
    airsideNight = true;
    airsideAddCode = '';
    showAllAirports = false;
    showAssumed = false;
    step = 'airside';

    // Loaded after the step is on screen: the tables are a lazy chunk, and the
    // step is readable while they arrive.
    if (!airsideIndexes) {
      void Promise.all([loadIataIndex(), loadAirports()]).then(([iataIndex, airports]) => {
        airsideIndexes = { iata: iataIndex, airports };
      });
    }
  }

  function setAnchorZone(code: string, zone: string) {
    const next = new Map(airsideAnchors);
    next.set(code, zone.trim());
    airsideAnchors = next;
  }

  function addAnchor() {
    const code = airsideAddCode;
    if (!code) return;
    const next = new Map(airsideAnchors);
    // A new anchor starts on the primary's zone rather than on nothing: most
    // aerodromes a pilot adds are in the zone they already named, and an empty
    // field would look like a question where a confirmation will do.
    next.set(code, airsidePrimaryZone || deviceTimeZone() || 'UTC');
    airsideAnchors = next;
    if (!airsidePrimary) airsidePrimary = code;
    airsideAddCode = '';
  }

  function removeAnchor(code: string) {
    const next = new Map(airsideAnchors);
    next.delete(code);
    airsideAnchors = next;
    if (airsidePrimary === code) airsidePrimary = [...next.keys()][0] ?? '';
  }

  function toggleHyphen(prefix: string) {
    const next = new Set(airsideHyphens);
    if (next.has(prefix)) next.delete(prefix);
    else next.add(prefix);
    airsideHyphens = next;
  }

  function setModelType(code: string, designator: string) {
    const next = new Map(airsideModels);
    next.set(code, designator.trim().toUpperCase());
    airsideModels = next;
  }

  /** A zone's offset on the first day of the file, for labelling the field. */
  function zoneLabel(zone: string): string {
    if (!zone) return 'no zone chosen';
    if (!isValidTimeZone(zone)) return 'not a zone this browser knows';
    const sample = airsideAdapted?.file.rows[0]?.cells[1] ?? '';
    const offset = sample ? zoneOffsetOnDate(zone, sample) : null;
    return offset === null ? 'a zone this browser knows' : `${formatOffset(offset)} on ${sample}`;
  }

  /**
   * Commit the adaptation and carry on into the ordinary wizard.
   *
   * From here the rewritten file is just a file: the columns step lists its
   * thirteen columns, every target is editable, and the plan, the conflict
   * pause and the write are the same code an RB import goes through.
   */
  function goToColumnsFromAirside() {
    const adapted = airsideAdapted;
    if (!adapted) return;

    file = adapted.file;
    preset = AIRSIDE_PRESET;
    const provisional = buildMapping(adapted.file.headers, AIRSIDE_PRESET, {
      unit: 'minutes',
      decimal: '.',
    });
    targets = [...provisional.targets];

    // NOT sniffed. This app wrote these columns, so their unit is known rather
    // than guessed, and offering a guess about a file we produced ourselves
    // would be a question with a right answer already in hand.
    durationUnit = 'minutes';
    sniffedUnit = 'minutes';
    decimalMark = '.';
    unitWasGuessed = false;
    unitAmbiguous = false;
    unitSamples = [];

    // The zone question is already answered, per aerodrome and per date, by the
    // Airside step. A second file-wide offset on top of that would shift every
    // row a second time.
    timeZoneOffset = 0;

    step = 'mapping';
  }

  function goToAircraft() {
    answers = seedAnswers(groups, existingAircraft, settings.defaultAircraftClass);
    step = 'aircraft';
  }

  function setTarget(index: number, value: string) {
    const next = [...targets];
    if (value === '__ignore') next[index] = { kind: 'ignore' };
    else if (value === '__extra') next[index] = { kind: 'extra', key: file?.headers[index] ?? '' };
    else if (value.startsWith('role:')) {
      next[index] = { kind: 'role', role: value.slice(5) as 'entryTypeDiscriminator' | 'aircraftIdentifier' };
    } else next[index] = { kind: 'field', key: value };
    targets = next;
  }

  function targetValue(target: ColumnTarget): string {
    if (target.kind === 'ignore') return '__ignore';
    if (target.kind === 'extra') return '__extra';
    if (target.kind === 'role') return `role:${target.role}`;
    return target.key;
  }

  function chooseSkip() {
    skipLines = plan ? plan.conflicts.flatMap((group) => group.lines) : [];
    conflictChoice = 'skip';
  }

  function chooseAnyway() {
    conflictChoice = 'anyway';
  }

  // --- Fixing a conflict in place -----------------------------------------
  // The pause is the place where the pilot has the most context about a
  // problem, so it is the place to fix it. Both actions here are reversible and
  // neither writes anything: dropping a row excludes it from the plan, and
  // editing one changes the record the plan is computed from. The conflict list
  // recomputes either way, so a fixed overlap disappears as soon as it is fixed.

  /** Drop one row from the import, or put it back. */
  function toggleDropped(line: number) {
    skipLines = skipLines.includes(line)
      ? skipLines.filter((l) => l !== line)
      : [...skipLines, line];
  }

  /** Which row's editor is open, by source line. Only one at a time. */
  let editingLine = $state<number | null>(null);
  /** The in-progress values, as strings so a half-typed field is not destructive. */
  let draft = $state({ date: '', offBlock: '', onBlock: '', total: '' });

  function openEditor(row: PlannedRow) {
    editingLine = row.line;
    draft = {
      date: row.record.date,
      // On the pilot's clock, matching the row they are looking at. `applyEdit`
      // normalises whatever comes back, so a 12-hour reading round-trips.
      offBlock: showTime(row.record.offBlock),
      onBlock: showTime(row.record.onBlock),
      total: minutesToDecimal(row.record.totalMinutes),
    };
  }

  function cancelEdit() {
    editingLine = null;
  }

  /**
   * Commit the draft as a `RowEdit`.
   *
   * The total is entered in decimal hours because that is what the rest of the
   * app shows, and converted here — the same conversion the entry form uses.
   * An unparseable total is left out of the edit rather than written as NaN, so
   * the worst case is that one field does not change.
   */
  function applyEdit(line: number) {
    const total = Number(draft.total.replace(',', '.'));
    // Normalised the same way a cell from the file is, so "2130" and "9:30 PM"
    // both land as "21:30". A time this cannot read is left out of the edit
    // entirely — the row keeps what the file gave it and stays in the pause,
    // which is better than replacing a wrong value with an unreadable one.
    const offBlock = parseTimeOfDayInput(draft.offBlock);
    const onBlock = parseTimeOfDayInput(draft.onBlock);
    // An EMPTY field means "leave this one as the file had it", never "blank
    // it". None of these may legitimately be empty on a flight, so writing an
    // empty string would only ever invalidate a row the pilot was trying to
    // rescue — and the message they would get back is about a required field
    // rather than about the edit they just made.
    const edit: RowEdit = {
      ...(draft.date.trim() ? { date: draft.date.trim() } : {}),
      ...(offBlock ? { offBlock } : {}),
      ...(onBlock ? { onBlock } : {}),
      ...(draft.total.trim() !== '' && Number.isFinite(total)
        ? { totalMinutes: decimalToMinutes(total) }
        : {}),
    };
    const next = new Map(edits);
    next.set(line, edit);
    edits = next;
    editingLine = null;
  }

  /** Undo a correction, putting the row back to what the file said. */
  function revertEdit(line: number) {
    const next = new Map(edits);
    next.delete(line);
    edits = next;
    if (editingLine === line) editingLine = null;
  }

  /** The stored flight behind an id, for showing what an imported row clashed with. */
  function storedFlight(id: string): Flight | undefined {
    return existingFlights.find((flight) => flight.id === id);
  }

  /** The planned rows of one conflict group, in file order. */
  function rowsOf(group: ConflictGroup): PlannedRow[] {
    if (!plan) return [];
    return group.lines
      .map((line) => plan.rows.find((row) => row.line === line))
      .filter((row): row is PlannedRow => row !== undefined);
  }

  async function confirmImport() {
    if (!plan || busy) return;
    busy = true;
    error = '';

    // Belt to the `$state.raw` braces: hand storage plain objects, never
    // reactive ones. Unproxying is a Svelte concern, so it happens here rather
    // than inside the storage layer.
    const outcome = await importFlights({
      flights: plan.rows.map((row) => row.record),
      aircraft: $state.snapshot(resolvedAircraft) as Aircraft[],
    });

    busy = false;
    if (!outcome.ok) {
      error = outcome.error ?? 'Import failed and nothing was added.';
      return;
    }
    result = { flights: outcome.flightCount, aircraft: outcome.aircraftCount };
    step = 'done';
    onImported?.();
  }

  function startOver() {
    file = null;
    fileName = '';
    preset = undefined;
    targets = [];
    // The Airside answers were about the OLD file. The loaded airport tables
    // are not: they are the same tables whatever the file, so they stay.
    airsideFile = null;
    airsideSurvey = null;
    airsideAnchors = new Map();
    airsidePrimary = '';
    airsideHyphens = new Set();
    airsideModels = new Map();
    airsideNight = true;
    airsideAddCode = '';
    answers = { byType: {}, typeByRegistration: {} };
    // Back to UTC: the zone was an answer about the OLD file, and carrying it
    // onto a new one would apply a correction nobody asked for again.
    timeZoneOffset = 0;
    skipLines = [];
    edits = new Map();
    editingLine = null;
    conflictChoice = null;
    result = null;
    error = '';
    offerRestore = false;
    step = 'file';
  }

  const STEP_LABELS: Record<Exclude<Step, 'done'>, string> = {
    file: 'File',
    airside: 'Airside',
    mapping: 'Columns',
    aircraft: 'Aircraft',
    preview: 'Review',
  };
  /** The Airside step only appears for a file that needs it. */
  const STEP_ORDER = $derived<Exclude<Step, 'done'>[]>(
    airsideFile
      ? ['file', 'airside', 'mapping', 'aircraft', 'preview']
      : ['file', 'mapping', 'aircraft', 'preview'],
  );
</script>

<section class="import-view">
  <header class="bar">
    <button type="button" class="btn ghost back" onclick={onBack}>← Back</button>
    <h1>Import a logbook</h1>
    <span class="spacer"></span>
  </header>

  <div class="body">
    {#if step !== 'done'}
      <ol class="steps" aria-label="Import progress">
        {#each STEP_ORDER as name, i (name)}
          <li
            class:current={step === name}
            class:past={STEP_ORDER.indexOf(step as Exclude<Step, 'done'>) > i}
            aria-current={step === name ? 'step' : undefined}
          >
            <span class="num">{i + 1}</span>{STEP_LABELS[name]}
          </li>
        {/each}
      </ol>
    {/if}

    {#if error}
      <p class="msg error" role="alert">{error}</p>
      {#if offerRestore}
        <div class="offer">
          <p>
            That looks like a backup file this app wrote. Restoring is a different
            job: it <strong>replaces</strong> your logbook rather than adding to it.
          </p>
          <button type="button" class="btn primary" onclick={onRestore}>
            Go to Restore from backup
          </button>
        </div>
      {/if}
    {/if}

    <!-- ── Step 1 — the file ─────────────────────────────────────────────── -->
    {#if step === 'file'}
      <section class="card">
        <h2>Choose a CSV file</h2>
        <p class="desc">
          A CSV exported from another logbook app. This <strong>adds</strong> to your
          logbook; nothing already in it is changed or removed.
        </p>
        <p class="desc">
          Nothing is written until you have seen exactly what will be imported.
        </p>
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          class="visually-hidden"
          bind:this={fileInput}
          onchange={onFileChosen}
        />
        <button type="button" class="btn primary" onclick={() => fileInput?.click()}>
          Choose file…
        </button>
        <p class="note">
          Formats recognised automatically:
          {[...PRESETS.map((p) => p.label), AIRSIDE_PRESET.label].join(', ')}. Any other CSV
          can be mapped by hand in the next step.
        </p>
      </section>
    {/if}

    <!-- ── The Airside step — only for a file that needs rewriting ───────── -->
    {#if step === 'airside' && airsideFile && airsideSurvey}
      <section class="card">
        <h2>This is an Airside export</h2>
        <p class="desc">
          <strong>{fileName}</strong> — {airsideFile.rows.length}
          {airsideFile.rows.length === 1 ? 'row' : 'rows'}. Airside packs four values into
          its <strong>Flight</strong> column, names aerodromes by their three-letter IATA
          code, writes registrations without their hyphen, and records block times on
          <strong>local clocks</strong>. Those all have to be unpacked before the columns
          can mean anything, so this step is where you check the unpacking.
        </p>
        <p class="desc">
          Nothing is written here. The next step shows you the rewritten file, column by
          column, and you can come back and change any of this.
        </p>
        {#if !airsideIndexes}
          <p class="hint">Loading the aerodrome list…</p>
        {/if}
      </section>

      <!--
        THE ZONE. This is the only genuinely hard question in the format, and it
        cannot be answered once for the whole file: a Scandinavian short-haul
        year touches four different offsets and moves between them twice a year.

        What makes one answer enough is that the file states its own totals. The
        gap between the naive interval and the total IS the difference between
        the two aerodromes' offsets, so naming the zone of ONE aerodrome solves
        every sector that touches it — and the far ends of those sectors are
        then known for those dates, which solves more. What is left over is
        counted and listed rather than quietly assumed.
      -->
      <section class="card" aria-labelledby="airside-zones">
        <h2 id="airside-zones">Which clock the times are on</h2>
        <p class="desc">
          Name the time zone of an aerodrome you fly from and this works the rest out from
          the file's own numbers — the difference between each row's block times and its
          total flight time is the difference between the two aerodromes' zones. Add more
          aerodromes to cover more of the file.
        </p>

        <ul class="anchors">
          {#each [...airsideAnchors] as [code, zone] (code)}
            <li>
              <span class="code">{code}</span>
              <label class="grow">
                <span class="visually-hidden">Time zone for {code}</span>
                <input
                  type="text"
                  list="airside-zone-names"
                  value={zone}
                  spellcheck="false"
                  autocapitalize="off"
                  autocomplete="off"
                  oninput={(e) => setAnchorZone(code, e.currentTarget.value)}
                />
              </label>
              <span class="zone-note" class:warn={!isValidTimeZone(zone)}>{zoneLabel(zone)}</span>
              <label class="primary-pick">
                <input
                  type="radio"
                  name="airside-primary"
                  checked={airsidePrimary === code}
                  onchange={() => (airsidePrimary = code)}
                />
                stand-in
              </label>
              <button
                type="button"
                class="btn ghost small"
                onclick={() => removeAnchor(code)}
                aria-label={`Remove ${code}`}>Remove</button
              >
            </li>
          {/each}
        </ul>
        <datalist id="airside-zone-names">
          {#each TIME_ZONES as zone (zone)}<option value={zone}></option>{/each}
        </datalist>

        {#if airsideUnanchored.length > 0}
          <div class="add-anchor">
            <label>
              Add an aerodrome
              <select bind:value={airsideAddCode}>
                <option value="">Choose…</option>
                {#each airsideUnanchored.slice(0, showAllAirports ? undefined : 12) as airport (airport.code)}
                  <option value={airport.code}>
                    {airport.code} — {airport.count}
                    {airport.count === 1 ? 'sector' : 'sectors'}
                  </option>
                {/each}
              </select>
            </label>
            <button type="button" class="btn" disabled={!airsideAddCode} onclick={addAnchor}>
              Add
            </button>
            {#if airsideUnanchored.length > 12}
              <button
                type="button"
                class="btn ghost small"
                onclick={() => (showAllAirports = !showAllAirports)}
              >
                {showAllAirports ? 'Show the busiest 12' : `Show all ${airsideUnanchored.length}`}
              </button>
            {/if}
          </div>
        {/if}

        {#if airsideAdapted}
          {@const report = airsideAdapted.report}
          <p class="hint" class:warn={report.zonesAssumed.length > 0}>
            <strong>{report.zonesResolved}</strong> of {report.zoneRowsRead} rows worked out
            exactly.
            {#if report.zonesAssumed.length === 0}
              Nothing had to be assumed.
            {:else if airsidePrimaryZone}
              The other {report.zonesAssumed.length} will be read as
              <strong>{airsidePrimaryZone}</strong>. Adding one more aerodrome usually
              clears most of them.
            {:else}
              The other {report.zonesAssumed.length} have no zone to fall back on and will
              be read as UTC.
            {/if}
          </p>

          {#if report.zonesAssumed.length > 0}
            <button
              type="button"
              class="btn ghost small"
              onclick={() => (showAssumed = !showAssumed)}
            >
              {showAssumed ? 'Hide them' : `Show the ${report.zonesAssumed.length} assumed`}
            </button>
            {#if showAssumed}
              <!--
                Named, not merely counted. A row this step had to guess about
                must never be indistinguishable from one it worked out, and
                these are also written to the record under "Zone Assumed" so
                the list survives the import.
              -->
              <ul class="assumed">
                {#each airsideAssumedRows as row (row.line)}
                  <li>
                    <span class="line">Line {row.line}</span>
                    <span>{row.date}</span>
                    <span>{row.route}</span>
                    <span>{showTime(row.offBlock)}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}

          {#if report.zones.contradictions.length > 0}
            <p class="hint warn">
              The file gives two different offsets for
              {report.zones.contradictions.join(', ')} on one day. The first reading was
              kept — worth a look at those rows afterwards.
            </p>
          {/if}
          {#if report.zones.oddGapLines.length > 0}
            <p class="hint warn">
              {report.zones.oddGapLines.length}
              {report.zones.oddGapLines.length === 1 ? 'row' : 'rows'} have block times and
              a total that no pair of time zones could explain. Their times are still read,
              but nothing else is worked out from them.
            </p>
          {/if}
        {/if}
      </section>

      <!-- The aerodromes, the registrations and the models: three transforms,
           each stated with the count it affects. -->
      <section class="card" aria-labelledby="airside-values">
        <h2 id="airside-values">What the columns will be turned into</h2>

        <h3>Aerodromes</h3>
        {#if airsideAdapted}
          {@const unresolved = airsideAdapted.report.unresolvedCodes}
          <p class="hint" class:warn={unresolved.length > 0}>
            {airsideSurvey.airports.length - unresolved.length} of
            {airsideSurvey.airports.length} IATA codes matched an ICAO code.
            {#if unresolved.length > 0}
              These did not, and will be imported as written:
              <strong>{unresolved.join(', ')}</strong>. Night time is still worked out for
              them — the aerodrome list knows where they are.
            {/if}
          </p>
        {/if}

        <h3>Registrations</h3>
        <p class="desc">
          Airside writes <strong>SEXYZ</strong> where the aircraft is
          <strong>SE-XYZ</strong>. Where the hyphen goes depends on the country, so only
          prefixes this app is sure of are ticked — anything else is left exactly as
          written.
        </p>
        <ul class="prefixes">
          {#each airsideSurvey.prefixes as prefix (prefix.prefix)}
            <li>
              <label>
                <input
                  type="checkbox"
                  checked={airsideHyphens.has(prefix.prefix)}
                  onchange={() => toggleHyphen(prefix.prefix)}
                />
                <span class="code">{prefix.example}</span>
                →
                <span class="code"
                  >{airsideHyphens.has(prefix.prefix)
                    ? `${prefix.prefix}-${prefix.example.slice(prefix.prefix.length)}`
                    : prefix.example}</span
                >
                <span class="count">
                  {prefix.count}
                  {prefix.count === 1 ? 'flight' : 'flights'}
                  {#if !prefix.known}— this app is not sure about this one{/if}
                </span>
              </label>
            </li>
          {/each}
        </ul>
        {#if airsideSurvey.unrecognisedRegistrations.length > 0}
          <p class="hint">
            {airsideSurvey.unrecognisedRegistrations.length} registrations carry no prefix
            this app recognises and are left exactly as written:
            {airsideSurvey.unrecognisedRegistrations.slice(0, 8).join(', ')}{airsideSurvey
              .unrecognisedRegistrations.length > 8
              ? '…'
              : ''}
          </p>
        {/if}

        <h3>Aircraft types</h3>
        <p class="desc">
          Airside writes the airline's own model code. The logbook wants an ICAO type
          designator, and it decides how each flight's time is filed — so these are worth
          a look.
        </p>
        <ul class="models">
          {#each airsideSurvey.models as model (model.code)}
            <li>
              <span class="code">{model.code}</span>
              →
              <label>
                <span class="visually-hidden">Type designator for {model.code}</span>
                <input
                  type="text"
                  class="designator"
                  value={airsideModels.get(model.code) ?? model.suggestion}
                  spellcheck="false"
                  autocapitalize="characters"
                  oninput={(e) => setModelType(model.code, e.currentTarget.value)}
                />
              </label>
              <span class="count">
                {model.count}
                {model.count === 1 ? 'flight' : 'flights'}
              </span>
            </li>
          {/each}
        </ul>
      </section>

      <!--
        NIGHT. Airside has no night column at all, so importing without this
        would put several hundred sectors in the logbook reading zero — and the
        toolbox's night tool, which could fill them in afterwards, deliberately
        never touches the landing columns. Doing it here is the only place both
        halves of the answer can be given at once.
      -->
      <section class="card" aria-labelledby="airside-night">
        <h2 id="airside-night">Night time</h2>
        <p class="desc">
          Airside records no night time. This app can work it out from the route and the
          clock — the same calculation the entry form uses — and put each landing in the
          Day or Night column accordingly.
        </p>
        <label class="toggle">
          <input type="checkbox" bind:checked={airsideNight} />
          Work out night time and place the landings
        </label>
        {#if airsideAdapted}
          {@const report = airsideAdapted.report}
          {#if airsideNight}
            <p class="hint">
              {report.nightRows} of {report.rowsRead} rows worked out, adding
              <strong>{minutesToDecimal(report.nightMinutes)} hours</strong> of night time.
              {report.nightLandings}
              {report.nightLandings === 1 ? 'landing goes' : 'landings go'} in the night
              column.
            </p>
            {#if report.unplacedLandings > 0}
              <p class="hint warn">
                {report.unplacedLandings}
                {report.unplacedLandings === 1 ? 'landing' : 'landings'} could not be worked
                out and will be logged as day landings.
                {#if report.nightMissingAerodromes.length > 0}
                  Not in the aerodrome list: {report.nightMissingAerodromes.join(', ')}.
                {/if}
              </p>
            {/if}
          {:else}
            <p class="hint">
              Every flight will be imported with no night time, and every landing in the
              Day column. The toolbox can fill the night time in afterwards, but it does
              not move landings.
            </p>
          {/if}
        {/if}
      </section>

      {#if airsideAdapted && (airsideAdapted.report.dateShifted > 0 || airsideAdapted.report.scheduleMismatch.length > 0 || airsideAdapted.report.unreadableLines.length > 0)}
        <section class="card">
          <h2>Worth knowing about this file</h2>
          <ul class="statements">
            {#if airsideAdapted.report.dateShifted > 0}
              <li>
                {airsideAdapted.report.dateShifted}
                {airsideAdapted.report.dateShifted === 1 ? 'flight departs' : 'flights depart'}
                after local midnight and will be logged on the previous day, because the
                logbook's date is the UTC date of the off-block.
              </li>
            {/if}
            {#if airsideAdapted.report.scheduleMismatch.length > 0}
              <li>
                On {airsideAdapted.report.scheduleMismatch.length}
                {airsideAdapted.report.scheduleMismatch.length === 1 ? 'row' : 'rows'} the
                date inside the flight number is not the departure date — a delayed
                departure. The <strong>Departure Date</strong> column is used, because that
                is what actually happened.
              </li>
            {/if}
            {#if airsideAdapted.report.unreadableLines.length > 0}
              <li>
                {airsideAdapted.report.unreadableLines.length}
                {airsideAdapted.report.unreadableLines.length === 1 ? 'row has' : 'rows have'}
                a Flight column this app could not read, so it has no route. Those rows go
                through and are listed as errors in the review step rather than dropped
                here.
              </li>
            {/if}
          </ul>
        </section>
      {/if}

      <div class="wizard-actions">
        <button type="button" class="btn ghost" onclick={startOver}>Choose another file</button>
        <button
          type="button"
          class="btn primary"
          disabled={!airsideAdapted}
          onclick={goToColumnsFromAirside}
        >
          Next: columns
        </button>
      </div>
    {/if}

    <!-- ── Step 2 — the columns ──────────────────────────────────────────── -->
    {#if step === 'mapping' && file}
      <section class="card">
        <h2>What the columns mean</h2>
        <p class="desc">
          <strong>{fileName}</strong> — {file.rows.length}
          {file.rows.length === 1 ? 'row' : 'rows'}, {file.headers.length} columns.
          {#if preset}
            Recognised as <strong>{preset.label}</strong>.
          {:else}
            No known format matched, so the columns below were guessed by name.
          {/if}
        </p>

        {#if preset?.notes}
          <ul class="notes">
            {#each preset.notes as note (note)}<li>{note}</li>{/each}
          </ul>
        {/if}

        {#if file.issues.length > 0}
          <ul class="notes warn">
            {#each file.issues.slice(0, 5) as issue (issue.message)}<li>{issue.message}</li>{/each}
          </ul>
        {/if}

        <div class="unit-row">
          <label>
            Durations in this file are
            <select bind:value={durationUnit}>
              <option value="minutes">whole minutes (138)</option>
              <option value="decimalHours">decimal hours (2.3)</option>
              <option value="hhmm">hours and minutes (2:18)</option>
            </select>
          </label>
          {#if durationUnit === 'decimalHours'}
            <label>
              decimal mark
              <select bind:value={decimalMark}>
                <option value=".">point (2.3)</option>
                <option value=",">comma (2,3)</option>
              </select>
            </label>
          {/if}
        </div>
        <!--
          A WORKED EXAMPLE from this file, recomputed as the unit changes.
          Abstract labels are not enough: a pilot picked "decimal hours" for a
          file of whole minutes and imported tens of thousands of hours. Showing what a real
          value from their own file becomes puts the consequence in front of the
          choice rather than four screens after it.
        -->
        {#if unitExample}
          <p class="hint" class:warn={unitAmbiguous}>
            <strong>{unitExample.column} “{unitExample.raw}”</strong> will be read as
            <strong>{unitExample.reading}</strong>.
            {#if unitAmbiguous}
              This file does not say which unit it uses — please check.
            {:else if unitWasGuessed && durationUnit === sniffedUnit}
              Worked out from values like {unitSamples.join(', ')}.
            {/if}
          </p>
        {/if}

        <!--
          The zone, asked in the same breath as the unit and for the same
          reason: both are things about SOMEONE ELSE'S FILE that this app cannot
          know, and both are catastrophic to guess wrong in silence. The
          difference is that the unit can be sniffed and this cannot, so it is
          asked outright rather than proposed.

          NOT ASKED FOR AN AIRSIDE FILE. Its times are on a different local
          clock per row, which one file-wide offset cannot express and the
          Airside step has already answered per aerodrome and per date. Asking
          again here would offer a way to shift every row a second time.
        -->
        {#if preset?.id === AIRSIDE_PRESET_ID}
          <p class="hint">
            Block times were converted to UTC in the Airside step, aerodrome by aerodrome.
            <button type="button" class="linkish" onclick={() => (step = 'airside')}>
              Go back to change that
            </button>
          </p>
        {:else}
        <div class="unit-row">
          <label>
            Block times in this file are in
            <select bind:value={timeZoneOffset}>
              {#each UTC_OFFSETS as offset (offset)}
                <option value={offset}>
                  {offset === 0 ? 'UTC (Zulu)' : `local time — ${formatOffset(offset)}`}
                </option>
              {/each}
            </select>
          </label>
        </div>
        {/if}
        {#if zoneExample && preset?.id !== AIRSIDE_PRESET_ID}
          <p class="hint" class:warn={zoneExample.dateMoved}>
            {#if timeZoneOffset === 0}
              Row {zoneExample.line} departs <strong>{zoneExample.raw}</strong> and will be stored
              exactly so. Most logbooks record UTC — if yours records local time, say which zone
              above.
            {:else}
              Row {zoneExample.line} departs <strong>{zoneExample.raw}</strong> local and will be
              stored as <strong>{zoneExample.stored}</strong> UTC.
              {#if zoneExample.dateMoved}
                Note the date: this sector crosses midnight in UTC.
              {/if}
            {/if}
          </p>
        {/if}
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Columns</h2>
          <button type="button" class="btn ghost small" onclick={() => (showAllColumns = !showAllColumns)}>
            {showAllColumns ? 'Show only columns with data' : `Show all ${file.headers.length}`}
          </button>
        </div>
        {#if hiddenColumnCount > 0}
          <p class="hint">
            {hiddenColumnCount} empty {hiddenColumnCount === 1 ? 'column is' : 'columns are'} hidden.
          </p>
        {/if}

        <ul class="cols">
          {#each visibleColumns as { header, index } (index)}
            <li>
              <span class="col-name" title={header}>{header || `Column ${index + 1}`}</span>
              <select
                aria-label={`What ${header || `column ${index + 1}`} means`}
                value={targetValue(targets[index])}
                onchange={(e) => setTarget(index, e.currentTarget.value)}
              >
                <option value="__ignore">Ignore</option>
                <option value="__extra">Keep as extra info</option>
                <option value="role:entryTypeDiscriminator">Flight or simulator</option>
                <option value="role:aircraftIdentifier">Registration / device id</option>
                {#each FIELD_OPTIONS as field (field.key)}
                  <option value={field.key}>{field.label}</option>
                {/each}
              </select>
            </li>
          {/each}
        </ul>
      </section>

      <div class="wizard-actions">
        {#if airsideFile}
          <button type="button" class="btn ghost" onclick={() => (step = 'airside')}>Back</button>
        {:else}
          <button type="button" class="btn ghost" onclick={startOver}>Choose another file</button>
        {/if}
        <button type="button" class="btn primary" onclick={goToAircraft}>Next: aircraft</button>
      </div>
    {/if}

    <!-- ── Step 3 — the aircraft ─────────────────────────────────────────── -->
    {#if step === 'aircraft'}
      <section class="card">
        <h2>The aircraft in this file</h2>
        <p class="desc">
          Single- or multi-engine, and whether the aircraft is flown by two pilots.
          This is what decides how each flight's time is filed, so it is worth a
          look. Your answers are remembered for next time.
        </p>

        <ul class="types">
          {#each groups.filter((g) => g.type !== '') as group (group.type)}
            <li>
              <div class="type-head">
                <strong>{group.type}</strong>
                <span class="dim">
                  {group.registrations.length}
                  {group.registrations.length === 1 ? 'aircraft' : 'aircraft'}, {group.rowCount}
                  {group.rowCount === 1 ? 'flight' : 'flights'}
                </span>
              </div>
              <div class="type-controls">
                <label>
                  <span class="sr-only">Engines for {group.type}</span>
                  <select bind:value={answers.byType[group.type].class}>
                    <option value="SE">Single-engine</option>
                    <option value="ME">Multi-engine</option>
                  </select>
                </label>
                <label class="check">
                  <input type="checkbox" bind:checked={answers.byType[group.type].multiPilot} />
                  Multi-pilot
                </label>
              </div>
            </li>
          {/each}
        </ul>
      </section>

      {#if groups.some((g) => g.type === '')}
        <section class="card needs-answer">
          <h2>These have no aircraft type</h2>
          <p class="desc">
            The file gives no type for {groups.find((g) => g.type === '')?.registrations.length}
            {groups.find((g) => g.type === '')?.registrations.length === 1 ? 'aircraft' : 'aircraft'}.
            Without one their flights cannot be imported — they will be listed as
            left out, and nothing else is affected.
          </p>
          <ul class="untyped">
            {#each groups.find((g) => g.type === '')?.registrations ?? [] as registration (registration)}
              <li>
                <span class="reg">{registration}</span>
                <input
                  type="text"
                  placeholder="e.g. C172"
                  aria-label={`Aircraft type for ${registration}`}
                  bind:value={answers.typeByRegistration[registration]}
                />
              </li>
            {/each}
          </ul>
          {#if stillUnanswered > 0}
            <p class="hint warn">
              {stillUnanswered}
              {stillUnanswered === 1 ? 'aircraft' : 'aircraft'} still without a type.
            </p>
          {/if}
        </section>
      {/if}

      <div class="wizard-actions">
        <button type="button" class="btn ghost" onclick={() => (step = 'mapping')}>Back</button>
        <button type="button" class="btn primary" onclick={() => (step = 'preview')}>
          Next: review
        </button>
      </div>
    {/if}

    <!-- ── Step 4 — the review ───────────────────────────────────────────── -->
    {#if step === 'preview' && plan}
      <!--
        The duration-unit guard, ABOVE everything else and before the conflict
        pause, because it invalidates every other number on the screen. A file
        of whole minutes read as decimal hours imports a whole logbook as
        tens of thousands of hours, and until this existed the preview reported that figure
        without comment.
      -->
      {#if plan.durationCheck.suggestion}
        <section class="card danger-card" aria-labelledby="duration-heading">
          <h2 id="duration-heading">These durations cannot be right</h2>
          <p class="desc">
            The times being imported disagree with the file's own block times by
            a factor of about <strong>{Math.round(plan.durationCheck.ratio ?? 0)}</strong>.
            Checked across {plan.durationCheck.comparable}
            {plan.durationCheck.comparable === 1 ? 'flight' : 'flights'} that carry both.
          </p>
          <p class="desc">
            As read now, this file adds
            <strong>{minutesToDecimal(plan.counts.flightMinutes)} hours</strong> of flight
            time. The block times say it should be roughly
            <strong>
              {minutesToDecimal(
                Math.round(plan.counts.flightMinutes / (plan.durationCheck.ratio || 1)),
              )} hours
            </strong>.
          </p>
          <p class="desc">
            The duration unit is almost certainly wrong. This file looks like it
            holds
            <strong>
              {plan.durationCheck.suggestion === 'minutes' ? 'whole minutes' : 'decimal hours'}
            </strong>.
          </p>
          <div class="wizard-actions">
            <!-- svelte-ignore a11y_autofocus -->
            <button
              type="button"
              class="btn primary"
              autofocus
              onclick={() => {
                durationUnit = plan!.durationCheck.suggestion!;
                step = 'mapping';
              }}
            >
              Set it to {plan.durationCheck.suggestion === 'minutes' ? 'whole minutes' : 'decimal hours'}
            </button>
            <button type="button" class="btn ghost" onclick={() => (step = 'mapping')}>
              Back to the columns
            </button>
          </div>
          <p class="note">
            Nothing has been written. If you are certain the file really is in
            these units, go back and continue from the columns step — but a
            logbook this size holding {minutesToDecimal(plan.counts.flightMinutes)} hours
            would be about {Math.round(plan.counts.flightMinutes / 60 / 24 / 365)} years of
            continuous flying.
          </p>
        </section>
      {:else if plan.conflicts.length > 0 && conflictChoice === null}
        <section class="card danger-card" aria-labelledby="conflict-heading">
          <h2 id="conflict-heading">Some of these flights overlap in time</h2>
          <p class="desc">
            A pilot cannot be in two places at once, so at least one entry in each
            group below is wrong. These are real errors — either in this file or in
            what you already have.
          </p>
          <!--
            Each group shows the FLIGHTS, not just their line numbers, because
            an overlap is only fixable if you can see what overlapped. Every
            imported row carries its own two ways out — correct it, or leave it
            out — and neither writes anything: the plan is recomputed from the
            corrections, so a fixed overlap leaves this list as soon as it is
            fixed.

            Capped, and that is not cosmetic. Re-importing a file already in the
            logbook produces one group per row — hundreds of them for a real export
            — which would bury the buttons under a wall of identical entries.
          -->
          <ol class="conflicts">
            {#each plan.conflicts.slice(0, MAX_LISTED_CONFLICTS) as group (group.lines[0])}
              <li>
                <p class="group-summary">{group.summary}</p>

                <ul class="flights">
                  {#each rowsOf(group) as row (row.line)}
                    <li class="flight" class:edited={row.edited}>
                      <div class="flight-main">
                        <span class="src">Line {row.line}</span>
                        <span class="when">{row.record.date}</span>
                        <span class="route">
                          {row.record.depAerodrome}→{row.record.arrAerodrome}
                        </span>
                        <span class="times">{showTime(row.record.offBlock)}–{showTime(row.record.onBlock)}</span>
                        <span class="reg">{row.record.registration}</span>
                        <span class="dur">{minutesToDecimal(row.record.totalMinutes)}</span>
                      </div>

                      {#if editingLine === row.line}
                        <div class="editor">
                          <label>
                            Date
                            <input type="date" bind:value={draft.date} aria-label={`Date for line ${row.line}`} />
                          </label>
                          <label>
                            Off block
                            <input
                              type="text"
                              inputmode="numeric"
                              placeholder={clock === '12h' ? '11:36 PM' : '23:36'}
                              bind:value={draft.offBlock}
                              aria-label={`Off block for line ${row.line}`}
                            />
                          </label>
                          <label>
                            On block
                            <input
                              type="text"
                              inputmode="numeric"
                              placeholder={clock === '12h' ? '11:36 PM' : '23:36'}
                              bind:value={draft.onBlock}
                              aria-label={`On block for line ${row.line}`}
                            />
                          </label>
                          <label>
                            Total
                            <input
                              type="text"
                              inputmode="decimal"
                              bind:value={draft.total}
                              aria-label={`Total time for line ${row.line}`}
                            />
                          </label>
                          <div class="editor-actions">
                            <button type="button" class="btn primary small" onclick={() => applyEdit(row.line)}>
                              Save correction
                            </button>
                            <button type="button" class="btn ghost small" onclick={cancelEdit}>Cancel</button>
                          </div>
                        </div>
                      {:else}
                        <div class="flight-actions">
                          <button type="button" class="btn ghost small" onclick={() => openEditor(row)}>
                            {row.edited ? 'Edit again' : 'Correct times'}
                          </button>
                          {#if row.edited}
                            <button type="button" class="btn ghost small" onclick={() => revertEdit(row.line)}>
                              Undo correction
                            </button>
                          {/if}
                          <button type="button" class="btn ghost small danger-text" onclick={() => toggleDropped(row.line)}>
                            Leave this one out
                          </button>
                        </div>
                      {/if}
                    </li>
                  {/each}

                  <!--
                    Flights already in the logbook. Shown so the clash is
                    legible, but READ-ONLY: they are not part of this import, and
                    editing them here would be an immediate write outside the
                    transaction, breaking the promise that nothing changes until
                    the import is confirmed. They are one tap away in the list.
                  -->
                  {#each group.existingIds as id (id)}
                    {@const stored = storedFlight(id)}
                    {#if stored}
                      <li class="flight stored">
                        <div class="flight-main">
                          <span class="src">Already saved</span>
                          <span class="when">{stored.date}</span>
                          <span class="route">{stored.depAerodrome}→{stored.arrAerodrome}</span>
                          <span class="times">{showTime(stored.offBlock)}–{showTime(stored.onBlock)}</span>
                          <span class="reg">{stored.registration}</span>
                          <span class="dur">{minutesToDecimal(stored.totalMinutes)}</span>
                        </div>
                      </li>
                    {/if}
                  {/each}
                </ul>
              </li>
            {/each}
          </ol>

          {#if plan.skipped.length > 0}
            <!--
              Dropped rows are listed rather than simply vanishing. A row left
              out no longer takes part in conflict detection, so it disappears
              from its group — and without this it would be gone with no way
              back short of starting again.
            -->
            <div class="dropped">
              <p class="dropped-head">
                Being left out ({plan.skipped.length})
              </p>
              <ul class="flights">
                {#each plan.skipped as row (row.line)}
                  <li class="flight dropped-row">
                    <div class="flight-main">
                      <span class="src">Line {row.line}</span>
                      <span class="when">{row.record.date}</span>
                      <span class="route">
                        {row.record.depAerodrome}→{row.record.arrAerodrome}
                      </span>
                      <span class="times">{showTime(row.record.offBlock)}–{showTime(row.record.onBlock)}</span>
                      <span class="reg">{row.record.registration}</span>
                    </div>
                    <div class="flight-actions">
                      <button type="button" class="btn ghost small" onclick={() => toggleDropped(row.line)}>
                        Include again
                      </button>
                    </div>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
          {#if plan.conflicts.length > MAX_LISTED_CONFLICTS}
            <p class="hint">
              …and {plan.conflicts.length - MAX_LISTED_CONFLICTS} more.
              {#if plan.conflicts.length > 100}
                This many usually means the file has been imported before.
              {/if}
            </p>
          {/if}
          <p class="hint">
            Imported times are taken from the file as-is. If a sector crosses a
            timezone the file's times may be an hour out, so an overlap is worth
            checking rather than assuming.
          </p>
          <div class="wizard-actions">
            <!-- svelte-ignore a11y_autofocus -->
            <button type="button" class="btn primary" autofocus onclick={chooseSkip}>
              Skip {plan.counts.conflicting} overlapping {plan.counts.conflicting === 1 ? 'row' : 'rows'}
            </button>
            <button type="button" class="btn" onclick={chooseAnyway}>Import them anyway</button>
            <button type="button" class="btn ghost" onclick={startOver}>Cancel</button>
          </div>
        </section>
      {:else}
        <section class="card">
          <h2>What will be imported</h2>
          <ul class="statements">
            {#each plan.statements as statement (statement)}<li>{statement}</li>{/each}
            <!--
              Restated here rather than left behind on the mapping step. The
              rule this import runs on is that it may transform but never
              invisibly, and shifting every block time in the file by two hours
              is the largest transform on this screen — the pilot is about to
              confirm it, so it belongs in the list of what they are confirming.
            -->
            {#if timeZoneOffset !== 0}
              <li>
                Block times are being read as {formatOffset(timeZoneOffset)} and converted to
                UTC. Sectors departing after local midnight are logged on the previous day.
              </li>
            {/if}
            <!--
              The Airside transforms, restated at the point of confirming. Every
              one of these is something the import DECIDED rather than read, and
              the largest of them — the zone and the night time — are exactly the
              kind of thing that is easy to agree to four screens earlier and
              hard to notice afterwards.
            -->
            {#if airsideAdapted}
              {@const report = airsideAdapted.report}
              <li>
                Aerodromes were read as IATA codes and stored as ICAO.
                {#if report.unresolvedCodes.length > 0}
                  {report.unresolvedCodes.join(', ')} had no ICAO match and
                  {report.unresolvedCodes.length === 1 ? 'is' : 'are'} stored as written.
                {/if}
              </li>
              <li>
                Block times were written on local clocks and converted to UTC.
                {report.zonesResolved} of {report.zoneRowsRead} rows were worked out from the
                file's own totals{#if report.zonesAssumed.length > 0}; the other
                  {report.zonesAssumed.length} assume
                  {airsidePrimaryZone || 'UTC'} and are marked "Zone Assumed" on the
                  record{/if}.
              </li>
              {#if airsideNight && report.nightRows > 0}
                <li>
                  {minutesToDecimal(report.nightMinutes)} hours of night time were worked
                  out from the route and the clock, not read from the file, and
                  {report.nightLandings}
                  {report.nightLandings === 1 ? 'landing was' : 'landings were'} filed in
                  the night column.
                </li>
              {/if}
            {/if}
          </ul>

          <dl class="counts">
            <div><dt>Rows in the file</dt><dd>{plan.counts.rowsRead}</dd></div>
            <div><dt>Flights</dt><dd>{plan.counts.flights}</dd></div>
            <div>
              <dt>Flight time added</dt>
              <dd>{minutesToDecimal(plan.counts.flightMinutes)}</dd>
            </div>
            {#if plan.counts.simulatorSessions > 0}
              <div><dt>Simulator sessions</dt><dd>{plan.counts.simulatorSessions}</dd></div>
              <div>
                <dt>Simulator time added</dt>
                <dd>{minutesToDecimal(plan.counts.simulatorMinutes)}</dd>
              </div>
            {/if}
            {#if plan.rejected.length > 0}
              <div class="bad"><dt>Left out</dt><dd>{plan.rejected.length}</dd></div>
            {/if}
          </dl>

          <!--
            Driven by what the plan actually holds rather than by which button
            was pressed, because a row can now be left out one at a time as well
            as in bulk, and the pilot should see the same sentence either way.
          -->
          {#if plan.skipped.length > 0}
            <p class="hint">
              {plan.skipped.length}
              {plan.skipped.length === 1 ? 'row is' : 'rows are'} being left out
              (lines {plan.skipped.map((r) => r.line).join(', ')}).
              <button type="button" class="btn ghost small" onclick={() => (skipLines = [])}>
                Include them all
              </button>
            </p>
          {/if}
          {#if conflictChoice === 'anyway' && plan.counts.conflicting > 0}
            <p class="hint warn">
              Overlapping rows will be imported as they are, for you to sort out
              afterwards.
            </p>
          {/if}
        </section>

        {#if plan.rejected.length > 0}
          <section class="card">
            <h2>Rows that will be left out</h2>
            <ul class="rejected">
              {#each plan.rejected.slice(0, 25) as row (row.line)}
                <li>
                  <span class="line">Line {row.line}</span>
                  <span class="label">{row.label}</span>
                  <span class="why" class:question={row.needsAircraft}>{row.issues[0]?.message}</span>
                </li>
              {/each}
            </ul>
            {#if plan.rejected.length > 25}
              <p class="hint">…and {plan.rejected.length - 25} more.</p>
            {/if}
          </section>
        {/if}

        <div class="wizard-actions">
          <button type="button" class="btn ghost" onclick={() => (step = 'aircraft')}>Back</button>
          <button
            type="button"
            class="btn primary"
            disabled={busy || plan.rows.length === 0}
            onclick={confirmImport}
          >
            {busy
              ? 'Importing…'
              : `Import ${plan.rows.length} ${plan.rows.length === 1 ? 'entry' : 'entries'}`}
          </button>
        </div>
      {/if}
    {/if}

    <!-- ── Done ──────────────────────────────────────────────────────────── -->
    {#if step === 'done' && result}
      <section class="card ok-card">
        <h2>Imported</h2>
        <p class="desc">
          {result.flights}
          {result.flights === 1 ? 'entry' : 'entries'} added, and {result.aircraft}
          {result.aircraft === 1 ? 'aircraft' : 'aircraft'} remembered.
        </p>
        <p class="note">
          Now is a good moment to back up — an import is the largest change your
          logbook will ever see in one go.
        </p>
        <div class="wizard-actions">
          <button type="button" class="btn primary" onclick={onBack}>Done</button>
          <button type="button" class="btn ghost" onclick={startOver}>Import another file</button>
        </div>
      </section>
    {/if}
  </div>
</section>

<style>
  .import-view {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    min-height: 100dvh;
  }
  .bar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 0.6rem 0.9rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .bar h1 {
    margin: 0;
    font-size: 1.05rem;
    text-align: center;
    white-space: nowrap;
  }
  .bar .back {
    justify-self: start;
  }
  .body {
    width: 100%;
    max-width: 620px;
    margin: 0 auto;
    padding: 1.25rem 0.9rem 3rem;
  }

  .steps {
    display: flex;
    gap: 0.4rem;
    margin: 0 0 1.25rem;
    padding: 0;
    list-style: none;
    font-size: 0.8rem;
    color: var(--text-faint);
    flex-wrap: wrap;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .steps li + li::before {
    content: '›';
    margin-right: 0.4rem;
    color: var(--border);
  }
  .steps .num {
    display: inline-grid;
    place-items: center;
    width: 1.3rem;
    height: 1.3rem;
    border-radius: 999px;
    background: var(--surface-2);
    font-size: 0.7rem;
  }
  .steps .current {
    color: var(--text);
    font-weight: 600;
  }
  .steps .current .num {
    background: var(--accent);
    color: var(--accent-text);
  }
  .steps .past .num {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1rem;
    background: var(--surface);
  }
  .card + .card,
  .card + .wizard-actions {
    margin-top: 1rem;
  }
  .card h2 {
    margin: 0 0 0.4rem;
    font-size: 1rem;
  }
  .card-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
    margin-bottom: 0.4rem;
  }
  .danger-card {
    border-color: var(--danger);
  }
  .ok-card {
    border-color: var(--accent);
  }
  .needs-answer {
    border-color: var(--night);
  }

  .desc {
    margin: 0 0 0.75rem;
    color: var(--text-muted);
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .note,
  .hint {
    margin: 0.6rem 0 0;
    color: var(--text-faint);
    font-size: 0.8rem;
    line-height: 1.4;
  }
  .hint.warn {
    color: var(--night);
  }
  .dim {
    color: var(--text-faint);
    font-size: 0.8rem;
  }

  .msg {
    margin: 0 0 1rem;
    padding: 0.6rem 0.75rem;
    border-radius: var(--radius);
    font-size: 0.9rem;
  }
  .msg.error {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .offer {
    margin: 0 0 1rem;
    padding: 0.85rem;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: var(--accent-soft);
  }
  .offer p {
    margin: 0 0 0.6rem;
    font-size: 0.9rem;
  }

  .notes {
    margin: 0 0 0.75rem;
    padding-left: 1.1rem;
    color: var(--text-muted);
    font-size: 0.82rem;
    line-height: 1.5;
  }
  .notes.warn {
    color: var(--night);
  }

  /*
    A hidden input driven by a real button — the convention ExportPanel already
    uses. The label-wrapping-an-invisible-input alternative needs
    `pointer-events: none` to behave, and that makes the input unreachable to
    anything driving the page programmatically, tests included.
  */
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  .unit-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  select,
  input[type='text'] {
    min-height: 2.1rem;
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 0.85rem;
  }

  .cols {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 26rem;
    overflow-y: auto;
  }
  .cols li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.5rem;
    align-items: center;
    padding: 0.3rem 0;
    border-bottom: 1px solid var(--surface-2);
  }
  .col-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85rem;
  }

  .types,
  .untyped,
  .conflicts,
  .rejected,
  .anchors,
  .prefixes,
  .models,
  .assumed {
    list-style: none;
    margin: 0.75rem 0 0;
    padding: 0;
  }

  .anchors li,
  .models li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--line, #e5e7eb);
  }

  .anchors .grow {
    flex: 1 1 12rem;
  }

  .anchors input[type='text'] {
    width: 100%;
  }

  .code {
    font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-weight: 600;
  }

  .zone-note {
    font-size: 0.85rem;
    color: var(--muted, #6b7280);
  }

  .zone-note.warn {
    color: var(--warn-text, #92400e);
  }

  .primary-pick {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.85rem;
    color: var(--muted, #6b7280);
    white-space: nowrap;
  }

  .add-anchor {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.75rem;
  }

  .prefixes li {
    padding: 0.25rem 0;
  }

  .prefixes label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .count {
    font-size: 0.85rem;
    color: var(--muted, #6b7280);
  }

  .designator {
    width: 6rem;
    text-transform: uppercase;
  }

  .assumed {
    max-height: 14rem;
    overflow-y: auto;
    margin-top: 0.5rem;
    border: 1px solid var(--line, #e5e7eb);
    border-radius: 0.4rem;
  }

  .assumed li {
    display: flex;
    gap: 0.75rem;
    padding: 0.3rem 0.6rem;
    font-size: 0.9rem;
  }

  .assumed li + li {
    border-top: 1px solid var(--line, #e5e7eb);
  }

  .assumed .line {
    color: var(--muted, #6b7280);
    min-width: 5rem;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .linkish {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent, #2563eb);
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }

  .statements {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .statements {
    padding-left: 1.1rem;
    list-style: disc;
    font-size: 0.9rem;
    line-height: 1.55;
    color: var(--text-muted);
  }
  .statements li + li {
    margin-top: 0.35rem;
  }

  .types li {
    padding: 0.55rem 0;
    border-bottom: 1px solid var(--surface-2);
  }
  .type-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    justify-content: space-between;
  }
  .type-controls {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    margin-top: 0.35rem;
    flex-wrap: wrap;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.85rem;
  }

  .untyped li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.5rem;
    align-items: center;
    padding: 0.3rem 0;
  }
  .reg {
    font-family: var(--mono);
    font-size: 0.85rem;
  }

  .conflicts {
    counter-reset: conflict;
  }
  .conflicts > li {
    padding: 0.6rem 0;
    border-bottom: 1px solid var(--surface-2);
  }
  .group-summary {
    margin: 0 0 0.4rem;
    font-size: 0.85rem;
    font-weight: 600;
  }

  /* One flight, laid out so the times line up down the column. */
  .flights {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .flight {
    padding: 0.35rem 0.5rem;
    border-radius: var(--radius);
    background: var(--surface-2);
    font-size: 0.82rem;
  }
  .flight + .flight {
    margin-top: 0.3rem;
  }
  .flight-main {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.15rem 0.6rem;
  }
  .flight .src {
    min-width: 5.5rem;
    color: var(--text-faint);
    font-size: 0.75rem;
  }
  .flight .when,
  .flight .times,
  .flight .reg,
  .flight .dur {
    font-family: var(--mono);
  }
  .flight .route {
    font-weight: 600;
  }
  .flight .dur {
    margin-left: auto;
    font-weight: 600;
  }
  /* A corrected row is marked, because it no longer matches the file. */
  .flight.edited {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .flight.stored {
    background: transparent;
    border: 1px dashed var(--border);
    color: var(--text-muted);
  }
  .flight-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.3rem;
  }
  .danger-text {
    color: var(--danger);
  }

  .editor {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
  }
  .editor label {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.72rem;
    color: var(--text-muted);
  }
  .editor input {
    width: 7rem;
  }
  .editor-actions {
    display: flex;
    gap: 0.4rem;
    align-items: flex-end;
  }

  .dropped {
    margin-top: 0.9rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }
  .dropped-head {
    margin: 0 0 0.4rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-muted);
  }
  .dropped-row .flight-main {
    opacity: 0.6;
    text-decoration: line-through;
  }

  .rejected li {
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--surface-2);
    font-size: 0.85rem;
    line-height: 1.45;
  }
  .rejected li {
    display: grid;
    gap: 0.15rem;
  }
  .rejected .line {
    color: var(--text-faint);
    font-size: 0.78rem;
  }
  .rejected .why {
    color: var(--danger);
  }
  .rejected .why.question {
    color: var(--night);
  }

  .counts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.6rem;
    margin: 0.9rem 0 0;
  }
  .counts div {
    padding: 0.5rem 0.6rem;
    border-radius: var(--radius);
    background: var(--surface-2);
  }
  .counts dt {
    font-size: 0.75rem;
    color: var(--text-faint);
  }
  .counts dd {
    margin: 0.1rem 0 0;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .counts .bad dd {
    color: var(--danger);
  }

  .wizard-actions {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-top: 1rem;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
