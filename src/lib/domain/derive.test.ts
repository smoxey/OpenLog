import { describe, it, expect } from 'vitest';
import { deriveAircraftTimes, resolveAircraftClass, DERIVED_TIME_FIELDS } from './derive';
import { normalizeRegistration, type Aircraft } from './aircraft';

/** A flight's derivable time slice, all columns empty. */
function times(totalMinutes: number) {
  return {
    totalMinutes,
    singlePilotSeMinutes: 0,
    singlePilotMeMinutes: 0,
    multiPilotMinutes: 0,
  };
}

function aircraft(overrides: Partial<Aircraft> = {}): Aircraft {
  return {
    registration: 'LN-ABC',
    type: 'C172',
    class: 'SE',
    multiPilot: false,
    ...overrides,
  };
}

describe('deriveAircraftTimes — known aircraft', () => {
  it('files a single-engine flight into SE and leaves ME at zero', () => {
    const result = deriveAircraftTimes(times(90), aircraft({ class: 'SE' }), 'ME');
    expect(result.singlePilotSeMinutes).toBe(90);
    expect(result.singlePilotMeMinutes).toBe(0);
    expect(result.multiPilotMinutes).toBe(0);
  });

  it('files a multi-engine flight into ME and leaves SE at zero', () => {
    const result = deriveAircraftTimes(times(90), aircraft({ class: 'ME' }), 'SE');
    expect(result.singlePilotMeMinutes).toBe(90);
    expect(result.singlePilotSeMinutes).toBe(0);
    expect(result.multiPilotMinutes).toBe(0);
  });

  it("the aircraft's own class wins over the fallback", () => {
    expect(deriveAircraftTimes(times(60), aircraft({ class: 'SE' }), 'ME').singlePilotSeMinutes).toBe(60);
    expect(deriveAircraftTimes(times(60), aircraft({ class: 'ME' }), 'SE').singlePilotMeMinutes).toBe(60);
  });

  it('never leaves SE and ME both non-zero, for any class or fallback', () => {
    for (const cls of ['SE', 'ME'] as const) {
      for (const fallback of ['SE', 'ME'] as const) {
        for (const multiPilot of [false, true]) {
          const r = deriveAircraftTimes(times(120), aircraft({ class: cls, multiPilot }), fallback);
          expect(r.singlePilotSeMinutes === 0 || r.singlePilotMeMinutes === 0).toBe(true);
        }
      }
    }
  });

  it('the derived value equals totalMinutes for a single-pilot flight', () => {
    for (const total of [6, 42, 90, 138, 600]) {
      const se = deriveAircraftTimes(times(total), aircraft({ class: 'SE' }), 'ME');
      expect(se.singlePilotSeMinutes).toBe(total);
      const me = deriveAircraftTimes(times(total), aircraft({ class: 'ME' }), 'SE');
      expect(me.singlePilotMeMinutes).toBe(total);
    }
  });
});

describe('deriveAircraftTimes — multi-pilot', () => {
  it('routes time to multiPilotMinutes and holds both single-pilot fields at 0', () => {
    const result = deriveAircraftTimes(times(240), aircraft({ class: 'ME', multiPilot: true }), 'SE');
    expect(result.multiPilotMinutes).toBe(240);
    expect(result.singlePilotSeMinutes).toBe(0);
    expect(result.singlePilotMeMinutes).toBe(0);
  });

  it('ignores the class entirely when multiPilot is true', () => {
    const asSe = deriveAircraftTimes(times(240), aircraft({ class: 'SE', multiPilot: true }), 'SE');
    const asMe = deriveAircraftTimes(times(240), aircraft({ class: 'ME', multiPilot: true }), 'ME');
    expect(asSe).toEqual(asMe);
  });
});

