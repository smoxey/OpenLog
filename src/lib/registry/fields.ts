/**
 * The field registry — the extensibility core.
 *
 * A single ordered array of field definitions, in standard EASA logbook column
 * order. The rest of the app is generated from this array. To add a future
 * field append ONE entry; a field with `storage: "extra"` needs no storage-layer
 * change at all, and a field with `storage: "core"` needs only a `Flight`
 * property plus a migration step.
 *
 * Every entry must declare a `section`: `quick` renders inline in the entry
 * form, `detail` renders behind the collapsed "More" disclosure. There is no
 * default — adding a field forces that decision, because the 15-second entry
 * target depends on the inline set staying short.
 *
 * Since v3 the form has two MODES — logging a flight and logging a simulator
 * session — and `required`, `section` and applicability may all differ between
 * them. That variation lives here as data (`PerEntryType`, `entryTypes`,
 * `autoFilledFor`) rather than as key comparisons in components. Resolve it
 * through `sectionFor`, `isRequiredFor`, `appliesTo` and the `*For(entryType)`
 * helpers below; never read `required` or `section` off a definition directly.
 */
import type { AircraftRole, FieldDefinition, FieldSection, PerEntryType } from './types';
import type { EntryType } from '../domain/flight';

export const FIELDS: readonly FieldDefinition[] = [
  {
    key: 'date',
    label: 'Date',
    type: 'date',
    easaColumn: 'Date',
    required: true,
    summable: false,
    storage: 'core',
    section: 'quick',
    formOrder: 1,
  },
  {
    key: 'depAerodrome',
    label: 'From',
    type: 'icao',
    easaColumn: 'Departure Place',
    // Still a required column on an FSTD entry — it carries the literal "SIM".
    autoFilledFor: ['fstd'],
    required: true,
    summable: false,
    storage: 'core',
    section: 'quick',
    placeholder: 'ENGM',
    inputHint: 'ICAO code',
    formOrder: 2,
  },
  {
    key: 'offBlock',
    label: 'Off Block',
    type: 'timeOfDay',
    easaColumn: 'Departure Time',
    entryTypes: ['flight'],
    required: true,
    summable: false,
    storage: 'core',
    section: 'quick',
    inputHint: 'UTC',
    formOrder: 3,
  },
  {
    key: 'arrAerodrome',
    label: 'To',
    type: 'icao',
    easaColumn: 'Arrival Place',
    autoFilledFor: ['fstd'],
    required: true,
    summable: false,
    storage: 'core',
    section: 'quick',
    placeholder: 'ENBR',
    inputHint: 'ICAO code',
    formOrder: 4,
  },
  {
    key: 'onBlock',
    label: 'On Block',
    type: 'timeOfDay',
    easaColumn: 'Arrival Time',
    entryTypes: ['flight'],
    required: true,
    summable: false,
    storage: 'core',
    section: 'quick',
    inputHint: 'UTC',
    formOrder: 5,
  },
  {
    key: 'aircraftType',
    label: 'Type',
    type: 'text',
    easaColumn: 'Aircraft Type',
    required: true,
    summable: false,
    storage: 'core',
    section: 'quick',
    placeholder: 'C172',
    stickyDefault: true,
    aircraftRole: 'type',
    formOrder: 6,
  },
  {
    key: 'registration',
    label: 'Registration',
    type: 'text',
    easaColumn: 'Aircraft Registration',
    // A simulator has no registration; it has a device id. See
    // `simulatorRegistration`, which is a separate field precisely so the
    // aircraft lookup attached to this one never sees a device.
    entryTypes: ['flight'],
    required: true,
    summable: false,
    storage: 'core',
    section: 'quick',
    placeholder: 'LN-ABC',
    stickyDefault: true,
    aircraftRole: 'registration',
    formOrder: 7,
  },
  {
    key: 'singlePilotSeMinutes',
    label: 'SE',
    type: 'durationMinutes',
    easaColumn: 'Single Pilot Time SE',
    entryTypes: ['flight'],
    required: false,
    summable: true,
    storage: 'core',
    section: 'detail',
    inputHint: 'Single-engine',
    formOrder: 16,
  },
  {
    key: 'singlePilotMeMinutes',
    label: 'ME',
    type: 'durationMinutes',
    easaColumn: 'Single Pilot Time ME',
    entryTypes: ['flight'],
    required: false,
    summable: true,
    storage: 'core',
    section: 'detail',
    inputHint: 'Multi-engine',
    formOrder: 17,
  },
  {
    key: 'multiPilotMinutes',
    label: 'Multi-Pilot',
    type: 'durationMinutes',
    easaColumn: 'Multi-Pilot Time',
    entryTypes: ['flight'],
    required: false,
    summable: true,
    storage: 'core',
    section: 'detail',
    formOrder: 11,
  },
  {
    key: 'totalMinutes',
    label: 'Total',
    type: 'durationMinutes',
    easaColumn: 'Total Time of Flight',
    // Forced to 0 on an FSTD entry — simulator time is never flight time.
    autoFilledFor: ['fstd'],
    required: { flight: true, fstd: false },
    summable: true,
    storage: 'core',
    section: 'quick',
    formOrder: 9,
  },
  {
    key: 'picName',
    label: 'PIC Name',
    type: 'text',
    easaColumn: 'Name PIC',
    entryTypes: ['flight'],
    // Optional by decision: the pilot does not log PIC names, and is not the
    // PIC on most of these flights. An empty value is correct, not an error —
    // never substitute "SELF" or any other placeholder.
    required: false,
    summable: false,
    storage: 'core',
    // Moved out of `quick` for the same reason: a field that is nearly always
    // left blank should not occupy one of the inline slots that the 15-second
    // entry target depends on.
    section: 'detail',
    placeholder: 'Optional',
    stickyDefault: true,
    formOrder: 8,
  },
  {
    key: 'landingsDay',
    label: 'Ldg Day',
    type: 'count',
    easaColumn: 'Landings Day',
    entryTypes: ['flight'],
    required: false,
    summable: true,
    storage: 'core',
    section: 'quick',
    formOrder: 13,
  },
  {
    key: 'landingsNight',
    label: 'Ldg Night',
    type: 'count',
    easaColumn: 'Landings Night',
    entryTypes: ['flight'],
    required: false,
    summable: true,
    storage: 'core',
    // Inline, beside its day counterpart. The pair is one question — where did
    // this landing go — and answering it with the night half hidden behind
    // "More" meant a night landing cost a disclosure click to correct, on the
    // very entries where the calculation is least sure of itself.
    section: 'quick',
    formOrder: 14,
  },
  {
    key: 'nightMinutes',
    label: 'Night',
    type: 'durationMinutes',
    easaColumn: 'Operational Condition Time Night',
    entryTypes: ['flight'],
    required: false,
    summable: true,
    storage: 'core',
    section: 'detail',
    formOrder: 12,
    nightAction: true,
  },
  {
    key: 'ifrMinutes',
    label: 'IFR',
    type: 'durationMinutes',
    easaColumn: 'Operational Condition Time IFR',
    required: false,
    summable: true,
    storage: 'core',
    // Instrument time is most of what a simulator session records, so it comes
    // inline there while staying behind "More" for a flight.
    section: { flight: 'detail', fstd: 'quick' },
    copyTotalAction: true,
    formOrder: 21,
  },
  {
    key: 'picMinutes',
    label: 'PIC',
    type: 'durationMinutes',
    easaColumn: 'Pilot Function Time PIC',
    entryTypes: ['flight'],
    required: false,
    summable: true,
    storage: 'core',
    section: 'quick',
    copyTotalAction: true,
    formOrder: 10,
  },
  {
    key: 'coPilotMinutes',
    label: 'Co-Pilot',
    type: 'durationMinutes',
    easaColumn: 'Pilot Function Time Co-Pilot',
    entryTypes: ['flight'],
    required: false,
    summable: true,
    storage: 'core',
    section: 'detail',
    formOrder: 18,
  },
  {
    key: 'dualMinutes',
    label: 'Dual',
    type: 'durationMinutes',
    easaColumn: 'Pilot Function Time Dual',
    required: false,
    summable: true,
    storage: 'core',
    // Dual RECEIVED. Inline in simulator mode alongside instrument and
    // instructor time; behind "More" for a flight.
    section: { flight: 'detail', fstd: 'quick' },
    copyTotalAction: true,
    formOrder: 19,
  },
  {
    key: 'instructorMinutes',
    label: 'Instructor',
    type: 'durationMinutes',
    easaColumn: 'Pilot Function Time Instructor',
    required: false,
    summable: true,
    storage: 'core',
    section: { flight: 'detail', fstd: 'quick' },
    copyTotalAction: true,
    formOrder: 20,
  },
  {
    key: 'remarks',
    label: 'Remarks',
    type: 'remarks',
    easaColumn: 'Remarks and Endorsements',
    required: false,
    summable: false,
    storage: 'core',
    section: 'quick',
    placeholder: 'Approaches, endorsements, notes…',
    formOrder: 15,
  },

  // --- Beyond the EASA column set -------------------------------------------
  //
  // Array order IS the CSV column order, and "Remarks and Endorsements" is the
  // last column of a standard EASA logbook. Everything below is ours, so it is
  // appended AFTER the EASA set rather than interleaved: a competitor reading
  // our CSV sees the columns it expects, in the order it expects, and can
  // ignore the tail.
  {
    key: 'entryType',
    label: 'Entry Type',
    type: 'text',
    easaColumn: 'Entry Type',
    // Owned by the form's mode toggle, never typed. Present in every mode so a
    // CSV reader can tell a simulator session from a flight.
    autoFilledFor: ['flight', 'fstd'],
    required: true,
    summable: false,
    storage: 'core',
    section: 'detail',
  },
  {
    key: 'simulatorMinutes',
    label: 'Simulator',
    type: 'durationMinutes',
    easaColumn: 'FSTD Total Time of Session',
    entryTypes: ['fstd'],
    required: { fstd: true },
    // NOT summable. Simulator time never joins flight-time totals — that is the
    // governing rule of the whole entry-type design, and this flag is where it
    // is stated once for every total the registry drives.
    summable: false,
    storage: 'core',
    section: { fstd: 'quick' },
    formOrder: 22,
  },
  {
    key: 'simulatorRegistration',
    label: 'Device',
    type: 'text',
    easaColumn: 'FSTD Type',
    entryTypes: ['fstd'],
    // Optional, consistent with an unknown registration never blocking a save.
    required: false,
    summable: false,
    storage: 'core',
    section: { fstd: 'quick' },
    placeholder: 'EU-DK187',
    inputHint: 'Simulator device id',
    stickyDefault: true,
    formOrder: 23,
  },
] as const;

