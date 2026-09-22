import { describe, it, expect } from 'vitest';
import { suggestNightForEntry, type NightEntryInput } from './suggest';
import type { Airport } from '../airports/types';

const AIRPORTS: Record<string, Airport> = {
  ENGM: { code: 'ENGM', lat: 60.1939, lon: 11.1004 },
  EGLL: { code: 'EGLL', lat: 51.4775, lon: -0.4614 },
};

const lookup = (code: string): Airport | undefined => AIRPORTS[code];

const BASE: NightEntryInput = {
  entryType: 'flight',
  date: '2026-12-21',
  offBlock: '15:00',
  onBlock: '17:00',
  depAerodrome: 'ENGM',
  arrAerodrome: 'EGLL',
  totalMinutes: 120,
};

describe('suggesting night time for an entry', () => {
  it('gives a number when everything it needs is there', () => {
    const suggestion = suggestNightForEntry(BASE, lookup);

    expect(suggestion.status).toBe('ready');
    // A midwinter evening sector out of Oslo: dark before it reaches London.
    expect(suggestion.nightMinutes).toBe(78);
    expect(suggestion.departureIsNight).toBe(false);
    expect(suggestion.arrivalIsNight).toBe(true);
  });

  it('passes on whether the landing column is a guess', () => {
    // The form asks the pilot to confirm the column on the strength of this
    // flag, so it has to survive the trip out of the domain.
    expect(suggestNightForEntry(BASE, lookup).arrivalUncertain).toBe(false);

    // Blocking in eight minutes after civil twilight ends at Heathrow, with an
    // unrecorded taxi in between.
    const closeCall = suggestNightForEntry(
      { ...BASE, date: '2027-09-21', offBlock: '16:55', onBlock: '18:45' },
      lookup,
    );
    expect(closeCall.status).toBe('ready');
    expect(closeCall.arrivalIsNight).toBe(true);
    expect(closeCall.arrivalUncertain).toBe(true);
  });

  it('rounds to the tenth of an hour and caps at the pilot’s total', () => {
    // The exact figure is a little under 79 minutes; the logbook records
    // tenths, so 78 (13 tenths). Reduce the total and the cap bites.
    expect(suggestNightForEntry(BASE, lookup).nightMinutes % 6).toBe(0);
    expect(suggestNightForEntry({ ...BASE, totalMinutes: 60 }, lookup).nightMinutes).toBe(60);
  });

  it('does not care how the aerodromes were typed', () => {
    const messy = suggestNightForEntry(
      { ...BASE, depAerodrome: ' engm ', arrAerodrome: 'egll' },
      lookup,
    );
    expect(messy.status).toBe('ready');
    expect(messy.nightMinutes).toBe(78);
  });

  it('says nothing at all while the form is half typed', () => {
    // Not a warning, not an error, nothing on the screen. This runs on every
    // keystroke.
    for (const partial of [
      { date: '' },
      { offBlock: '1' },
      { onBlock: '' },
      { depAerodrome: '' },
      { arrAerodrome: '' },
    ]) {
      const suggestion = suggestNightForEntry({ ...BASE, ...partial }, lookup);
      expect(suggestion.status, JSON.stringify(partial)).toBe('incomplete');
      expect(suggestion.nightMinutes).toBe(0);
    }
  });

  it('waits until a code is long enough to be a code before complaining', () => {
    // "EN is not in the airport list" while the pilot is still typing ENGM
    // would be noise on the way to a perfectly good entry.
    expect(suggestNightForEntry({ ...BASE, arrAerodrome: 'EG' }, lookup).status).toBe('incomplete');
    expect(suggestNightForEntry({ ...BASE, arrAerodrome: 'EGXX' }, lookup).status).toBe(
      'unknownAerodrome',
    );
  });

  it('names the aerodromes it could not find', () => {
    const one = suggestNightForEntry({ ...BASE, arrAerodrome: 'EKZZ' }, lookup);
    expect(one.status).toBe('unknownAerodrome');
    expect(one.missing).toEqual(['EKZZ']);

    const both = suggestNightForEntry(
      { ...BASE, depAerodrome: 'ENXX', arrAerodrome: 'EKZZ' },
      lookup,
    );
    expect(both.missing).toEqual(['ENXX', 'EKZZ']);
  });

  it('offers nothing for a simulator session', () => {
    // There is no sun in a simulator. The registry hides the field anyway;
    // this makes the answer explicit rather than incidental.
    const fstd = suggestNightForEntry(
      { ...BASE, entryType: 'fstd', depAerodrome: 'SIM', arrAerodrome: 'SIM' },
      lookup,
    );
    expect(fstd.status).toBe('notApplicable');
    expect(fstd.nightMinutes).toBe(0);
  });

  it('flags the answer as close to call when it is', () => {
    // Oslo at midsummer: the sun sits just under civil twilight around
    // midnight, and an hour either way is a few tenths of a degree.
    const midsummer = suggestNightForEntry(
      {
        ...BASE,
        date: '2026-06-21',
        offBlock: '22:00',
        onBlock: '02:00',
        arrAerodrome: 'ENGM',
        totalMinutes: 240,
      },
      lookup,
    );

    expect(midsummer.status).toBe('ready');
    expect(midsummer.grazing).toBe(true);
    expect(midsummer.nightMinutes).toBeGreaterThan(0);
  });

  it('suggests nothing for a daylight sector, and says so as a real answer', () => {
    const daylight = suggestNightForEntry(
      { ...BASE, date: '2026-06-21', offBlock: '10:00', onBlock: '12:00' },
      lookup,
    );

    // `ready` with zero, not `incomplete`: "no night" is an answer, and the
    // form needs to be able to tell the difference in order to clear a stale
    // value when the date changes.
    expect(daylight.status).toBe('ready');
    expect(daylight.nightMinutes).toBe(0);
  });

  it('keeps the exact figure alongside the logbook one', () => {
    const suggestion = suggestNightForEntry(BASE, lookup);
    expect(suggestion.exactMinutes).toBeGreaterThan(78);
    expect(suggestion.exactMinutes).toBeLessThan(79);
  });

  it('never throws, whatever the form holds', () => {
    const rubbish = {
      entryType: 'flight' as const,
      date: 'not a date',
      offBlock: 'noon',
      onBlock: '',
      depAerodrome: '!!',
      arrAerodrome: '',
      totalMinutes: Number.NaN,
    };
    expect(() => suggestNightForEntry(rubbish, lookup)).not.toThrow();
    expect(suggestNightForEntry(rubbish, lookup).status).toBe('incomplete');
  });
});
