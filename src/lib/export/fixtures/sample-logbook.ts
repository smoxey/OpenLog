/**
 * The permanent sample logbook.
 *
 * PERMANENT FIXTURE — committed to the repo and NEVER edited to make a test
 * pass. If a change to the exporters makes these records serialize differently,
 * that is a finding about the exporter, not a licence to edit the fixture.
 *
 * Every record here exists to break something:
 *
 *  - `remarks` carrying commas, semicolons, double quotes, embedded newlines,
 *    and non-ASCII characters — the four things CSV escaping gets wrong.
 *  - A registration with a LEADING ZERO ("N0123"), which Excel will happily
 *    turn into the number 123 on open.
 *  - `extra` holding flat scalars (string, number, boolean, null) that CSV can
 *    carry, alongside a nested object and an array that it cannot.
 *  - Out-of-order dates and ids, so the deterministic sort has something to do.
 *  - A duration of 138 minutes, which must read "2.3" / "2,3".
 *  - A zero-duration flight, so `0.0` formatting is covered.
 *  - An FSTD (simulator) session, so every export carries proof that simulator
 *    time is emitted without ever joining flight time.
 *
 * SCHEMA v3 NOTE. This fixture was updated when the record schema went to v3
 * (FSTD entries). That is the one legitimate reason to touch it: the fixture
 * encodes the schema, so a schema change necessarily changes it. What did NOT
 * change is any existing record's meaning — the four flights gained
 * `entryType: 'flight'` and zeroed simulator fields, which is exactly what
 * `migrateFlight` does to a stored v2 record. The permanent v1 fixture in
 * `domain/fixtures/v1-flight.ts` was not touched at all.
 */
import type { Flight } from '../../domain/flight';
import type { Aircraft } from '../../domain/aircraft';

function flight(overrides: Partial<Flight>): Flight {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    schemaVersion: 3,
    entryType: 'flight',
    date: '2026-07-18',
    depAerodrome: 'ENGM',
    arrAerodrome: 'ENBR',
    offBlock: '10:00',
    onBlock: '11:30',
    aircraftType: 'C172',
    registration: 'LN-ABC',
    picName: 'SELF',
    totalMinutes: 90,
    picMinutes: 90,
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

export const SAMPLE_FLIGHTS: Flight[] = [
  // Deliberately NOT first by date — the exporter must sort it into place.
  flight({
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    date: '2026-08-02',
    depAerodrome: 'ENBR',
    arrAerodrome: 'ENGM',
    offBlock: '23:40',
    onBlock: '00:20',
    totalMinutes: 40,
    picMinutes: 40,
    singlePilotSeMinutes: 40,
    nightMinutes: 40,
    landingsDay: 0,
    landingsNight: 1,
    remarks: 'Night xc; "solid" IMC, then VMC\non descent — Ålesund area',
    extra: {
      approaches: 2,
      instructor: null,
      customTag: 'x-country',
      // CSV cannot represent either of these. Both must be omitted + reported.
      crew: { pic: 'SELF', student: 'A. Nordmann' },
      waypoints: ['ENBR', 'KVERN', 'ENGM'],
    },
  }),
  flight({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    date: '2026-07-18',
    totalMinutes: 138,
    picMinutes: 138,
    singlePilotSeMinutes: 138,
    remarks: 'Touch, and go; "circuits" — Kjeller',
    extra: { approaches: 1, selfBriefed: true, customTag: 'training' },
  }),
  // Same date as the record above — the id tiebreak decides the order.
  flight({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    date: '2026-07-18',
    offBlock: '14:00',
    onBlock: '14:00',
    aircraftType: 'PA34',
    // Leading zero: Excel will mangle this on open. Documented, not fixable.
    registration: 'N0123',
    totalMinutes: 0,
    picMinutes: 0,
    singlePilotSeMinutes: 0,
    singlePilotMeMinutes: 0,
    multiPilotMinutes: 0,
    landingsDay: 0,
    remarks: 'Aborted before taxi',
    extra: {},
  }),
  flight({
    id: 'ddddddddd-dddd-4ddd-8ddd-ddddddddddd0',
    date: '2026-08-05',
    aircraftType: 'B738',
    registration: 'LN-XYZ',
    picName: 'K. Hansen',
    totalMinutes: 240,
    picMinutes: 0,
    coPilotMinutes: 240,
    singlePilotSeMinutes: 0,
    multiPilotMinutes: 240,
    ifrMinutes: 240,
    landingsDay: 1,
    remarks: 'ENGM–ENBR–ENGM, æøå ÄÖÜ ñ 日本語',
    extra: { approaches: 1, customTag: null },
  }),
  /**
   * An FSTD session. Its whole job is to prove the governing rule in the export:
   * 240 minutes of simulator time, `totalMinutes` of ZERO, aerodromes carrying
   * the "SIM" literal, a device id in `simulatorRegistration` and an empty
   * `registration`. Sum the flight time across this fixture and this record
   * contributes nothing — which is the property the whole entry-type design
   * exists to guarantee.
   */
  flight({
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    entryType: 'fstd',
    date: '2026-08-04',
    depAerodrome: 'SIM',
    arrAerodrome: 'SIM',
    offBlock: '',
    onBlock: '',
    aircraftType: 'A320-200-SIM',
    registration: '',
    picName: '',
    totalMinutes: 0,
    picMinutes: 0,
    singlePilotSeMinutes: 0,
    landingsDay: 0,
    simulatorMinutes: 240,
    simulatorRegistration: 'EU-DK187',
    ifrMinutes: 240,
    instructorMinutes: 0,
    dualMinutes: 240,
    remarks: 'LPC/OPC; engine failure after V1',
    extra: {},
  }),
];

export const SAMPLE_AIRCRAFT: Aircraft[] = [
  // Out of order on purpose; the exporter sorts by registration.
  { registration: 'LN-XYZ', type: 'B738', class: 'ME', multiPilot: true },
  { registration: 'LN-ABC', type: 'C172', class: 'SE', multiPilot: false },
  { registration: 'N0123', type: 'PA34', class: 'ME', multiPilot: false },
];

/** Fixed values so fixture output never depends on the clock or the build. */
export const SAMPLE_EXPORTED_AT = '2026-08-06T09:14:00.000Z';
export const SAMPLE_APP_VERSION = '0.1.0';