/** Every entry type the form can be in. */
export const ENTRY_TYPES: readonly EntryType[] = ['flight', 'fstd'];

/** The entry type assumed wherever one is not supplied. */
export const DEFAULT_ENTRY_TYPE: EntryType = 'flight';

/**
 * Resolve a possibly-per-entry-type property. A bare value applies everywhere;
 * a partial map falls back to `fallback` for entry types it does not list.
 */
function resolve<T>(value: PerEntryType<T>, entryType: EntryType, fallback: T): T {
  if (value !== null && typeof value === 'object') {
    return (value as Partial<Record<EntryType, T>>)[entryType] ?? fallback;
  }
  return value as T;
}

/** Whether a field exists at all for this entry type. */
export function appliesTo(field: FieldDefinition, entryType: EntryType): boolean {
  return field.entryTypes === undefined || field.entryTypes.includes(entryType);
}

/** Whether the app fills this field in rather than the pilot typing it. */
export function isAutoFilledFor(field: FieldDefinition, entryType: EntryType): boolean {
  return field.autoFilledFor?.includes(entryType) ?? false;
}

/** Whether this field must be present and non-empty for this entry type. */
export function isRequiredFor(field: FieldDefinition, entryType: EntryType): boolean {
  if (!appliesTo(field, entryType)) return false;
  return resolve(field.required, entryType, false);
}

