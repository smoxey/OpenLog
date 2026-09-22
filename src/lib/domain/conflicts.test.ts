/**
 * Conflict detection — "a pilot cannot be in two places at once".
 *
 * These tests defend a DATA-INTEGRITY rule, not a duplicate rule: every pair
 * below is obviously two different entries, and the only thing wrong with them
 * is that they claim overlapping time.
 *
 * The function is pure, so everything here is plain objects — no storage, no
 * component, no clock.
 */
import { describe, it, expect } from 'vitest';
import { findConflicts, type ConflictComparable } from './conflicts';

/**
 * A logbook entry carrying just enough to be compared AND to be displayed —
 * the form shows the pilot what they clashed with, so `findConflicts` returns
 * records rather than booleans and the extra fields have to survive the round
 * trip.
 */
interface Entry extends ConflictComparable {
  id: string;
  depAerodrome: string;
  arrAerodrome: string;
  registration: string;
}

let seq = 0;

function entry(overrides: Partial<Entry> = {}): Entry {
  seq += 1;
  return {
    id: `e${seq}`,
    entryType: 'flight',
    date: '2026-08-01',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    registration: 'LN-ABC',
    offBlock: '10:00',
    onBlock: '11:00',
    ...overrides,
  };
}

const ids = (list: readonly Entry[]) => list.map((e) => e.id);

