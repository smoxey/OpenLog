/**
 * The aircraft step.
 *
 * The thing being defended here is the QUESTION COUNT. The real RB export has
 * 78 registrations and three type designators; asking per registration means 78
 * questions, and a pilot asked the same thing about forty A320s in a row will
 * stop reading and start clicking. Grouping by type turns it into eleven
 * answers — three types plus the eight registrations the file gives no type
 * for — with exactly the same result.
 */
import { describe, it, expect } from 'vitest';
import {
  groupAircraftByType,
  resolveAircraft,
  seedAnswers,
  suggestTypeProfile,
  unansweredCount,
  type AircraftAnswers,
} from './aircraftAnswers';
import type { AircraftNeed } from './transform';
import type { Aircraft } from '../domain/aircraft';

function need(registration: string, types: string[], rowCount = 1): AircraftNeed {
  return { registration, asWritten: registration, typesSeen: types, rowCount };
}

/** A miniature of the real file's shape: many registrations, few types. */
const NEEDS: AircraftNeed[] = [
  need('OY-XXA', ['A320'], 400),
  need('OY-XXB', ['A320'], 292),
  need('OY-XXC', ['A319'], 64),
  need('LN-XXD', ['C172'], 98),
  need('LN-XXE', [], 12),
  need('LN-XXF', [], 11),
];

describe('groupAircraftByType', () => {
  const groups = groupAircraftByType(NEEDS);

  it('collapses many registrations into few questions', () => {
    // Six registrations, four groups.
    expect(groups).toHaveLength(4);
    expect(groups.map((g) => g.type)).toEqual(['A319', 'A320', 'C172', '']);
  });

  it('lists the registrations each type covers', () => {
    const a320 = groups.find((g) => g.type === 'A320');
    expect(a320?.registrations).toEqual(['OY-XXA', 'OY-XXB']);
  });

  it('totals the rows a type accounts for, so the pilot sees what is at stake', () => {
    expect(groups.find((g) => g.type === 'A320')?.rowCount).toBe(692);
  });

  it('sorts the untyped group LAST, because it is the one needing work', () => {
    // Buried between two finished rows it would be missed.
    expect(groups[groups.length - 1].type).toBe('');
    expect(groups[groups.length - 1].registrations).toEqual(['LN-XXE', 'LN-XXF']);
  });

  it('handles a file where every aircraft has a type', () => {
    const groups = groupAircraftByType([need('OY-XXA', ['A320'])]);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('A320');
  });

  it('handles an empty file', () => {
    expect(groupAircraftByType([])).toEqual([]);
  });
});

describe('suggestTypeProfile', () => {
  it('suggests multi-pilot for transport-category designators', () => {
    for (const type of ['A320', 'A319', 'B738', 'E195', 'CRJ9', 'AT76']) {
      expect(suggestTypeProfile(type, 'SE')).toEqual({ class: 'ME', multiPilot: true });
    }
  });

  it('suggests single-engine single-pilot for light aircraft', () => {
    for (const type of ['C172', 'PA28', 'DA40', 'SR22']) {
      expect(suggestTypeProfile(type, 'ME')).toEqual({ class: 'SE', multiPilot: false });
    }
  });

  it('falls back to the pilot’s own default class for anything else', () => {
    // The same value the entry form uses for an unknown registration, so the
    // import and the form guess alike.
    expect(suggestTypeProfile('ZZZZ', 'ME')).toEqual({ class: 'ME', multiPilot: false });
    expect(suggestTypeProfile('ZZZZ', 'SE')).toEqual({ class: 'SE', multiPilot: false });
  });

  it('is case- and whitespace-insensitive', () => {
    expect(suggestTypeProfile(' a320 ', 'SE').multiPilot).toBe(true);
  });
});