describe('deriveAircraftTimes — unknown aircraft falls back', () => {
  it('files under the fallback class and assumes single-pilot', () => {
    const se = deriveAircraftTimes(times(90), undefined, 'SE');
    expect(se.singlePilotSeMinutes).toBe(90);
    expect(se.multiPilotMinutes).toBe(0);

    const me = deriveAircraftTimes(times(90), undefined, 'ME');
    expect(me.singlePilotMeMinutes).toBe(90);
    expect(me.multiPilotMinutes).toBe(0);
  });

  it('produces a different column for each fallback — the setting really is read', () => {
    const se = deriveAircraftTimes(times(90), undefined, 'SE');
    const me = deriveAircraftTimes(times(90), undefined, 'ME');
    expect(se.singlePilotSeMinutes).toBe(90);
    expect(me.singlePilotSeMinutes).toBe(0);
    expect(se.singlePilotMeMinutes).toBe(0);
    expect(me.singlePilotMeMinutes).toBe(90);
  });

  it('resolves the class to something concrete before the record is written', () => {
    expect(resolveAircraftClass(undefined, 'ME')).toBe('ME');
    expect(resolveAircraftClass(undefined, 'SE')).toBe('SE');
    expect(resolveAircraftClass(aircraft({ class: 'ME' }), 'SE')).toBe('ME');
  });
});

describe('deriveAircraftTimes — manual overrides', () => {
  it('never overwrites a touched field', () => {
    const start = { ...times(90), singlePilotSeMinutes: 30 };
    const result = deriveAircraftTimes(start, aircraft({ class: 'SE' }), 'SE', ['singlePilotSeMinutes']);
    expect(result.singlePilotSeMinutes).toBe(30);
  });

  it('still derives the untouched fields around an override', () => {
    const start = { ...times(90), singlePilotSeMinutes: 30 };
    const result = deriveAircraftTimes(start, aircraft({ class: 'ME' }), 'SE', ['singlePilotSeMinutes']);
    expect(result.singlePilotSeMinutes).toBe(30);
    expect(result.singlePilotMeMinutes).toBe(90);
  });

  it('touching every derived field makes derivation a no-op', () => {
    const start = { ...times(90), singlePilotSeMinutes: 10, singlePilotMeMinutes: 20, multiPilotMinutes: 30 };
    const result = deriveAircraftTimes(start, aircraft({ class: 'SE' }), 'ME', DERIVED_TIME_FIELDS);
    expect(result).toEqual(start);
  });
});

describe('deriveAircraftTimes — purity and guards', () => {
  it('does not mutate its input', () => {
    const start = times(90);
    const snapshot = { ...start };
    deriveAircraftTimes(start, aircraft({ class: 'ME' }), 'SE');
    expect(start).toEqual(snapshot);
  });

  it('leaves the record alone when the total is not a usable duration', () => {
    const start = { ...times(Number.NaN), singlePilotSeMinutes: 45 };
    expect(deriveAircraftTimes(start, aircraft(), 'SE')).toEqual(start);
  });

  it('files a zero-minute flight as zero everywhere', () => {
    const result = deriveAircraftTimes(times(0), aircraft({ class: 'SE' }), 'ME');
    expect(result.singlePilotSeMinutes).toBe(0);
    expect(result.singlePilotMeMinutes).toBe(0);
  });
});

describe('normalizeRegistration', () => {
  it('resolves case and surrounding whitespace to one key', () => {
    expect(normalizeRegistration('ln-abc')).toBe('LN-ABC');
    expect(normalizeRegistration('LN-ABC  ')).toBe('LN-ABC');
    expect(normalizeRegistration('  ln-AbC ')).toBe('LN-ABC');
    expect(normalizeRegistration('LN-ABC')).toBe('LN-ABC');
  });

  it('is idempotent', () => {
    const once = normalizeRegistration(' ln-abc ');
    expect(normalizeRegistration(once)).toBe(once);
  });

  it('returns an empty string for blank input', () => {
    expect(normalizeRegistration('   ')).toBe('');
  });
});