describe('findConflicts', () => {
  it('reports a strict intersection', () => {
    const stored = entry({ id: 'stored', offBlock: '10:00', onBlock: '12:00' });
    const candidate = entry({ id: 'candidate', offBlock: '11:00', onBlock: '13:00' });

    expect(ids(findConflicts(candidate, [stored]))).toEqual(['stored']);
  });

  it('does not report back-to-back legs that merely touch', () => {
    // 07:00-08:00 then 08:00-09:00 is an ordinary turnaround, not a conflict.
    const first = entry({ id: 'first', offBlock: '07:00', onBlock: '08:00' });
    const second = entry({ id: 'second', offBlock: '08:00', onBlock: '09:00' });

    expect(findConflicts(second, [first])).toEqual([]);
    expect(findConflicts(first, [second])).toEqual([]);
  });

  it('reports one flight fully containing another', () => {
    const long = entry({ id: 'long', offBlock: '08:00', onBlock: '18:00' });
    const short = entry({ id: 'short', offBlock: '12:00', onBlock: '13:00' });

    expect(ids(findConflicts(short, [long]))).toEqual(['long']);
    expect(ids(findConflicts(long, [short]))).toEqual(['short']);
  });

  it('reports identical start and end times', () => {
    const stored = entry({ id: 'stored', offBlock: '10:00', onBlock: '11:30' });
    const candidate = entry({ id: 'candidate', offBlock: '10:00', onBlock: '11:30' });

    expect(ids(findConflicts(candidate, [stored]))).toEqual(['stored']);
  });

  it('compares a flight crossing midnight against the following day', () => {
    // 23:40 -> 00:20 ends on 2 August, so it overlaps a 00:00-01:00 flight
    // dated the 2nd. Comparing times of day alone would miss this entirely.
    const overnight = entry({ id: 'overnight', date: '2026-08-01', offBlock: '23:40', onBlock: '00:20' });
    const nextDay = entry({ id: 'nextDay', date: '2026-08-02', offBlock: '00:00', onBlock: '01:00' });

    expect(ids(findConflicts(overnight, [nextDay]))).toEqual(['nextDay']);
    expect(ids(findConflicts(nextDay, [overnight]))).toEqual(['overnight']);
  });

  it('does not report a flight crossing midnight against an unrelated flight two days later', () => {
    const overnight = entry({ id: 'overnight', date: '2026-08-01', offBlock: '23:40', onBlock: '00:20' });
    const later = entry({ id: 'later', date: '2026-08-03', offBlock: '00:00', onBlock: '01:00' });

    expect(findConflicts(overnight, [later])).toEqual([]);
    expect(findConflicts(later, [overnight])).toEqual([]);
  });

  it('reports the same times in a different aircraft', () => {
    // The rule is about the PILOT, not the aircraft. Two aircraft at once is
    // exactly the case worth catching, so the registration is ignored.
    const stored = entry({ id: 'stored', registration: 'LN-ABC', offBlock: '10:00', onBlock: '11:00' });
    const candidate = entry({ id: 'candidate', registration: 'SE-XYZ', offBlock: '10:00', onBlock: '11:00' });

    expect(ids(findConflicts(candidate, [stored]))).toEqual(['stored']);
  });

  it('never reports an entry as conflicting with itself', () => {
    // Editing a saved flight re-checks it against a set that still contains its
    // own stored copy. Matched on id.
    const saved = entry({ id: 'saved', offBlock: '10:00', onBlock: '11:00' });

    expect(findConflicts(saved, [saved])).toEqual([]);
    // A stored copy that has since been edited is still the same entry.
    expect(findConflicts({ ...saved, onBlock: '11:30' }, [saved])).toEqual([]);
  });

  it('leaves FSTD entries out of it entirely, on both sides', () => {
    // Schema v3 forces a simulator session's block times empty, so there is
    // nothing to intersect. "You cannot be in a sim and an aircraft at once" is
    // true in principle; it is the absent data that stops us checking it.
    const flight = entry({ id: 'flight', offBlock: '10:00', onBlock: '12:00' });
    const sim = entry({
      id: 'sim',
      entryType: 'fstd',
      offBlock: '',
      onBlock: '',
      depAerodrome: 'SIM',
      arrAerodrome: 'SIM',
      registration: '',
    });

    // Never reported against a flight...
    expect(findConflicts(flight, [sim])).toEqual([]);
    // ...and never has one reported against it.
    expect(findConflicts(sim, [flight])).toEqual([]);

    // Not even if a malformed record somehow carried times.
    const simWithTimes = { ...sim, offBlock: '10:30', onBlock: '11:30' };
    expect(findConflicts(flight, [simWithTimes])).toEqual([]);
    expect(findConflicts(simWithTimes, [flight])).toEqual([]);
  });

  it('reports nothing for a zero-duration entry', () => {
    // 14:00-14:00: the aborted-before-taxi case in the sample logbook. It
    // occupies no time, so it cannot intersect anything.
    const aborted = entry({ id: 'aborted', offBlock: '14:00', onBlock: '14:00' });
    const surrounding = entry({ id: 'surrounding', offBlock: '13:00', onBlock: '15:00' });

    expect(findConflicts(aborted, [surrounding])).toEqual([]);
    expect(findConflicts(surrounding, [aborted])).toEqual([]);
  });

  it('returns no conflicts and does not throw on missing or malformed times', () => {
    // A half-typed form calls this on every keystroke.
    const stored = entry({ id: 'stored', offBlock: '10:00', onBlock: '12:00' });
    const broken: Partial<Entry>[] = [
      { offBlock: '', onBlock: '' },
      { offBlock: '10:', onBlock: '12:00' },
      { offBlock: '10:00', onBlock: '' },
      { offBlock: '25:00', onBlock: '26:00' },
      { offBlock: 'ten', onBlock: 'twelve' },
      { date: '', offBlock: '10:00', onBlock: '12:00' },
      { date: '2026-02-31', offBlock: '10:00', onBlock: '12:00' },
      { date: '01/08/2026', offBlock: '10:00', onBlock: '12:00' },
    ];

    for (const overrides of broken) {
      const candidate = entry({ id: 'candidate', ...overrides });
      expect(() => findConflicts(candidate, [stored])).not.toThrow();
      expect(findConflicts(candidate, [stored])).toEqual([]);
      // Malformed on the stored side is just as survivable.
      expect(findConflicts(stored, [candidate])).toEqual([]);
    }

    // Missing keys altogether, not merely empty ones.
    expect(findConflicts({} as unknown as ConflictComparable, [stored])).toEqual([]);
    expect(findConflicts(stored, [{ id: 'x' } as unknown as Entry])).toEqual([]);
  });

  it('returns no conflicts for an empty logbook or a logbook of one flight', () => {
    const candidate = entry({ id: 'candidate', offBlock: '10:00', onBlock: '12:00' });

    expect(findConflicts(candidate, [])).toEqual([]);
    // The one flight in the logbook IS this one, re-checked during an edit.
    expect(findConflicts(candidate, [candidate])).toEqual([]);
    // A single unrelated flight that does not overlap.
    expect(findConflicts(candidate, [entry({ id: 'other', offBlock: '13:00', onBlock: '14:00' })])).toEqual([]);
  });

  it('returns conflicts in a deterministic order — date, then id', () => {
    const candidate = entry({ id: 'candidate', date: '2026-08-02', offBlock: '00:30', onBlock: '02:00' });
    const clashes = [
      entry({ id: 'b', date: '2026-08-02', offBlock: '01:00', onBlock: '03:00' }),
      // Crosses midnight into the 2nd, so it is dated the 1st but overlaps.
      entry({ id: 'z', date: '2026-08-01', offBlock: '23:00', onBlock: '01:00' }),
      entry({ id: 'a', date: '2026-08-02', offBlock: '01:30', onBlock: '02:30' }),
    ];

    const expected = ['z', 'a', 'b'];
    expect(ids(findConflicts(candidate, clashes))).toEqual(expected);
    // Same inputs in any order produce the same display order.
    expect(ids(findConflicts(candidate, [...clashes].reverse()))).toEqual(expected);
    expect(ids(findConflicts(candidate, [clashes[2], clashes[0], clashes[1]]))).toEqual(expected);
  });

  it('has three overlapping entries all report each other', () => {
    const a = entry({ id: 'a', offBlock: '10:00', onBlock: '13:00' });
    const b = entry({ id: 'b', offBlock: '11:00', onBlock: '14:00' });
    const c = entry({ id: 'c', offBlock: '12:00', onBlock: '15:00' });
    const all = [a, b, c];

    expect(ids(findConflicts(a, all))).toEqual(['b', 'c']);
    expect(ids(findConflicts(b, all))).toEqual(['a', 'c']);
    expect(ids(findConflicts(c, all))).toEqual(['a', 'b']);
  });

  it('does not mutate either argument', () => {
    const candidate = entry({ id: 'candidate', offBlock: '10:00', onBlock: '12:00' });
    const existing = [
      entry({ id: 'z', offBlock: '11:00', onBlock: '13:00' }),
      entry({ id: 'a', offBlock: '09:00', onBlock: '10:30' }),
      entry({ id: 'far', offBlock: '20:00', onBlock: '21:00' }),
    ];
    const candidateBefore = structuredClone(candidate);
    const existingBefore = structuredClone(existing);

    const result = findConflicts(candidate, existing);

    // The result is sorted, which must not have reordered the input.
    expect(ids(result)).toEqual(['a', 'z']);
    expect(candidate).toEqual(candidateBefore);
    expect(existing).toEqual(existingBefore);
    expect(ids(existing)).toEqual(['z', 'a', 'far']);
  });

  // --- The two form behaviours the domain function is responsible for --------

  it('stops reporting a conflict once an edit removes the overlap', () => {
    // The form re-checks as the block times change, so "the warning clears" is
    // this function returning nothing for the edited values.
    const stored = entry({ id: 'stored', offBlock: '10:00', onBlock: '12:00' });
    const candidate = entry({ id: 'candidate', offBlock: '11:00', onBlock: '13:00' });

    expect(ids(findConflicts(candidate, [stored]))).toEqual(['stored']);
    expect(findConflicts({ ...candidate, offBlock: '12:00' }, [stored])).toEqual([]);
    expect(findConflicts({ ...candidate, date: '2026-08-05' }, [stored])).toEqual([]);
  });

  it('returns the conflicting record itself, so the caller can show what clashed', () => {
    const stored = entry({
      id: 'stored',
      date: '2026-08-01',
      depAerodrome: 'EKCH',
      arrAerodrome: 'EGLL',
      registration: 'OY-XYZ',
      offBlock: '10:00',
      onBlock: '12:00',
    });
    const candidate = entry({ id: 'candidate', offBlock: '11:00', onBlock: '13:00' });

    const [conflict] = findConflicts(candidate, [stored]);
    expect(conflict).toBe(stored);
    expect(conflict.date).toBe('2026-08-01');
    expect(conflict.depAerodrome).toBe('EKCH');
    expect(conflict.arrAerodrome).toBe('EGLL');
    expect(conflict.registration).toBe('OY-XYZ');
    expect(conflict.offBlock).toBe('10:00');
    expect(conflict.onBlock).toBe('12:00');
  });
});