describe('seedAnswers', () => {
  const groups = groupAircraftByType(NEEDS);

  it('suggests a profile for every type', () => {
    const answers = seedAnswers(groups, [], 'ME');
    expect(answers.byType['A320']).toEqual({ class: 'ME', multiPilot: true });
    expect(answers.byType['C172']).toEqual({ class: 'SE', multiPilot: false });
  });

  it('does NOT invent an entry for the untyped group', () => {
    const answers = seedAnswers(groups, [], 'ME');
    expect(answers.byType['']).toBeUndefined();
  });

  it('prefers what the pilot has already confirmed over a suggestion', () => {
    // Re-asking about an aircraft they have already told us about is rude, and
    // worse, invites a different answer the second time.
    const known: Aircraft[] = [
      { registration: 'OY-XXA', type: 'A320', class: 'ME', multiPilot: false },
    ];
    const answers = seedAnswers(groups, known, 'ME');
    expect(answers.byType['A320']).toEqual({ class: 'ME', multiPilot: false });
  });

  it('ignores a stored aircraft whose type disagrees with the file', () => {
    // The store says this registration is a C172; the file says A320. The
    // file's claim about THIS import wins, and the pilot sees the suggestion.
    const known: Aircraft[] = [
      { registration: 'OY-XXA', type: 'C172', class: 'SE', multiPilot: false },
    ];
    const answers = seedAnswers(groups, known, 'ME');
    expect(answers.byType['A320']).toEqual({ class: 'ME', multiPilot: true });
  });

  it('leaves untyped registrations blank, waiting for the pilot', () => {
    const answers = seedAnswers(groups, [], 'ME');
    expect(answers.typeByRegistration['LN-XXE']).toBe('');
    expect(answers.typeByRegistration['LN-XXF']).toBe('');
  });

  it('prefills an untyped registration the pilot has met before, so a second import asks nothing', () => {
    const known: Aircraft[] = [
      { registration: 'LN-XXE', type: 'PA28', class: 'SE', multiPilot: false },
    ];
    const answers = seedAnswers(groups, known, 'ME');
    expect(answers.typeByRegistration['LN-XXE']).toBe('PA28');
  });
});

describe('resolveAircraft', () => {
  const groups = groupAircraftByType(NEEDS);

  it('produces one record per registration, from a handful of answers', () => {
    const answers = seedAnswers(groups, [], 'ME');
    answers.typeByRegistration['LN-XXE'] = 'PA28';
    answers.typeByRegistration['LN-XXF'] = 'PA28';

    const resolved = resolveAircraft(NEEDS, answers, 'ME');
    expect(resolved).toHaveLength(6);
    expect(resolved.map((a) => a.registration)).toEqual([
      'OY-XXA',
      'OY-XXB',
      'OY-XXC',
      'LN-XXD',
      'LN-XXE',
      'LN-XXF',
    ]);
  });

  it('applies one type answer to every registration of that type', () => {
    const answers = seedAnswers(groups, [], 'ME');
    answers.byType['A320'] = { class: 'ME', multiPilot: true };

    const resolved = resolveAircraft(NEEDS, answers, 'ME');
    const a320s = resolved.filter((a) => a.type === 'A320');
    expect(a320s).toHaveLength(2);
    for (const aircraft of a320s) expect(aircraft.multiPilot).toBe(true);
  });

  it('LEAVES OUT a registration whose type is still blank', () => {
    // An aircraft with no type is not an answer. Writing one would put a
    // permanently useless record in the store; its rows are held back instead,
    // which is what the preview reports.
    const answers = seedAnswers(groups, [], 'ME');
    const resolved = resolveAircraft(NEEDS, answers, 'ME');
    expect(resolved.map((a) => a.registration)).not.toContain('LN-XXE');
    expect(resolved).toHaveLength(4);
  });

  it('uses the type the pilot typed for a registration the file left blank', () => {
    const answers = seedAnswers(groups, [], 'ME');
    answers.typeByRegistration['LN-XXE'] = 'pa28';

    const resolved = resolveAircraft(NEEDS, answers, 'ME');
    const supplied = resolved.find((a) => a.registration === 'LN-XXE');
    expect(supplied?.type).toBe('pa28');
    expect(supplied?.class).toBe('SE');
  });

  it('normalizes every record exactly as the entry form would', () => {
    const answers: AircraftAnswers = {
      byType: { A320: { class: 'ME', multiPilot: true } },
      typeByRegistration: {},
    };
    const resolved = resolveAircraft([need(' oy-xxa ', ['A320'])], answers, 'ME');
    expect(resolved[0].registration).toBe('OY-XXA');
  });
});

describe('unansweredCount', () => {
  const groups = groupAircraftByType(NEEDS);

  it('counts the registrations still waiting for a type', () => {
    const answers = seedAnswers(groups, [], 'ME');
    expect(unansweredCount(groups, answers)).toBe(2);

    answers.typeByRegistration['LN-XXE'] = 'PA28';
    expect(unansweredCount(groups, answers)).toBe(1);

    answers.typeByRegistration['LN-XXF'] = 'PA28';
    expect(unansweredCount(groups, answers)).toBe(0);
  });

  it('treats whitespace as no answer', () => {
    const answers = seedAnswers(groups, [], 'ME');
    answers.typeByRegistration['LN-XXE'] = '   ';
    expect(unansweredCount(groups, answers)).toBe(2);
  });

  it('is zero when every aircraft in the file has a type', () => {
    const typed = groupAircraftByType([need('OY-XXA', ['A320'])]);
    expect(unansweredCount(typed, seedAnswers(typed, [], 'ME'))).toBe(0);
  });
});
