import { describe, expect, it } from 'vitest';
import { checkTimeSums } from './timeSums';
import { SAMPLE_FLIGHTS } from '../export/fixtures/sample-logbook';
import type { Flight } from './flight';

/** A complete, valid flight. Overrides are what each test is actually about. */
function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    schemaVersion: 3,
    entryType: 'flight',
    date: '2026-07-18',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '10:00',
    onBlock: '11:30',
    aircraftType: 'C172',
    registration: 'LN-ABC',
    picName: '',
    totalMinutes: 90,
    picMinutes: 0,
    coPilotMinutes: 0,
    dualMinutes: 0,
    instructorMinutes: 0,
    singlePilotSeMinutes: 90,
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

describe('pilot function time', () => {
  it('is silent when the function times sum to exactly the total', () => {
    const findings = checkTimeSums(flight({ totalMinutes: 90, picMinutes: 60, dualMinutes: 30 }));
    expect(findings).toEqual([]);
  });

  it('is silent when the function times sum to less than the total', () => {
    // The overwhelmingly common shape: PIC logged, everything else left at zero.
    const findings = checkTimeSums(flight({ totalMinutes: 90, picMinutes: 45 }));
    expect(findings).toEqual([]);
  });

  it('warns when the function times sum above the total, and says by how much', () => {
    const findings = checkTimeSums(
      flight({ totalMinutes: 90, picMinutes: 90, coPilotMinutes: 15 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'pilotFunction',
      sum: 105,
      yardstick: 90,
      yardstickKey: 'totalMinutes',
      excessMinutes: 15,
    });
  });

  it('names every contributing column, from the registry', () => {
    const [finding] = checkTimeSums(flight({ totalMinutes: 60, picMinutes: 90 }));
    expect(finding.keys).toEqual([
      'picMinutes',
      'coPilotMinutes',
      'dualMinutes',
      'instructorMinutes',
    ]);
  });

  it('WARNS on a flight logged as both PIC and instructor for its full duration', () => {
    /*
      The documented false positive, asserted on purpose so that nobody later
      "fixes" it into silence. This entry is correct — an instructor flying as
      PIC really does occupy both columns for the whole flight — and the warning
      firing on it is the price of catching a mistyped 100 for 10. It never
      blocks, so the cost is one line of amber text the pilot can ignore.
    */
    const findings = checkTimeSums(
      flight({ totalMinutes: 90, picMinutes: 90, instructorMinutes: 90 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].excessMinutes).toBe(90);
  });

  it('warns when the total is zero but function time is not', () => {
    const findings = checkTimeSums(flight({ totalMinutes: 0, picMinutes: 45 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'pilotFunction', yardstick: 0, excessMinutes: 45 });
  });
});

describe('operational condition time', () => {
  it('warns when night alone exceeds the total', () => {
    const findings = checkTimeSums(flight({ totalMinutes: 90, nightMinutes: 120 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'operationalCondition',
      keys: ['nightMinutes'],
      excessMinutes: 30,
    });
  });

  it('is silent when night AND IFR each equal the total', () => {
    /*
      Night and IFR are not additive with each other. A night IFR flight is in
      darkness and on instruments for the same minutes, so both columns hold the
      full duration. Summing them would fire on every such flight ever logged.
    */
    const findings = checkTimeSums(
      flight({ totalMinutes: 90, nightMinutes: 90, ifrMinutes: 90 }),
    );
    expect(findings).toEqual([]);
  });

  it('reports night and IFR separately when both exceed the total', () => {
    const findings = checkTimeSums(
      flight({ totalMinutes: 60, nightMinutes: 90, ifrMinutes: 75 }),
    );
    expect(findings.map((f) => f.keys[0])).toEqual(['nightMinutes', 'ifrMinutes']);
  });

  it('reports a function overrun and a condition overrun as two findings', () => {
    const findings = checkTimeSums(
      flight({ totalMinutes: 60, picMinutes: 90, ifrMinutes: 90 }),
    );
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.kind)).toEqual(['pilotFunction', 'operationalCondition']);
  });
});

describe('simulator sessions', () => {
  function session(overrides: Partial<Flight> = {}): Flight {
    return flight({
      entryType: 'fstd',
      depAerodrome: 'SIM',
      arrAerodrome: 'SIM',
      offBlock: '',
      onBlock: '',
      registration: '',
      totalMinutes: 0,
      singlePilotSeMinutes: 0,
      landingsDay: 0,
      simulatorMinutes: 120,
      simulatorRegistration: 'EU-DK187',
      ...overrides,
    });
  }

  it('measures against session time, not total time', () => {
    // totalMinutes is 0 on every FSTD entry. Measuring against it would warn on
    // every simulator session that logged a single minute of anything.
    const findings = checkTimeSums(session({ simulatorMinutes: 120, dualMinutes: 90 }));
    expect(findings).toEqual([]);
  });

  it('is silent when dual and instructor time fit inside the session', () => {
    const findings = checkTimeSums(
      session({ simulatorMinutes: 120, dualMinutes: 60, instructorMinutes: 60 }),
    );
    expect(findings).toEqual([]);
  });

  it('warns, against session time, when they do not fit', () => {
    const findings = checkTimeSums(
      session({ simulatorMinutes: 120, dualMinutes: 90, instructorMinutes: 90 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      yardstickKey: 'simulatorMinutes',
      yardstick: 120,
      sum: 180,
      excessMinutes: 60,
    });
  });

  it('does not consider columns that do not apply to a simulator session', () => {
    // `picMinutes` and `coPilotMinutes` are flight-only in the registry, so a
    // stale value left on the record must not be summed into the check.
    const findings = checkTimeSums(
      session({ simulatorMinutes: 60, picMinutes: 600, coPilotMinutes: 600 }),
    );
    expect(findings).toEqual([]);
  });
});

describe('a half-typed form', () => {
  // This runs on every keystroke, so partial input is the normal case.

  it('returns nothing rather than throwing on an empty object', () => {
    expect(() => checkTimeSums({})).not.toThrow();
    expect(checkTimeSums({})).toEqual([]);
  });

  it('is silent when the total is still being typed', () => {
    expect(checkTimeSums({ entryType: 'flight', totalMinutes: '', picMinutes: 60 })).toEqual([]);
  });

  it('is silent when the total failed to parse', () => {
    expect(checkTimeSums({ entryType: 'flight', totalMinutes: NaN, picMinutes: 60 })).toEqual([]);
  });

  it('declines the function check when one of its columns failed to parse', () => {
    const findings = checkTimeSums({
      entryType: 'flight',
      totalMinutes: 60,
      picMinutes: 90,
      dualMinutes: NaN,
    });
    expect(findings.map((f) => f.kind)).not.toContain('pilotFunction');
  });

  it('still checks the condition columns when a function column is unparseable', () => {
    const findings = checkTimeSums({
      entryType: 'flight',
      totalMinutes: 60,
      dualMinutes: NaN,
      ifrMinutes: 90,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].keys).toEqual(['ifrMinutes']);
  });

  it('treats a missing column as zero rather than as an error', () => {
    expect(checkTimeSums({ entryType: 'flight', totalMinutes: 60, picMinutes: 60 })).toEqual([]);
  });

  it('is silent on a negative total rather than reporting nonsense', () => {
    expect(checkTimeSums({ entryType: 'flight', totalMinutes: -60, picMinutes: 10 })).toEqual([]);
  });

  it('assumes a flight when the entry type is missing or unrecognised', () => {
    const findings = checkTimeSums({ totalMinutes: 60, picMinutes: 90 });
    expect(findings[0]?.yardstickKey).toBe('totalMinutes');
  });
});

describe('the permanent sample logbook', () => {
  it('produces no findings', () => {
    /*
      If this ever fails, the rule is wrong, not the fixture. The sample logbook
      is the regression net for the exporters and is never edited to make a test
      pass — see the note at the top of `sample-logbook.ts`.
    */
    for (const record of SAMPLE_FLIGHTS) {
      expect(checkTimeSums(record), `${record.id} (${record.date})`).toEqual([]);
    }
  });
});