/** Which part of the form this field belongs to for this entry type. */
export function sectionFor(field: FieldDefinition, entryType: EntryType): FieldSection {
  return resolve(field.section, entryType, 'detail');
}

/**
 * The field the "copy the whole session into this one" action reads FROM.
 *
 * A flight's yardstick is its total time; a simulator session's is its session
 * time. Keeping this a pure function rather than a conditional inside the form
 * is what makes the wand testable without rendering a component, and keeps the
 * one place that knows the pairing next to the registry that declares it.
 */
export function copySourceKey(entryType: EntryType): 'totalMinutes' | 'simulatorMinutes' {
  return entryType === 'fstd' ? 'simulatorMinutes' : 'totalMinutes';
}

/** Sort a set of fields into add/edit form order (falls back to array order). */
function byFormOrder(fields: readonly FieldDefinition[]): readonly FieldDefinition[] {
  return [...fields].sort((a, b) => (a.formOrder ?? 999) - (b.formOrder ?? 999));
}

/** Every field that applies to this entry type, whether rendered or not. */
export function fieldsFor(entryType: EntryType): readonly FieldDefinition[] {
  return FIELDS.filter((f) => appliesTo(f, entryType));
}

/** Fields this entry type actually renders an input for, in form order. */
export function formFieldsFor(entryType: EntryType): readonly FieldDefinition[] {
  return byFormOrder(fieldsFor(entryType).filter((f) => !isAutoFilledFor(f, entryType)));
}

