import { describe, it, expect } from 'vitest';
import {
  appliesTo,
  detailFieldsFor,
  ENTRY_TYPES,
  FIELDS,
  FORM_FIELDS,
  formFieldsFor,
  getNightField,
  isAutoFilledFor,
  isRequiredFor,
  QUICK_FIELDS,
  quickFieldsFor,
  sectionFor,
  DETAIL_FIELDS,
  SUMMABLE_FIELDS,
} from './fields';
import type { Flight } from '../domain/flight';

/**
 * A complete `Flight` literal used purely as a runtime list of the type's keys.
 *
 * TypeScript will not compile this object if a field is missing or misspelled,
 * so it stays in step with the interface automatically — which is what makes
 * the "every core registry key exists on Flight" assertion below meaningful
 * rather than a copy of the registry.
 */
const FLIGHT_SHAPE: Flight = {
  id: '',
  schemaVersion: 3,
  entryType: 'flight',
  date: '',
  depAerodrome: '',
  arrAerodrome: '',
  offBlock: '',
  onBlock: '',
  aircraftType: '',
  registration: '',
  picName: '',
  totalMinutes: 0,
  picMinutes: 0,
  singlePilotSeMinutes: 0,
  singlePilotMeMinutes: 0,
  multiPilotMinutes: 0,
  coPilotMinutes: 0,
  dualMinutes: 0,
  instructorMinutes: 0,
  nightMinutes: 0,
  ifrMinutes: 0,
  landingsDay: 0,
  landingsNight: 0,
  simulatorMinutes: 0,
  simulatorRegistration: '',
  remarks: '',
  extra: {},
};

const FLIGHT_KEYS = Object.keys(FLIGHT_SHAPE);

describe('registry integrity', () => {
  it('has no duplicate keys', () => {
    const keys = FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every core field exists on the Flight type', () => {
    const missing = FIELDS.filter((f) => f.storage === 'core' && !FLIGHT_KEYS.includes(f.key));
    expect(missing.map((f) => f.key)).toEqual([]);
  });

  it('every entry carries the required definition properties', () => {
    for (const field of FIELDS) {
      expect(field.key, `key on ${field.key}`).toBeTruthy();
      expect(field.label, `label on ${field.key}`).toBeTruthy();
      expect(field.easaColumn, `easaColumn on ${field.key}`).toBeTruthy();
      // `required` may vary by entry type since v3, so assert the RESOLVED
      // value for every entry type rather than the raw property.
      for (const entryType of ENTRY_TYPES) {
        expect(
          typeof isRequiredFor(field, entryType),
          `required on ${field.key} for ${entryType}`,
        ).toBe('boolean');
      }
      expect(typeof field.summable, `summable on ${field.key}`).toBe('boolean');
      expect(['core', 'extra']).toContain(field.storage);
    }
  });

  it('every easaColumn is unique', () => {
    const columns = FIELDS.map((f) => f.easaColumn);
    expect(new Set(columns).size).toBe(columns.length);
  });
});

describe('registry sections', () => {
  it('every entry has a valid section in every entry type', () => {
    for (const field of FIELDS) {
      for (const entryType of ENTRY_TYPES) {
        expect(['quick', 'detail'], `section on ${field.key} for ${entryType}`).toContain(
          sectionFor(field, entryType),
        );
      }
    }
  });

  /**
   * Since v3 a field can be absent from an entry type entirely (`entryTypes`)
   * or filled in by the app rather than typed (`autoFilledFor`), so "quick plus
   * detail is the whole registry" only holds per entry type and only over the
   * fields that entry type actually renders. The property being protected is
   * unchanged: every rendered field lands in exactly one section, and nothing
   * is silently orphaned.
   */
  it('splits cleanly — quick and detail together are the whole rendered form', () => {
    for (const entryType of ENTRY_TYPES) {
      const form = formFieldsFor(entryType);
      expect(
        quickFieldsFor(entryType).length + detailFieldsFor(entryType).length,
        `sections cover the form for ${entryType}`,
      ).toBe(form.length);
    }
  });

  it('accounts for every field: rendered, auto-filled, or not applicable', () => {
    for (const entryType of ENTRY_TYPES) {
      const rendered = formFieldsFor(entryType).length;
      const autoFilled = FIELDS.filter(
        (f) => appliesTo(f, entryType) && isAutoFilledFor(f, entryType),
      ).length;
      const notApplicable = FIELDS.filter((f) => !appliesTo(f, entryType)).length;
      expect(rendered + autoFilled + notApplicable, `every field placed for ${entryType}`).toBe(
        FIELDS.length,
      );
    }
  });

  /**
   * The 15-second entry target depends on the inline form staying short. This
   * bound is deliberately tight so a future prompt cannot quietly grow it —
   * if you need to raise it, that should be a conscious decision with a reason.
   *
   * v3 made it PER ENTRY TYPE rather than raising it. What the bound protects
   * is how many fields are on screen at once, and no single mode shows them
   * all — so counting the whole registry would have punished simulator mode for
   * fields it never renders.
   */
  it('keeps the quick set small in every entry type', () => {
    for (const entryType of ENTRY_TYPES) {
      expect(quickFieldsFor(entryType).length, `quick set for ${entryType}`).toBeLessThanOrEqual(
        12,
      );
    }
  });

  /**
   * The bare exports are what components that only ever show a flight import.
   * Pinning them to the flight-mode resolution stops the two drifting apart.
   */
  it('the bare FORM/QUICK/DETAIL exports are the flight-mode lists', () => {
    expect(FORM_FIELDS).toEqual(formFieldsFor('flight'));
    expect(QUICK_FIELDS).toEqual(quickFieldsFor('flight'));
    expect(DETAIL_FIELDS).toEqual(detailFieldsFor('flight'));
  });

  it('keeps every EASA function- and condition-time column out of the quick set', () => {
    const quickKeys = QUICK_FIELDS.map((f) => f.key);
    for (const key of [
      'singlePilotSeMinutes',
      'singlePilotMeMinutes',
      'multiPilotMinutes',
      'coPilotMinutes',
      'dualMinutes',
      'instructorMinutes',
      'nightMinutes',
      'ifrMinutes',
    ]) {
      expect(quickKeys, `${key} belongs in detail`).not.toContain(key);
    }
  });
});

describe('registry totals', () => {
  it('marks the six new EASA time columns summable', () => {
    const summableKeys = SUMMABLE_FIELDS.map((f) => f.key);
    for (const key of [
      'singlePilotSeMinutes',
      'singlePilotMeMinutes',
      'coPilotMinutes',
      'dualMinutes',
      'instructorMinutes',
      'ifrMinutes',
    ]) {
      expect(summableKeys).toContain(key);
    }
  });

  it('never marks a text field summable', () => {
    for (const field of SUMMABLE_FIELDS) {
      expect(['durationMinutes', 'count'], `${field.key} is ${field.type}`).toContain(field.type);
    }
  });
});

describe('the night action', () => {
  it('is carried by exactly one field', () => {
    // The entry form asks the registry which field means night rather than
    // knowing the key. Two fields claiming it would mean the form silently
    // picked one; none would mean the button quietly disappeared.
    const claimants = FIELDS.filter((f) => f.nightAction);
    expect(claimants).toHaveLength(1);
    expect(getNightField()).toBe(claimants[0]);
  });

  it('is on a duration field that only a flight has', () => {
    const field = getNightField();
    expect(field?.key).toBe('nightMinutes');
    expect(field?.type).toBe('durationMinutes');
    // There is no sun in a simulator, and the field is not part of that form.
    expect(appliesTo(field!, 'fstd')).toBe(false);
  });
});
