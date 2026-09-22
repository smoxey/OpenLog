<script lang="ts">
  import {
    FIELDS,
    copySourceKey,
    detailFieldsFor,
    fieldsFor,
    formFieldsFor,
    quickFieldsFor,
    getAircraftRoleField,
    getNightField,
  } from '../registry/fields';
  import type { FieldDefinition } from '../registry/types';
  import { SIMULATOR_AERODROME, type EntryType } from '../domain/flight';
  import {
    addFlight,
    updateFlight,
    deleteFlight,
    getFlight,
    listFlights,
    getAircraft,
    getAllAircraft,
    upsertAircraft,
    normalizeRegistration,
    type Aircraft,
    type AircraftClass,
    type Flight,
    type NewFlightInput,
    type ValidationError,
  } from '../storage';
  import {
    DERIVED_TIME_FIELDS,
    deriveAircraftTimes,
    resolveAircraftClass,
    type DerivableTimes,
  } from '../domain/derive';
  import { findConflicts } from '../domain/conflicts';
  import { checkTimeSums } from '../domain/timeSums';
  import { suggestNightForEntry } from '../night/suggest';
  import { airportsIfLoaded, loadAirports, type AirportIndex } from '../airports/lookup';
  import { formatDuration } from '../format';
  import { settings, setEntryTimeZoneOffset } from '../stores/settings.svelte';
  import { suggestTotalMinutes, timeOfDayToMinutes } from '../time/blockTime';
  import {
    UTC_OFFSETS,
    entryLocalToUtc,
    entryUtcToLocal,
    formatOffset,
    formatTimeOfDay,
    localToUtc,
  } from '../time/timeOfDay';
  import FormField from './FormField.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';

  interface Props {
    flightId?: string | null;
    onDone: () => void;
    onCancel: () => void;
  }

  let { flightId = null, onDone, onCancel }: Props = $props();

  const isEdit = $derived(!!flightId);
  const mode = $derived(settings.durationDisplay);
  const clock = $derived(settings.clockDisplay);

  /**
   * Working model keyed by field key; typed loosely so the registry can drive it.
   *
   * ITS DATE AND BLOCK TIMES ARE IN `zoneOffset`, NOT NECESSARILY IN UTC. That
   * is the one thing to hold on to about this component. The form is the layer
   * where a pilot may type local time, so the model holds what is on screen and
   * `utcEntry` below is the single place it is turned back into what the
   * logbook stores. Everything that reasons about the flight — conflicts, night,
   * the payload — reads `utcEntry`, never these three fields directly.
   */
  let model = $state<Record<string, string | number>>({});
  let errors = $state<Record<string, string>>({});
  let generalError = $state('');

  let ready = $state(false);
  let saving = $state(false);
  let totalTouched = $state(false);
  let suggested = $state(false);

  // --- The zone the block times are being typed in --------------------------
  /**
   * Minutes east of UTC. `0` — plain UTC — is the default and the resting
   * state, because UTC is what a logbook records and what gets stored either
   * way.
   *
   * Seeded from settings so a pilot who logs in local time is not asked again
   * on every entry, and written back the moment it changes. It is never stored
   * on a flight: the records carry no zone, and inventing one for them would be
   * a schema claiming to know something it was never told.
   */
  let zoneOffset = $state(0);

  // --- Night time -----------------------------------------------------------
  /** Which field the night calculation fills, per the registry. */
  const NIGHT_FIELD = getNightField();
  /** The pilot has set night by hand. It is never worked out again. */
  let nightTouched = $state(false);
  /** …and the same for the two landing counts, which move together. */
  let landingsTouched = $state(false);
  /** The night field currently holds a figure this app worked out. */
  let nightSuggested = $state(false);
  /**
   * The night figure this entry was SAVED with, or null on a new entry.
   *
   * Kept so the pilot can always get back to it. Opening a saved flight must
   * never quietly rewrite what they logged — so the calculation is offered
   * beside their figure rather than over it, and once they have taken it, this
   * is what "keep what I logged" restores. Without it the moon button would be
   * a one-way door on a record the pilot cannot get back by any other means.
   */
  let loggedNightMinutes = $state<number | null>(null);

  // --- Who was flying -------------------------------------------------------
  /** Manipulating the controls, or monitoring the one who was. */
  type PilotRole = 'PF' | 'PM';
  /**
   * Which seat's job this leg was.
   *
   * NOT stored, and not an EASA column. It is a shortcut on the way to the two
   * landing counts, which ARE stored and which carry the same fact where it
   * matters: the pilot monitoring did not land the aeroplane. Opening a saved
   * entry reads it back off those counts rather than out of a field the schema
   * would then have to keep, migrate and export.
   *
   * Not remembered between entries either, unlike the entry zone: PF and PM
   * alternate leg by leg, so the last answer is the weakest available guess at
   * the next one. `PF` is the resting state because it is what an entry with
   * one landing means, and one landing is what this form has always opened on.
   */
  let pilotRole = $state<PilotRole>('PF');
  /**
   * The arrival verdict the pilot has agreed to, after being told the app was
   * unsure of it. Null until they answer.
   *
   * Held as the VERDICT rather than as a boolean so the question comes back
   * when the verdict changes: nudge an on-block time across civil twilight and
   * what they confirmed is about a different landing than the one now on the
   * form. Storing "asked and answered" would suppress the second question too.
   */
  let confirmedArrival = $state<'day' | 'night' | null>(null);
  /**
   * The airport list, once its chunk has loaded.
   *
   * Held as state rather than awaited in `init` so the form opens at once and
   * fills the night in a moment later, instead of making every entry wait for a
   * table of coordinates. Starts non-null on the second and later flights of a
   * session, because the module caches it.
   */
  let airports = $state<AirportIndex | null>(airportsIfLoaded());
  let initialSnapshot = $state('');
  let showDiscard = $state(false);
  let showDelete = $state(false);
  let showDetail = $state(false);
  let formEl = $state<HTMLFormElement | null>(null);

  /**
   * Which kind of entry this form is logging. The mode toggle owns it, and
   * every field list below is derived from it — the form never asks "is this
   * key an aerodrome"; it asks the registry what applies to this entry type.
   */
  let entryType = $state<EntryType>('flight');
  const isFstd = $derived(entryType === 'fstd');

  const formFields = $derived(formFieldsFor(entryType));
  const quickFields = $derived(quickFieldsFor(entryType));
  const detailFields = $derived(detailFieldsFor(entryType));
  /**
   * The two landing counts, in registry order, rendered as one block.
   *
   * Named here rather than in the template so the grouping stays a list the
   * loop consults, not a pair of hardcoded branches. Empty in simulator mode,
   * where neither field applies — the group then never renders and the loop
   * never skips anything.
   */
  const LANDING_KEYS = ['landingsDay', 'landingsNight'] as const;
  const isLandingKey = (key: string): boolean =>
    (LANDING_KEYS as readonly string[]).includes(key);
  const landingFields = $derived(quickFields.filter((f) => isLandingKey(f.key)));

  /** Every key this entry type carries, including the ones the app fills in. */
  const coreKeys = $derived(fieldsFor(entryType).map((f) => f.key));
  const detailKeys = $derived(detailFields.map((f) => f.key));

  // --- Aircraft lookup and derived SE/ME time -------------------------------
  // Which field keys the aircraft store and which one it prefills comes from
  // the registry, not from hardcoded key names (context doc §5).
  const REG_FIELD = getAircraftRoleField('registration');
  const TYPE_FIELD = getAircraftRoleField('type');
  const DERIVED_KEYS: readonly string[] = DERIVED_TIME_FIELDS;

  let aircraft = $state<Aircraft | undefined>(undefined);
  let registrations = $state<readonly string[]>([]);

  /**
   * Every stored entry, read ONCE when the form opens.
   *
   * Conflict detection re-runs on every keystroke in a block-time field, so it
   * must never touch storage: the budget is 2,000 flights and the entry form is
   * required to respond instantly. `findConflicts` is pure and takes the set to
   * compare against, which is exactly what makes holding it here possible.
   *
   * It is a snapshot, and deliberately so — nothing else can write to the
   * logbook while this form is open. Saving returns to the list, which destroys
   * the form; reopening it runs `init` again and re-reads.
   */
  let comparisonSet = $state<readonly Flight[]>([]);
  /** Derived fields the pilot has edited by hand. Never overwritten again. */
  let touched = $state<Set<string>>(new Set());

  // Inline prompt for a registration we've never seen. Never blocks saving.
  let askReg = $state('');
  let askClass = $state<AircraftClass>('SE');
  let askMultiPilot = $state(false);
  /** Registrations dismissed during this edit — don't nag twice in one form. */
  const dismissed = new Set<string>();

  /**
   * Guard for the derivation effect: the inputs derivation depends on, as a
   * string. Armed at the end of `init`, so opening a flight for edit never
   * re-derives on load — the effect's first run sees an unchanged signature.
   * A plain variable, not $state: it must not itself trigger the effect.
   */
  let derivationSignature = '';

  function currentRegistration(): string {
    return REG_FIELD ? normalizeRegistration(String(model[REG_FIELD.key] ?? '')) : '';
  }

  /**
   * Everything a derived value depends on. Registration and total are the
   * spec'd triggers; the resolved class and multi-pilot flag are included
   * because answering the unknown-aircraft prompt changes them without
   * changing the registration, and that must re-derive.
   */
  function signature(): string {
    const resolved = resolveAircraftClass(aircraft, settings.defaultAircraftClass);
    return [
      currentRegistration(),
      Number(model.totalMinutes) || 0,
      resolved,
      aircraft?.multiPilot ?? false,
    ].join('|');
  }

  async function loadRegistrations(recent: readonly Flight[] = []): Promise<string[]> {
    const known = new Set((await getAllAircraft()).map((a) => a.registration));
    for (const f of recent) {
      const reg = normalizeRegistration(f.registration ?? '');
      if (reg) known.add(reg);
    }
    return [...known].sort();
  }

  /** Resolve the current registration against the aircraft store. */
  async function lookupAircraft(prompt: boolean) {
    const reg = currentRegistration();
    if (!reg) {
      aircraft = undefined;
      askReg = '';
      return;
    }

    const found = await getAircraft(reg);
    aircraft = found;

    if (found) {
      askReg = '';
      // Prefill the type only when empty — never overwrite what was typed.
      if (TYPE_FIELD && !String(model[TYPE_FIELD.key] ?? '').trim()) {
        model[TYPE_FIELD.key] = found.type;
      }
    } else if (prompt && !dismissed.has(reg)) {
      askClass = settings.defaultAircraftClass;
      askMultiPilot = false;
      askReg = reg;
    } else {
      askReg = '';
    }
  }

  async function rememberAircraft() {
    const saved = await upsertAircraft({
      registration: askReg,
      type: TYPE_FIELD ? String(model[TYPE_FIELD.key] ?? '') : '',
      class: askClass,
      multiPilot: askMultiPilot,
    });
    aircraft = saved;
    askReg = '';
    registrations = await loadRegistrations();
  }

  /** Ignore the prompt. Derivation falls back to the setting; saving is unaffected. */
  function skipAircraftPrompt() {
    dismissed.add(askReg);
    askReg = '';
  }

  /** True when any "More" field holds data worth showing without a click. */
  function hasDetailData(m: Record<string, string | number>): boolean {
    return detailKeys.some((key) => {
      const v = m[key];
      return typeof v === 'number' ? v !== 0 : !!v;
    });
  }

  function todayIso(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /**
   * A blank model covering EVERY registry field, not just the ones the current
   * mode renders. Switching mode mid-entry then swaps which slice is shown and
   * submitted, without silently discarding what was already typed in the other.
   */
  function blankModel(): Record<string, string | number> {
    const m: Record<string, string | number> = {};
    for (const f of FIELDS) {
      m[f.key] = f.type === 'durationMinutes' || f.type === 'count' ? 0 : '';
    }
    m.entryType = 'flight';
    return m;
  }

  async function init() {
    let recentFlights: readonly Flight[] = [];

    // Where the last entry was typed. UTC until the pilot says otherwise.
    zoneOffset = settings.entryTimeZoneOffset;

    // Deliberately not awaited: the airport list is a separate chunk, and the
    // form must not wait for it. When it lands, the night suggestion appears.
    void loadAirports().then((index) => {
      airports = index;
    });
    // The one and only read of the flight table for the life of this form.
    comparisonSet = await listFlights();

    if (flightId) {
      const flight = await getFlight(flightId);
      if (flight) {
        entryType = flight.entryType ?? 'flight';
        const m = blankModel();
        for (const key of coreKeys) {
          m[key] = (flight as unknown as Record<string, string | number>)[key];
        }
        m.entryType = entryType;
        // The record is UTC; the form may be showing a local clock. Same
        // instant, different digits — and saving converts it straight back.
        if (entryType !== 'fstd' && zoneOffset !== 0) {
          const local = entryUtcToLocal(
            { date: String(m.date ?? ''), offBlock: String(m.offBlock ?? ''), onBlock: String(m.onBlock ?? '') },
            zoneOffset,
          );
          m.date = local.date;
          m.offBlock = local.offBlock;
          m.onBlock = local.onBlock;
        }
        model = m;
        totalTouched = true; // existing total is real; don't overwrite via suggestion
        // Same for night and the landing columns. A saved record is the
        // pilot's own account of the flight, and opening it to fix a remark
        // must never quietly rewrite what they logged. The button is still
        // there for anyone who wants the calculation.
        nightTouched = true;
        landingsTouched = true;
        // Who landed it, read back off the counts the record already carries.
        // A saved entry with no landings in it is a leg someone else flew.
        pilotRole =
          (Number(flight.landingsDay) || 0) + (Number(flight.landingsNight) || 0) > 0
            ? 'PF'
            : 'PM';
        // What they logged, remembered so it can always be restored.
        loggedNightMinutes = Number(flight.nightMinutes) || 0;
        // Never hide data behind a collapsed section the pilot can't see.
        showDetail = hasDetailData(m);
      }
    } else {
      const m = blankModel();
      m.date = todayIso();
      m.landingsDay = 1;
      m.landingsNight = 0;
      // Sticky defaults from the most recent flight for fast repeat entry.
      recentFlights = comparisonSet;
      const recent = recentFlights.find((f) => f.entryType !== 'fstd') ?? recentFlights[0];
      if (recent) {
        for (const f of formFields) {
          if (f.stickyDefault) {
            m[f.key] = (recent as unknown as Record<string, string | number>)[f.key] ?? m[f.key];
          }
        }
      }
      model = m;
    }

    // Resolve the aircraft BEFORE arming the derivation guard, and without
    // prompting: opening a flight must not re-derive anything, and must not
    // interrogate the pilot about an aircraft they aren't currently entering.
    await lookupAircraft(false);
    registrations = await loadRegistrations(recentFlights);

    derivationSignature = signature();
    initialSnapshot = JSON.stringify(model);
    ready = true;
  }

  init();

  const dirty = $derived(ready && JSON.stringify(model) !== initialSnapshot);

  /**
   * The date and the two block times as the LOGBOOK will hold them — UTC.
   *
   * The single conversion point between what is on screen and what is stored.
   * Conflicts, the night calculation and `buildPayload` all read this rather
   * than `model`, which is what makes it impossible for one of them to reason
   * about a local clock while another reasons about UTC. At `zoneOffset === 0`
   * it is the model's own values, so the UTC path is not a special case — it is
   * the same path with nothing to subtract.
   */
  const utcEntry = $derived(
    entryLocalToUtc(
      {
        date: String(model.date ?? ''),
        offBlock: String(model.offBlock ?? ''),
        onBlock: String(model.onBlock ?? ''),
      },
      zoneOffset,
    ),
  );

  /**
   * Switch the zone WITHOUT moving the flight.
   *
   * The times on screen are rewritten so they describe the same instant on the
   * new clock — 21:36 UTC becomes 23:36 at UTC+02:00 — rather than the digits
   * being kept and reinterpreted. That direction is not a preference: keeping
   * the digits would silently rewrite a saved record every time a pilot changed
   * the selector to check what zone it was in, and the whole point of this
   * screen is that nothing changes a record without being asked.
   */
  async function changeZone(next: number) {
    if (next === zoneOffset) return;
    const wasClean = !dirty;
    const local = entryUtcToLocal(utcEntry, next);
    model.date = local.date;
    model.offBlock = local.offBlock;
    model.onBlock = local.onBlock;
    zoneOffset = next;
    // Re-expressing the same instant is not an edit, so it must not raise the
    // discard prompt on the way out.
    if (wasClean) initialSnapshot = JSON.stringify(model);
    await setEntryTimeZoneOffset(next);
  }

  /**
   * Entries already in the logbook whose block times intersect this one's.
   *
   * A pilot cannot be in two places at once, so at least one of them is wrong.
   * ADVISORY ONLY: this is displayed and never consulted by `save`, consistent
   * with the rule that an unknown registration never blocks a save either. The
   * pilot may be about to correct the older entry, or may know something the app
   * does not.
   *
   * Being `$derived` is what gives re-checking for free: it recomputes when the
   * date or either block time changes, and returns nothing — clearing the
   * warning — as soon as an edit removes the overlap. What it does NOT do is
   * touch storage; `comparisonSet` was read once when the form opened.
   *
   * The entry-type rule is not repeated here. `findConflicts` excludes FSTD
   * entries on both sides, and it is the single definition the importer will
   * use too.
   */
  const conflicts = $derived(
    ready
      ? findConflicts(
          {
            id: flightId ?? undefined,
            entryType,
            // UTC, always: the stored entries it is compared against are, and
            // an overlap check run against a local clock would miss real ones
            // and invent others.
            date: utcEntry.date,
            offBlock: utcEntry.offBlock,
            onBlock: utcEntry.onBlock,
          },
          comparisonSet,
        )
      : [],
  );

  /**
   * Time columns that do not fit inside the total (or, on a simulator session,
   * inside the session time).
   *
   * ADVISORY, exactly like the overlap warning above: `save` never looks at
   * this and no control is disabled by it. `validateFlight` is untouched — a
   * hard rule here would refuse entries that are genuinely correct, such as a
   * flight logged as both PIC and instructor for its whole duration.
   *
   * `$derived` gives the re-checking for free, and `checkTimeSums` is built to
   * be run on a half-typed model: an untyped total produces no findings rather
   * than warning about a form the pilot has barely started.
   */
  const sumFindings = $derived(ready ? checkTimeSums({ ...model, entryType }) : []);

  /**
   * Night time worked out from the date, the block times and the two
   * aerodromes.
   *
   * `$derived` again, for the same reason as the two warnings above: it
   * recomputes when any of its inputs change and it never touches storage. The
   * airport list is read from state, so this is null until the chunk arrives
   * and then fills itself in.
   *
   * Note what is NOT here: the decision to use the answer. This is the
   * calculation; the effect below is the only thing that writes it into the
   * form, and the pilot can overrule it in either case.
   */
  const nightSuggestion = $derived(
    ready && airports
      ? suggestNightForEntry(
          {
            entryType,
            // UTC, and this one is not merely for consistency: the sun's
            // position is worked out from an absolute instant, so feeding it a
            // local clock would put the aircraft an offset's worth of Earth
            // rotation away from where it was.
            date: utcEntry.date,
            offBlock: utcEntry.offBlock,
            onBlock: utcEntry.onBlock,
            // The aerodrome keys are named directly, as they already are in
            // `buildPayload` for the simulator sentinel. They are the two
            // fields the whole route concept rests on; a registry role for
            // them would be one more indirection for no second caller.
            depAerodrome: String(model.depAerodrome ?? ''),
            arrAerodrome: String(model.arrAerodrome ?? ''),
            totalMinutes: Number(model.totalMinutes) || 0,
          },
          (code) => airports?.get(code),
        )
      : null,
  );

  /**
   * Fill in the night field, and put the landing in the right column.
   *
   * The same contract as the block-times-to-total suggestion above it: it fills
   * the field while the pilot has not touched it, and stops for good the moment
   * they do. Turning `autoNight` off suppresses this and leaves the button.
   */
  $effect(() => {
    const suggestion = nightSuggestion;
    if (!ready || !suggestion) return;

    if (suggestion.status !== 'ready') {
      // The basis for the figure we put there has gone — an aerodrome changed
      // to one with no coordinates, a time cleared. WITHDRAW it: leaving a
      // number worked out for a route this entry no longer describes is worse
      // than leaving the field empty, because it still looks calculated.
      //
      // Before the `autoNight` check on purpose. Withdrawing is not offering:
      // this app put the number there, so this app takes it back, whatever the
      // setting says about volunteering new ones.
      if (nightSuggested && NIGHT_FIELD && !nightTouched) {
        model[NIGHT_FIELD.key] = 0;
        nightSuggested = false;
        if (!landingsTouched) {
          const landings = (Number(model.landingsDay) || 0) + (Number(model.landingsNight) || 0);
          model.landingsDay = landings;
          model.landingsNight = 0;
        }
      }
      return;
    }

    if (!settings.autoNight) return;

    if (NIGHT_FIELD && !nightTouched && model[NIGHT_FIELD.key] !== suggestion.nightMinutes) {
      model[NIGHT_FIELD.key] = suggestion.nightMinutes;
      nightSuggested = true;
    }

    if (!landingsTouched) {
      // One landing either way; which column it belongs in is exactly what
      // `arrivalIsNight` answers. The counts are only moved between columns —
      // the number of landings is never invented or removed.
      const landings = (Number(model.landingsDay) || 0) + (Number(model.landingsNight) || 0);
      const day = suggestion.arrivalIsNight ? 0 : landings;
      const night = suggestion.arrivalIsNight ? landings : 0;
      if (model.landingsDay !== day) model.landingsDay = day;
      if (model.landingsNight !== night) model.landingsNight = night;
    }
  });

  /**
   * Say who was flying, and let that set the landing.
   *
   * The pilot flying lands the aeroplane once; the pilot monitoring does not
   * land it at all. Which COLUMN that one landing goes in is still the night
   * calculation's question, so this sets the count and hands placement straight
   * back to it rather than deciding day or night itself.
   *
   * A shortcut, never a lock: both counts stay editable underneath, which is
   * where three touch-and-goes, or a leg where the landing was swapped, gets
   * typed in.
   */
  function setPilotRole(role: PilotRole) {
    if (role === pilotRole) return;
    pilotRole = role;

    const count = role === 'PF' ? 1 : 0;
    const suggestion = nightSuggestion;
    const night = !!suggestion && suggestion.status === 'ready' && suggestion.arrivalIsNight;
    model.landingsDay = night ? 0 : count;
    model.landingsNight = night ? count : 0;

    // Back under the calculation's care — this was the app filling the fields
    // in, not the pilot typing in them — and any confirmation on file is about
    // a landing that is no longer the one being logged.
    landingsTouched = false;
    confirmedArrival = null;
  }

  /**
   * The landing column the app is NOT sure about, or null when it is.
   *
   * Everything about this is advisory. Nothing is disabled, nothing is left
   * blank, and `save` never reads it: the app still picks a column, says out
   * loud that it guessed, and offers the other one. The uncertainty is real —
   * the logbook records block times, the sun cares about wheels-down, and the
   * taxi in between is not written anywhere.
   *
   * Silent once the pilot owns the columns: a count they typed, a swap they
   * asked for, or a saved entry they opened is an answer already given.
   */
  const landingCheck = $derived.by(() => {
    const suggestion = nightSuggestion;
    if (!suggestion || suggestion.status !== 'ready' || !suggestion.arrivalUncertain) return null;
    if (landingsTouched) return null;

    // Nothing was placed, so there is nothing to check. This is the pilot
    // monitoring: no landing was logged and no column can be wrong.
    const count = (Number(model.landingsDay) || 0) + (Number(model.landingsNight) || 0);
    if (count === 0) return null;

    const column: 'day' | 'night' = suggestion.arrivalIsNight ? 'night' : 'day';
    if (confirmedArrival === column) return null;
    const other: 'day' | 'night' = column === 'night' ? 'day' : 'night';

    const where = String(model.arrAerodrome ?? '').trim().toUpperCase();
    return {
      column,
      other,
      count,
      where,
      confirmLabel: `Yes — ${column} landing`,
      swapLabel: `No — it was ${other}`,
    };
  });

  /** The pilot says the column the app picked is the right one. */
  function confirmLanding() {
    const check = landingCheck;
    if (!check) return;
    // Only the QUESTION is answered — the counts are left under the
    // calculation, so correcting a block time afterwards still moves them.
    // Recording WHICH verdict was agreed to is what stops the same question
    // being asked twice, and what brings it back if the verdict changes.
    confirmedArrival = check.column;
  }

  /** …and this is the pilot saying it is not. The landings move across. */
  function swapLanding() {
    const check = landingCheck;
    if (!check) return;
    model.landingsDay = check.other === 'day' ? check.count : 0;
    model.landingsNight = check.other === 'night' ? check.count : 0;
    // Disagreeing IS setting the columns by hand. The calculation must not put
    // them back the next time anything else on the form changes.
    landingsTouched = true;
    confirmedArrival = null;
  }

  /** Work out night time now, because the pilot asked. */
  function applyNight() {
    const suggestion = nightSuggestion;
    if (!NIGHT_FIELD || !suggestion || suggestion.status !== 'ready') return;
    model[NIGHT_FIELD.key] = suggestion.nightMinutes;
    // Asking for it is not the same as typing it: the field goes back to being
    // maintained, so correcting a block time afterwards updates it again.
    nightTouched = false;
    nightSuggested = true;
    touched = new Set([...touched].filter((key) => key !== NIGHT_FIELD.key));
  }

  /** Put the pilot's own logged figure back, and stop working it out again. */
  function keepLoggedNight() {
    if (!NIGHT_FIELD || loggedNightMinutes === null) return;
    model[NIGHT_FIELD.key] = loggedNightMinutes;
    // Choosing their own number IS touching the field: the calculation must not
    // quietly replace it again the next time a block time is nudged.
    nightTouched = true;
    nightSuggested = false;
  }

  /**
   * The keep-or-change offer under the night field.
   *
   * Only ever appears when there is a real choice to make — a figure the pilot
   * (or the logbook they imported from) recorded, and a different one the route
   * and the clock produce. It reads in whichever direction the pilot is not
   * currently pointing: take the calculation, or go back to what was logged.
   *
   * Null on a new entry, because there is nothing to keep: the suggestion fills
   * an empty field and typing over it is the whole of the choice.
   */
  const nightChoice = $derived.by(() => {
    if (!NIGHT_FIELD) return null;
    const suggestion = nightSuggestion;
    if (!suggestion || suggestion.status !== 'ready') return null;

    const current = Number(model[NIGHT_FIELD.key]) || 0;
    const computed = suggestion.nightMinutes;

    if (current !== computed) {
      return { label: `Use ${formatDuration(computed, mode)} from the route`, act: applyNight };
    }
    if (loggedNightMinutes !== null && loggedNightMinutes !== computed) {
      return {
        label: `Keep the ${formatDuration(loggedNightMinutes, mode)} you logged`,
        act: keepLoggedNight,
      };
    }
    return null;
  });

  /** Why the night button cannot be pressed, or '' when it can. */
  const nightUnavailable = $derived.by(() => {
    if (!airports) return 'Loading the airport list…';
    const suggestion = nightSuggestion;
    if (!suggestion) return 'Loading the airport list…';
    if (suggestion.status === 'ready') return '';
    if (suggestion.status === 'unknownAerodrome') {
      return `${suggestion.missing.join(' and ')} not in the airport list`;
    }
    return 'Needs a date, both block times and both aerodromes';
  });

  /**
   * The line under the night field once a figure HAS been worked out.
   *
   * It says what the calculation concluded about the two ends of the flight,
   * which is the part the pilot can check against their own memory of it —
   * a night landing is a thing you remember. The sea-level caveat is stated
   * because it is an assumption the app makes and the pilot did not.
   */
  const nightSuggestedNote = $derived.by(() => {
    const suggestion = nightSuggestion;
    if (!suggestion || suggestion.status !== 'ready') return '';
    const takeoff = suggestion.departureIsNight ? 'night' : 'day';
    const landing = suggestion.arrivalIsNight ? 'night' : 'day';
    const close = suggestion.grazing ? ' Sun close to the horizon — worth checking.' : '';
    // Kept short: this sits under an input on a 375px screen, and the grazing
    // sentence already pushes it to three lines.
    return `From the route: take-off ${takeoff}, landing ${landing}, sea level.${close}`;
  });

  /** …and the line when it could NOT be, which is the more important one. */
  const nightNote = $derived.by(() => {
    const suggestion = nightSuggestion;
    if (!suggestion) return '';
    if (suggestion.status === 'unknownAerodrome') {
      const which = suggestion.missing.join(' and ');
      const plural = suggestion.missing.length > 1 ? 'are' : 'is';
      return `${which} ${plural} not in the airport list — night not worked out`;
    }
    // A saved flight whose logged figure and the calculation disagree. The
    // field is NOT marked as suggested here — it still holds the pilot's own
    // number — so this is the line that explains the offer sitting under it.
    if (suggestion.status === 'ready' && nightChoice) return nightSuggestedNote;
    return '';
  });

  /**
   * What to call the yardstick in a sentence.
   *
   * A key comparison in a component is normally the thing to avoid, but this is
   * a CLOSED set — `SumFinding['yardstickKey']` is the two-value union the
   * domain declares — and it is prose, not field logic. The registry labels
   * ("Total", "Simulator") are column headings and read badly in a sentence.
   */
  function yardstickPhrase(key: 'totalMinutes' | 'simulatorMinutes'): string {
    return key === 'simulatorMinutes' ? 'session time' : 'total';
  }

  /**
   * "PIC, Co-Pilot, Dual and Instructor" — built from the finding's own keys via
   * the registry, never written out inline. A simulator session carries only
   * two of those four columns, so a hardcoded list would name fields the form
   * is not even showing.
   */
  function describeKeys(keys: readonly string[]): string {
    const labels = keys.map((k) => FIELDS.find((f) => f.key === k)?.label ?? k);
    if (labels.length <= 1) return labels.join('');
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  }

  /** One line of plain English per finding. */
  function sumMessage(finding: (typeof sumFindings)[number]): string {
    const sum = formatDuration(finding.sum, mode);
    const yardstick = formatDuration(finding.yardstick, mode);
    const over = formatDuration(finding.excessMinutes, mode);
    const against = yardstickPhrase(finding.yardstickKey);
    if (finding.kind === 'pilotFunction') {
      return `${describeKeys(finding.keys)} time adds up to ${sum} — ${over} more than the ${against} of ${yardstick}.`;
    }
    return `${finding.label} time is ${sum}, which is ${over} more than the ${against} of ${yardstick}.`;
  }

  function validTime(value: unknown): boolean {
    return typeof value === 'string' && !Number.isNaN(timeOfDayToMinutes(value));
  }

  // Auto-suggest total time from block times until the user edits total.
  $effect(() => {
    const off = model.offBlock;
    const on = model.onBlock;
    if (!ready || totalTouched) return;
    if (validTime(off) && validTime(on)) {
      const s = suggestTotalMinutes(off as string, on as string);
      if (!Number.isNaN(s)) {
        model.totalMinutes = s;
        suggested = true;
      }
    }
  });

  /**
   * Derive SE / ME / multi-pilot time from the aircraft's class.
   *
   * Fires only when the signature changes — registration, total time, or the
   * resolved aircraft. Editing any other field, or simply opening a flight,
   * leaves the stored values exactly as they are.
   */
  $effect(() => {
    if (!ready) return;
    // A simulator session has no aircraft and no flight time to file, so there
    // is nothing to derive. Guarding here keeps `deriveAircraftTimes` a pure
    // flight concern rather than teaching it about entry types.
    if (isFstd) return;
    const next = signature();
    if (next === derivationSignature) return;
    derivationSignature = next;

    const before: Record<string, number> = { totalMinutes: Number(model.totalMinutes) || 0 };
    for (const key of DERIVED_KEYS) before[key] = Number(model[key]) || 0;

    const after = deriveAircraftTimes(
      before as unknown as DerivableTimes,
      aircraft,
      settings.defaultAircraftClass,
      touched,
    ) as unknown as Record<string, number>;

    for (const key of DERIVED_KEYS) {
      if (model[key] !== after[key]) model[key] = after[key];
    }
  });

  /**
   * What a local time typed into this field will actually be stored as.
   *
   * The whole safety of the local-time option rests on this line. A pilot
   * typing 01:30 at UTC+02:00 is logging a flight that departed the *previous*
   * day in UTC, and the app must say so before the save rather than after —
   * a date quietly moved by one is exactly the kind of error that survives
   * until someone counts their hours for a licence renewal.
   *
   * Empty at UTC: there is nothing to convert, and the field's own "UTC" hint
   * already says what it holds.
   */
  function zoneNote(field: FieldDefinition): string {
    if (zoneOffset === 0 || isFstd) return '';
    if (field.key === 'date') {
      return utcEntry.date && utcEntry.date !== String(model.date ?? '')
        ? `Off-block is the day before in UTC — this flight is logged on ${utcEntry.date}.`
        : '';
    }
    if (field.key !== 'offBlock' && field.key !== 'onBlock') return '';

    const local = String(model[field.key] ?? '');
    const shifted = localToUtc(local, zoneOffset);
    if (!validTime(local)) return `Local time, ${formatOffset(zoneOffset)}`;
    return `${formatTimeOfDay(local, clock)} local = ${formatTimeOfDay(shifted.time, clock)} UTC — stored`;
  }

  /** Where a derived field's current value came from — shown under the input. */
  function fieldNote(field: FieldDefinition): string {
    const zone = zoneNote(field);
    if (zone) return zone;
    if (!DERIVED_KEYS.includes(field.key)) return '';
    if (touched.has(field.key)) return 'Set by hand — not derived';
    if (!(Number(model[field.key]) > 0)) return '';
    if (aircraft) {
      return `From ${aircraft.registration}${aircraft.multiPilot ? ' (multi-pilot)' : ` (${aircraft.class})`}`;
    }
    return `Assumed ${settings.defaultAircraftClass} — class unknown`;
  }

  function onFieldUserEdit(field: FieldDefinition) {
    if (field.key === 'totalMinutes') {
      totalTouched = true;
      suggested = false;
    }
    if (NIGHT_FIELD && field.key === NIGHT_FIELD.key) {
      nightTouched = true;
      nightSuggested = false;
    }
    // The two landing columns move together, so touching either stops both
    // being moved: a pilot who has said where the landings go has said it.
    if (field.key === 'landingsDay' || field.key === 'landingsNight') landingsTouched = true;
    // A manual edit sticks: this field is never derived over again.
    if (DERIVED_KEYS.includes(field.key)) {
      const next = new Set(touched);
      next.add(field.key);
      touched = next;
    }
  }

  /** A text field settled (blur, or a datalist pick) — resolve the aircraft. */
  async function onFieldCommit(field: FieldDefinition) {
    if (field.aircraftRole !== 'registration') return;
    // Store the normalized form so the flight and the aircraft record agree.
    const reg = currentRegistration();
    if (model[field.key] !== reg) model[field.key] = reg;
    await lookupAircraft(true);
  }

  /**
   * The wand: fill this field with the whole session in one tap.
   *
   * The SOURCE depends on the entry type — a flight's total time, a simulator
   * session's session time — which is why this takes the target field rather
   * than hardcoding one pair of keys.
   */
  function copyTotal(field: FieldDefinition) {
    model[field.key] = model[copySourceKey(entryType)];
    onFieldUserEdit(field);
  }

  function buildPayload(): NewFlightInput & Partial<Flight> {
    const payload: Record<string, string | number> = {};
    for (const key of coreKeys) payload[key] = model[key];
    payload.entryType = entryType;

    // THE ZONE COMES OFF HERE, and only here. Whatever clock the pilot typed
    // on, the logbook stores UTC — so the date and both block times are taken
    // from `utcEntry` rather than from the model. At UTC these are the same
    // three values, which is why there is no branch.
    payload.date = utcEntry.date;
    payload.offBlock = utcEntry.offBlock;
    payload.onBlock = utcEntry.onBlock;

    if (isFstd) {
      // The fields this mode owns rather than renders. The storage layer
      // asserts the same invariants, but stating them here keeps what gets
      // saved identical to what the pilot was shown.
      payload.depAerodrome = SIMULATOR_AERODROME;
      payload.arrAerodrome = SIMULATOR_AERODROME;
      payload.offBlock = '';
      payload.onBlock = '';
      payload.registration = '';
      payload.picName = '';
      payload.totalMinutes = 0;
    }
    return payload as unknown as NewFlightInput & Partial<Flight>;
  }

  function mapErrors(list: ValidationError[]) {
    const map: Record<string, string> = {};
    generalError = '';
    for (const e of list) {
      if (coreKeys.includes(e.key)) {
        if (!map[e.key]) map[e.key] = e.message;
      } else {
        generalError = e.message;
      }
    }
    return map;
  }

  async function save() {
    if (saving) return;
    saving = true;
    errors = {};
    generalError = '';
    const payload = buildPayload();
    const result = flightId
      ? await updateFlight(flightId, payload)
      : await addFlight(payload);
    saving = false;

    if (result.ok) {
      initialSnapshot = JSON.stringify(model); // clean, so no discard prompt
      onDone();
      return;
    }
    errors = mapErrors(result.errors);
    // An error inside a collapsed section would otherwise be invisible.
    if (detailKeys.some((key) => errors[key])) showDetail = true;
    // Move focus to the first field with an error.
    queueMicrotask(() => {
      formEl?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }

  function requestCancel() {
    if (dirty) showDiscard = true;
    else onCancel();
  }

  async function confirmDelete() {
    if (flightId) await deleteFlight(flightId);
    showDelete = false;
    onDone();
  }
</script>

<!--
  One cell renderer, used for both the inline set and the "More" set. The form
  stays generated from the registry — this is a grouping step, not per-field
  markup.
-->
{#snippet fieldCell(field: FieldDefinition)}
  <div class="cell" class:span-all={field.type === 'remarks' || field.type === 'date'}>
    <FormField
      {field}
      bind:value={model[field.key]}
      {mode}
      {clock}
      error={errors[field.key] ?? ''}
      suggested={(field.key === 'totalMinutes' && suggested) ||
        (field.nightAction && nightSuggested)}
      suggestedNote={field.nightAction
        ? nightSuggestedNote
        : 'Suggested from block times — edit to override'}
      note={field.nightAction ? nightNote : fieldNote(field)}
      nightUnavailable={field.nightAction ? nightUnavailable : ''}
      onNight={() => applyNight()}
      choiceLabel={field.nightAction ? (nightChoice?.label ?? '') : ''}
      onChoice={() => nightChoice?.act()}
      suggestions={field.aircraftRole === 'registration' ? registrations : []}
      onUserEdit={() => onFieldUserEdit(field)}
      onCopyTotal={() => copyTotal(field)}
      copyLabel={isFstd ? 'Copy session time' : 'Copy total time'}
      onCommit={() => onFieldCommit(field)}
    />
  </div>
{/snippet}

<!--
  The landing block: who was flying, the two columns side by side, and the
  question the app asks when it cannot tell which column is right.

  Grouped rather than left to the registry loop because these three things are
  one decision. Ldg Day on its own used to imply a day landing was the normal
  case and a night one an exception filed under "More" — but the column a
  landing goes in is not an exception, it is half of a question the form should
  be asking outright.
-->
{#snippet landingsGroup()}
  <div class="cell span-all landings">
    <div class="seg role" role="group" aria-label="Your role on this flight">
      <button
        type="button"
        class="seg-btn"
        class:on={pilotRole === 'PF'}
        aria-pressed={pilotRole === 'PF'}
        onclick={() => setPilotRole('PF')}
      >
        Pilot Flying
      </button>
      <button
        type="button"
        class="seg-btn"
        class:on={pilotRole === 'PM'}
        aria-pressed={pilotRole === 'PM'}
        onclick={() => setPilotRole('PM')}
      >
        Pilot Monitoring
      </button>
    </div>

    <div class="landing-fields">
      {#each landingFields as field (field.key)}
        {@render fieldCell(field)}
      {/each}
    </div>

    <!--
      Advisory, like the overlap and time-sum warnings: no control is disabled,
      the fields are already filled in, and saving without answering is fine.
      It sits UNDER the two counts because it is a question about what is in
      them, and the two answers are buttons because both are one tap — the
      point is that agreeing costs no more than disagreeing.
    -->
    {#if landingCheck}
      <div class="ldg-check" role="status" aria-live="polite">
        <p class="ldg-q">
          Sun close to the horizon{landingCheck.where ? ` at ${landingCheck.where}` : ''} — is this
          landing in the right column?
        </p>
        <p class="ldg-note">
          Taxi time is not logged, so the app cannot tell which side of civil twilight the wheels
          touched down on. It has put
          {landingCheck.count}
          {landingCheck.count === 1 ? 'landing' : 'landings'} in the
          <b>{landingCheck.column}</b> column.
        </p>
        <div class="ldg-actions">
          <button type="button" class="btn ghost" onclick={swapLanding}>
            {landingCheck.swapLabel}
          </button>
          <button type="button" class="btn ghost ldg-yes" onclick={confirmLanding}>
            {landingCheck.confirmLabel}
          </button>
        </div>
      </div>
    {/if}
  </div>
{/snippet}

<section class="form-view">
  <header class="bar">
    <button type="button" class="btn ghost back" onclick={requestCancel}>← Back</button>
    <h1>{isEdit ? 'Edit entry' : isFstd ? 'Add simulator' : 'Add flight'}</h1>
    <button type="button" class="btn primary" onclick={save} disabled={saving || !ready}>
      {saving ? 'Saving…' : 'Save'}
    </button>
  </header>

  <!--
    Mode toggle. One screen, two shapes: switching it changes which registry
    fields apply, which are required, and which are filled in automatically.
    Nothing typed is discarded — the model spans every field, and only the
    slice belonging to the active mode is submitted.
  -->
  <div class="mode-toggle">
    <div class="seg" role="group" aria-label="Entry type">
      <button
        type="button"
        class="seg-btn"
        class:on={!isFstd}
        aria-pressed={!isFstd}
        onclick={() => (entryType = 'flight')}
      >
        Flight
      </button>
      <button
        type="button"
        class="seg-btn"
        class:on={isFstd}
        aria-pressed={isFstd}
        onclick={() => (entryType = 'fstd')}
      >
        Simulator
      </button>
    </div>
    {#if isFstd}
      <p class="mode-note">Simulator time is logged separately and never counts as flight time.</p>
    {/if}
  </div>

  {#if ready}
    <form
      class="body"
      bind:this={formEl}
      onsubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {#if generalError}
        <p class="general-error" role="alert">{generalError}</p>
      {/if}

      <div class="grid">
        {#each quickFields as field (field.key)}
          <!-- The two landing counts are rendered together by `landingsGroup`,
               anchored at the first of them so they keep their place in the
               registry's own order. -->
          {#if field.key === LANDING_KEYS[0]}
            {@render landingsGroup()}
          {:else if !isLandingKey(field.key)}
            {@render fieldCell(field)}
          {/if}
        {/each}
      </div>

      <!--
        The clock the block times above are being typed on.

        BELOW the fields rather than above them, and quiet: UTC is the default,
        it is what nearly every entry uses, and a prominent control at the top
        of the form would make a settled question look open. A pilot who logs
        off their watch changes it once and the app remembers; everyone else
        never has to notice it is there.

        Hidden for a simulator session, which has no block times at all.
      -->
      {#if !isFstd}
        <div class="zone-row" class:local={zoneOffset !== 0}>
          <label for="entry-zone">Block times entered in</label>
          <select
            id="entry-zone"
            value={zoneOffset}
            onchange={(e) => changeZone(Number(e.currentTarget.value))}
          >
            {#each UTC_OFFSETS as offset (offset)}
              <option value={offset}>
                {offset === 0 ? 'UTC (Zulu)' : `Local time — ${formatOffset(offset)}`}
              </option>
            {/each}
          </select>
          {#if zoneOffset !== 0}
            <p class="zone-note">
              Converted to UTC when saved. The logbook always stores UTC — nothing is
              recorded in local time.
            </p>
          {/if}
        </div>
      {/if}

      <!--
        Overlapping entries. Advisory: no button is disabled and `save` never
        looks at this. It carries the conflicting entry's own data so the pilot
        can tell which of the two is wrong without leaving the form.
      -->
      {#if conflicts.length > 0}
        <div class="conflict" role="status" aria-live="polite">
          <p class="conflict-q">
            {conflicts.length === 1
              ? 'These block times overlap an entry already in the logbook:'
              : `These block times overlap ${conflicts.length} entries already in the logbook:`}
          </p>
          <ul class="conflict-list">
            {#each conflicts as c (c.id)}
              <li>
                <span class="mono">{c.date}</span>
                <span>{c.depAerodrome} → {c.arrAerodrome}</span>
                <span class="mono">{c.registration || '—'}</span>
                <!-- The stored (UTC) times of the OTHER entry, on the pilot's
                     clock. Never shifted into the entry zone: this is what is
                     in the logbook, and the point is to compare against it. -->
                <span class="mono"
                  >{formatTimeOfDay(c.offBlock, clock)}–{formatTimeOfDay(c.onBlock, clock)}</span
                >
              </li>
            {/each}
          </ul>
          <p class="conflict-note">
            A pilot cannot be in two places at once, so one of these is wrong. Saving is still
            allowed — you may be about to correct the other entry.
          </p>
        </div>
      {/if}

      <!--
        Time columns that do not fit inside the total. Advisory in the same way
        the overlap warning is: nothing is disabled and `save` never reads it.
        Shares the amber styling on purpose — it is another thing the form is
        telling you, not a validation failure.
      -->
      {#if sumFindings.length > 0}
        <div class="conflict" role="status" aria-live="polite">
          <p class="conflict-q">
            <!-- Named from the finding rather than hardcoded: on a simulator
                 session the yardstick is the session time, not a total. -->
            {sumFindings.length === 1 ? 'This time does not' : 'These times do not'} fit inside the
            {yardstickPhrase(sumFindings[0].yardstickKey)}:
          </p>
          <ul class="conflict-list">
            {#each sumFindings as finding (finding.keys.join(','))}
              <li>{sumMessage(finding)}</li>
            {/each}
          </ul>
          <p class="conflict-note">
            <!-- The PIC-and-instructor explanation only makes sense of a function-time
                 finding. An IFR overrun has no such innocent explanation. -->
            {#if !isFstd && sumFindings.some((f) => f.kind === 'pilotFunction')}
              Worth a second look, but saving is still allowed — a flight logged as both PIC and
              instructor really does add up to twice its total.
            {:else}
              Worth a second look, but saving is still allowed.
            {/if}
          </p>
        </div>
      {/if}

      <!--
        Unknown registration. Deliberately compact and never blocking: the Save
        button in the sticky header stays reachable, and ignoring this entirely
        still saves the flight (the class falls back to the setting).
      -->
      {#if askReg}
        <div class="ac-prompt">
          <p class="ac-q">
            <b class="mono">{askReg}</b> — new aircraft. Single or multi-engine?
          </p>
          <div class="ac-row">
            <div class="seg" role="group" aria-label="Aircraft class">
              <button
                type="button"
                class="seg-btn"
                class:on={askClass === 'SE'}
                aria-pressed={askClass === 'SE'}
                onclick={() => (askClass = 'SE')}
              >
                Single-engine
              </button>
              <button
                type="button"
                class="seg-btn"
                class:on={askClass === 'ME'}
                aria-pressed={askClass === 'ME'}
                onclick={() => (askClass = 'ME')}
              >
                Multi-engine
              </button>
            </div>
            <label class="ac-mp">
              <input type="checkbox" bind:checked={askMultiPilot} />
              Multi-pilot
            </label>
          </div>
          <div class="ac-actions">
            <button type="button" class="btn ghost ac-skip" onclick={skipAircraftPrompt}>
              Not now
            </button>
            <button type="button" class="btn primary ac-save" onclick={rememberAircraft}>
              Remember
            </button>
          </div>
        </div>
      {/if}

      <details class="more" bind:open={showDetail}>
        <summary>
          <span class="more-label">More</span>
          <span class="more-sub">{detailFields.length} further EASA columns</span>
        </summary>
        <div class="grid">
          {#each detailFields as field (field.key)}
            {@render fieldCell(field)}
          {/each}
        </div>
      </details>

      <!-- Allow Enter-to-submit from the last field without a visible duplicate button. -->
      <button type="submit" class="visually-hidden" tabindex="-1" aria-hidden="true">Save</button>

      <div class="footer-actions">
        {#if isEdit}
          <button type="button" class="btn danger" onclick={() => (showDelete = true)}>
            Delete
          </button>
        {/if}
        <div class="spacer"></div>
        <button type="button" class="btn ghost" onclick={requestCancel}>Cancel</button>
        <button type="button" class="btn primary" onclick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save flight'}
        </button>
      </div>
    </form>
  {/if}
</section>

{#if showDiscard}
  <ConfirmDialog
    title="Discard changes?"
    message="You have unsaved changes. Leave without saving?"
    confirmLabel="Discard"
    cancelLabel="Keep editing"
    danger
    onConfirm={() => {
      showDiscard = false;
      onCancel();
    }}
    onCancel={() => (showDiscard = false)}
  />
{/if}

{#if showDelete}
  <ConfirmDialog
    title="Delete this flight?"
    message="This cannot be undone."
    confirmLabel="Delete"
    danger
    onConfirm={confirmDelete}
    onCancel={() => (showDelete = false)}
  />
{/if}

<style>
  .form-view {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }
  .bar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 0.5rem;
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
  .bar .primary {
    justify-self: end;
  }
  .body {
    flex: 1 1 auto;
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
    padding: 1rem 0.9rem 6rem;
  }
  .general-error {
    margin: 0 0 1rem;
    padding: 0.6rem 0.8rem;
    background: var(--danger-soft);
    color: var(--danger);
    border-radius: var(--radius);
    font-size: 0.9rem;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
  }
  @media (min-width: 560px) {
    .grid {
      grid-template-columns: 1fr 1fr;
    }
    .cell.span-all {
      grid-column: 1 / -1;
    }
  }
  /*
    The landing block. The role toggle and the two counts read as one unit —
    a shared ground and one border around them — because the toggle only makes
    sense as a statement about the fields beneath it.
  */
  .landings {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.7rem 0.75rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
  }
  /*
    Full width and split down the middle, unlike the inline `.seg` elsewhere:
    "Pilot Monitoring" does not fit in a shrink-to-fit segment at 375px, and two
    halves of equal width make the pair read as one either/or.
  */
  .landings .role {
    display: flex;
    width: 100%;
    background: var(--surface);
  }
  .landings .role .seg-btn {
    flex: 1 1 0;
    min-width: 0;
    padding: 0 0.5rem;
  }
  /*
    Side by side at every width, including 375px. The stepper's own layout
    holds up: the two buttons keep their full touch target and the number
    between them takes what is left.
  */
  .landing-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  /*
    Two steppers in one row is the tightest thing on the form. Below the 375px
    the rest of it is drawn for, the block gives back its own padding and gap
    rather than let either count start clipping — the +/- buttons keep their
    full touch target, so the number between them is what would have gone.
  */
  @media (max-width: 380px) {
    .landings {
      padding-left: 0.5rem;
      padding-right: 0.5rem;
    }
    .landing-fields {
      gap: 0.4rem;
    }
  }
  /*
    The landing question. Amber like the overlap warning, and for the same
    reason: it is the form telling you something, not refusing to save.
  */
  .ldg-check {
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--night);
    border-radius: var(--radius);
    background: var(--surface);
  }
  .ldg-q {
    margin: 0;
    font-size: 0.88rem;
    font-weight: 650;
    color: var(--night);
  }
  .ldg-note {
    margin: 0.35rem 0 0;
    font-size: 0.82rem;
    color: var(--text-muted);
  }
  .ldg-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.45rem;
    margin-top: 0.55rem;
  }
  .ldg-actions .btn {
    min-height: 2.4rem;
    padding: 0 0.85rem;
    font-size: 0.85rem;
  }
  .ldg-actions .ldg-yes {
    border-color: var(--night);
    color: var(--night);
  }

  /*
    The entry-zone row. Deliberately the quietest control on the form while it
    reads UTC — one line of muted text and a select — and only then given a
    border and a tinted ground, so "I am typing local time" is a visible state
    rather than a dropdown nobody re-reads.
  */
  .zone-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.9rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid transparent;
    border-radius: var(--radius);
    font-size: 0.82rem;
    color: var(--text-faint);
  }
  .zone-row.local {
    border-color: var(--border);
    background: var(--surface-2);
    color: var(--text-muted);
  }
  .zone-row select {
    min-height: var(--touch);
    padding: 0.35rem 0.5rem;
    font-size: 0.9rem;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .zone-note {
    flex: 1 0 100%;
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-faint);
  }
  /*
    Unknown-aircraft prompt. Kept to three short rows so it can't push the
    footer Save button off a phone screen; the header Save is sticky regardless.
  */
  .ac-prompt {
    margin-top: 1rem;
    padding: 0.7rem 0.85rem;
    border: 1px solid var(--accent);
    border-radius: var(--radius-lg);
    background: var(--accent-soft);
  }
  .ac-q {
    margin: 0 0 0.55rem;
    font-size: 0.9rem;
  }
  .ac-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.9rem;
  }
  /* Mode toggle: sits directly under the app bar, above the form body, so the
     shape of what follows is decided before anything is typed. */
  .mode-toggle {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    /* Keeps the control at its natural width. Without it the stretch default
       pulls a two-word switch across the whole screen. */
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.75rem 1rem 0;
  }
  .mode-note {
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-faint);
  }
  /*
    A segmented control — one recessed track carrying a raised thumb — rather
    than two adjoining buttons. Choosing between two shapes of the same record
    is a small decision, and a full-width pair of slabs filled with the accent
    colour announced it as the most important thing on the screen.

    NOTE WHAT IS NOT HERE: a `flex` shorthand. `.mode-toggle` is a COLUMN, so a
    flex-basis on this element sets its HEIGHT, not its width. An earlier
    `flex: 1 1 15rem`, written as if the parent were a row, is what rendered the
    control 240px tall.
  */
  .seg {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
  }
  .seg-btn {
    min-height: 36px;
    padding: 0 1.05rem;
    border: none;
    border-radius: calc(var(--radius) - 3px);
    background: transparent;
    color: var(--text-muted);
    font-size: 0.875rem;
    font-weight: 600;
    transition:
      background var(--speed) ease,
      color var(--speed) ease,
      box-shadow var(--speed) ease;
  }
  .seg-btn:hover:not(.on) {
    color: var(--text);
  }
  .seg-btn.on {
    background: var(--surface);
    color: var(--accent);
    box-shadow: var(--shadow-sm);
  }
  /* A finger needs the full target even though a cursor does not. */
  @media (pointer: coarse) {
    .seg-btn {
      min-height: var(--touch);
    }
  }
  .ac-mp {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-height: var(--touch);
    font-size: 0.9rem;
    cursor: pointer;
  }
  .ac-mp input {
    width: 1.15rem;
    height: 1.15rem;
    accent-color: var(--accent);
  }
  .ac-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.55rem;
  }
  .ac-actions .btn {
    min-height: 2.4rem;
    padding: 0 0.9rem;
    font-size: 0.9rem;
  }

  /*
    Overlap warning. Amber, not red: it is advisory, and nothing about it
    disables a control. Styled like the aircraft prompt so it reads as another
    thing the form is telling you, not as a validation failure.
  */
  .conflict {
    margin-top: 1rem;
    padding: 0.7rem 0.85rem;
    border: 1px solid var(--night);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
  }
  .conflict-q {
    margin: 0 0 0.5rem;
    font-size: 0.9rem;
    font-weight: 650;
    color: var(--night);
  }
  .conflict-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.88rem;
  }
  .conflict-list li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.3rem 0.8rem;
  }
  .conflict-note {
    margin: 0.55rem 0 0;
    font-size: 0.82rem;
    color: var(--text-muted);
  }

  .more {
    margin-top: 1.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
  }
  .more summary {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    min-height: var(--touch);
    padding: 0.75rem 0.9rem;
    cursor: pointer;
    list-style: none;
    user-select: none;
    border-radius: var(--radius-lg);
    transition: background var(--speed) ease;
  }
  .more summary::-webkit-details-marker {
    display: none;
  }
  .more summary:hover {
    background: var(--surface-2);
  }
  /* Disclosure caret, rotating on open. */
  .more summary::before {
    content: '›';
    display: inline-block;
    font-size: 1.2rem;
    line-height: 1;
    color: var(--text-muted);
    transition: transform var(--speed) ease;
  }
  .more[open] summary::before {
    transform: rotate(90deg);
  }
  .more-label {
    font-weight: 650;
  }
  .more-sub {
    color: var(--text-faint);
    font-size: 0.82rem;
  }
  .more .grid {
    padding: 0.25rem 0.9rem 1rem;
  }

  .footer-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 1.5rem;
  }
  .footer-actions .spacer {
    flex: 1 1 auto;
  }
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
</style>