/** Rendered inline for this entry type — kept deliberately short. */
export function quickFieldsFor(entryType: EntryType): readonly FieldDefinition[] {
  return formFieldsFor(entryType).filter((f) => sectionFor(f, entryType) === 'quick');
}

/** Rendered inside the collapsed "More" disclosure for this entry type. */
export function detailFieldsFor(entryType: EntryType): readonly FieldDefinition[] {
  return formFieldsFor(entryType).filter((f) => sectionFor(f, entryType) === 'detail');
}

/** Fields ordered for the add/edit form (ordinary flight entry). */
export const FORM_FIELDS: readonly FieldDefinition[] = formFieldsFor(DEFAULT_ENTRY_TYPE);

/** Fields rendered inline in the form — kept deliberately short. */
export const QUICK_FIELDS: readonly FieldDefinition[] = quickFieldsFor(DEFAULT_ENTRY_TYPE);

/** Fields rendered inside the collapsed "More" disclosure. */
export const DETAIL_FIELDS: readonly FieldDefinition[] = detailFieldsFor(DEFAULT_ENTRY_TYPE);

/** Look up a field definition by key. */
export function getField(key: string): FieldDefinition | undefined {
  return FIELDS.find((f) => f.key === key);
}

/** Look up the field playing a given aircraft role (see `AircraftRole`). */
export function getAircraftRoleField(role: AircraftRole): FieldDefinition | undefined {
  return FIELDS.find((f) => f.aircraftRole === role);
}

/**
 * The field the night calculation fills in, per the registry.
 *
 * Same reasoning as `getAircraftRoleField`: the entry form asks the registry
 * which field means night rather than knowing the key itself.
 */
export function getNightField(): FieldDefinition | undefined {
  return FIELDS.find((f) => f.nightAction);
}

/**
 * All fields that participate in totals.
 *
 * Note what is absent: `simulatorMinutes`. Simulator time is not summable, so
 * no total driven by this list can pick it up — which is why totals code needs
 * no `entryType` check to exclude it.
 */
export const SUMMABLE_FIELDS: readonly FieldDefinition[] = FIELDS.filter((f) => f.summable);

/** All fields required of an ordinary flight. */
export const REQUIRED_FIELDS: readonly FieldDefinition[] = FIELDS.filter((f) =>
  isRequiredFor(f, DEFAULT_ENTRY_TYPE),
);
