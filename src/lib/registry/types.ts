/** Field registry types. */
import type { EntryType } from '../domain/flight';

/**
 * A field property whose value depends on the kind of entry being logged.
 *
 * Pass a bare value when a field behaves the same everywhere, or a partial map
 * keyed by `EntryType` to vary it. Unlisted entry types fall back to the
 * property's documented default, so `{ fstd: 'quick' }` reads as "quick in
 * simulator mode, unchanged elsewhere".
 *
 * This exists because FSTD entries legitimately lack fields a flight requires —
 * block times, a registration — and legitimately promote fields a flight buries.
 * Expressing that here keeps it registry data rather than `if (key === ...)`
 * comparisons scattered through the form, which is the rule in §5 of the
 * context document.
 */
export type PerEntryType<T> = T | Readonly<Partial<Record<EntryType, T>>>;

export type FieldType =
  | 'date'
  | 'text'
  | 'icao'
  | 'timeOfDay'
  | 'durationMinutes'
  | 'count'
  | 'remarks';

export type FieldStorage = 'core' | 'extra';

/**
 * The part this field plays in aircraft lookup, if any.
 *
 * `registration` is the field whose value keys the aircraft store — committing
 * it triggers the lookup. `type` is the field prefilled from a known aircraft.
 * Declaring the roles here keeps the entry form from hardcoding field keys,
 * per §5 of the context doc.
 */
export type AircraftRole = 'registration' | 'type';

/**
 * Which part of the entry form a field belongs to.
 *
 * `quick` fields render inline; `detail` fields render inside a collapsed
 * "More" disclosure. This split exists to protect the 15-second entry target:
 * a full EASA logbook has twelve time columns, and putting them all inline
 * would make routine entry unusable. Required to be set explicitly on every
 * entry — there is no default, so adding a field forces the decision.
 */
export type FieldSection = 'quick' | 'detail';

/**
 * A single logbook field definition. The whole app — forms, list columns, CSV
 * mapping, totals, validation — is generated from these entries. Adding a new
 * field is a single new entry; fields with `storage: "extra"` require NO change
 * to the storage layer (they ride along in `Flight.extra`).
 */
export interface FieldDefinition {
  /** Property name on `Flight`, or a key inside `Flight.extra` for future fields. */
  key: string;
  /** UI label, e.g. "PIC". */
  label: string;
  type: FieldType;
  /** EASA logbook column header used for CSV export, e.g. "Total Time of Flight". */
  easaColumn: string;
  /**
   * Whether the field must be present and non-empty.
   *
   * May vary by entry type: `registration` and the block times are required of
   * a flight but meaningless on a simulator session, so they carry
   * `{ flight: true, fstd: false }`. Resolve with `isRequiredFor`, never by
   * reading this property directly.
   */
  required: PerEntryType<boolean>;
  /** Whether the field participates in totals (durations and landings). */
  summable: boolean;
  /** Where the value lives: on the Flight object (`core`) or inside `extra`. */
  storage: FieldStorage;
  /**
   * Inline in the form (`quick`) or behind the collapsed "More" section
   * (`detail`).
   *
   * May vary by entry type: the simulator time fields are the primary inputs of
   * simulator mode but have no place in a flight, and instrument/instructor/
   * dual time move inline in simulator mode because they are most of what a
   * session records. Resolve with `sectionFor`, never by reading this directly.
   */
  section: PerEntryType<FieldSection>;
  /**
   * Which entry types this field applies to at all. Omitted means every type.
   *
   * A field that does not apply is not merely hidden — it is not part of that
   * entry type's form, is not validated for it, and keeps its default value.
   * `offBlock` on a simulator session is the example: there is no such thing.
   */
  entryTypes?: readonly EntryType[];
  /**
   * Entry types for which this field is filled in by the app rather than typed
   * by the pilot. It still applies, is still validated and still exported — it
   * simply has no input in the form.
   *
   * This is how the aerodromes carry the literal `"SIM"` on an FSTD entry
   * while remaining ordinary required columns, and how `entryType` itself stays
   * an exported column that the mode toggle owns rather than a form field.
   */
  autoFilledFor?: readonly EntryType[];

  // --- UI metadata (optional; keeps components registry-driven) -------------

  /** Placeholder text for the form input. */
  placeholder?: string;
  /** A short hint shown under the input in the form. */
  inputHint?: string;
  /**
   * Order of this field in the add/edit form (lower first). The array order of
   * `FIELDS` remains the EASA column order used by the list table and CSV; the
   * form uses a pilot-friendly order instead.
   */
  formOrder?: number;
  /**
   * When adding a flight, pre-fill this field from the most recent flight for
   * fast repeat entry (e.g. aircraft type, registration, PIC name).
   */
  stickyDefault?: boolean;
  /**
   * Show a "= total" convenience button next to this field that copies the
   * total time into it (the common private-pilot case for PIC time).
   */
  copyTotalAction?: boolean;
  /**
   * Show a "work it out" button next to this field that fills it with night
   * time calculated from the date, the block times and the two aerodromes.
   *
   * Declared here rather than by the form testing for a field key, so the
   * night calculation is attached to the field that means night in exactly the
   * way the wand is attached to the fields that take a copy of the total.
   * Exactly one field carries it, and a registry test says so.
   */
  nightAction?: boolean;
  /**
   * Marks this field as the aircraft-lookup key or the prefill target. Lets the
   * form drive registration lookup and type prefill from the registry rather
   * than from hardcoded key comparisons.
   */
  aircraftRole?: AircraftRole;
}
