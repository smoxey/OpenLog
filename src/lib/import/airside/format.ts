/**
 * The Airside export, column by column — the parts that are pure string work.
 *
 * Airside is a crew-app export an airline pilot can download for themselves. It
 * is small (nine columns) and tidy, but three of its columns say something this
 * app's schema does not accept as written, and one of them says four things at
 * once:
 *
 *     Flight              XY0123-20240115-OSL-BGO
 *     Tail Number         SEXYZ
 *     Model               32N
 *
 * A flight number, a date and a route packed into one cell; a registration with
 * its hyphen removed; a marketing type code. None of these can be expressed as
 * an `ImportMapping`, which is one target per column — so they are unpacked
 * here, BEFORE the ordinary import pipeline sees the file. See `./adapt`.
 *
 * PURE: no storage, no settings, no clock, no DOM. Nothing here throws; a value
 * this cannot read comes back as `null` and the caller reports the row.
 */
import { isoDateToDayNumber } from '../../time/blockTime';

/** The nine columns of an Airside export, in order. */
export const AIRSIDE_HEADERS = [
  'Flight',
  'Departure Date',
  'Block off',
  'Arrival Date',
  'Block on',
  'Tail Number',
  'Model',
  'Total Flight Time',
  'Landing',
] as const;

/**
 * Does this file look like an Airside export?
 *
 * Every column must be present, in the manner of `detectPreset`: claiming a
 * file wrongly is worse than not claiming it, because everything downstream
 * then transforms values that meant something else.
 */
export function looksLikeAirside(headers: readonly string[]): boolean {
  const present = new Set(headers.map((header) => header.trim()));
  return AIRSIDE_HEADERS.every((header) => present.has(header));
}

/** What the `Flight` column holds, once unpacked. */
export interface AirsideFlightId {
  /** `XY0123` — the commercial flight number. */
  number: string;
  /**
   * The date inside the identifier, as `YYYY-MM-DD`.
   *
   * NOT the date the flight is imported under. This is the SCHEDULED day, and
   * it disagrees with the `Departure Date` column when a departure slips past
   * midnight — one row of the reference file does exactly that. The
   * `Departure Date` column is what actually happened, so that is what is used
   * and this is kept only so the two can be compared.
   */
  date: string;
  /** IATA code, as written. */
  departure: string;
  /** IATA code, as written. */
  arrival: string;
}

const FLIGHT_ID = /^([A-Z0-9]+)-(\d{8})-([A-Z0-9]{3})-([A-Z0-9]{3})$/;

/**
 * `XY0123-20240115-OSL-BGO` -> its four parts, or `null`.
 *
 * Strict on purpose. A cell that does not match this shape is not a flight
 * identifier with a typo in it, it is something else — and inventing a route
 * out of it would put two wrong aerodromes into the logbook.
 */
export function parseAirsideFlight(value: unknown): AirsideFlightId | null {
  const text = String(value ?? '')
    .trim()
    .toUpperCase();
  const match = FLIGHT_ID.exec(text);
  if (!match) return null;

  const [, number, digits, departure, arrival] = match;
  const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  // A date the calendar does not have — 20250230 — means this part of the
  // identifier is not what it appears to be. The route is still readable, so
  // the date is blanked rather than the whole cell rejected: no record is built
  // from it, and the row still carries a real departure date of its own.
  //
  // `isoDateToDayNumber` rather than `Date.parse`, which rolls 30 February over
  // into 1 March without complaint. The project already has one place that
  // knows an impossible date when it sees one, and this is it.
  const valid = Number.isFinite(isoDateToDayNumber(date));

  return { number, date: valid ? date : '', departure, arrival };
}

// --- Registrations ---------------------------------------------------------

/**
 * Nationality prefixes that take a hyphen after them.
 *
 * Airside writes `SEXYZ` where the aircraft is `SE-XYZ`. Putting the hyphen
 * back means knowing where it goes, and where it goes is the end of the
 * registering country's prefix — one or two characters, depending on the
 * country.
 *
 * THIS LIST IS DELIBERATELY NOT EXHAUSTIVE, and that is the point. There are
 * about two hundred registries, and several of the largest (the United States,
 * Japan, South Korea) use no hyphen at all — so a rule that guessed would
 * sooner or later insert a hyphen into a registration that never had one,
 * silently, in a field the pilot has no reason to re-read. What is here is the
 * set this app is confident about. Anything else is LEFT EXACTLY AS WRITTEN and
 * listed in the import step, where a pilot can switch their own prefix on.
 *
 * Two characters are tried before one, so Sweden's `SE` wins over the single
 * letters and Ireland's `EI` is never read as Spain's `EC`.
 */
export const HYPHEN_PREFIXES_2: readonly string[] = [
  '5B',
  '9A',
  '9H',
  'CS',
  'EC',
  'EI',
  'ES',
  'HA',
  'HB',
  'LN',
  'LX',
  'LY',
  'LZ',
  'OE',
  'OH',
  'OK',
  'OM',
  'OO',
  'OY',
  'PH',
  'S5',
  'SE',
  'SP',
  'SX',
  'TC',
  'TF',
  'UR',
  'YL',
  'YR',
  'Z3',
  'ZA',
];

/** Single-letter registries that hyphenate: `G-ABCD`, `D-AIBC`, `C-FABC`. */
export const HYPHEN_PREFIXES_1: readonly string[] = ['B', 'C', 'D', 'F', 'G', 'I', 'M'];

/** Everything the app will offer to hyphenate. */
export const KNOWN_HYPHEN_PREFIXES: readonly string[] = [
  ...HYPHEN_PREFIXES_2,
  ...HYPHEN_PREFIXES_1,
];

/**
 * The prefix an unhyphenated registration appears to carry, or `''`.
 *
 * A two-character prefix beats a one-character one, and only prefixes from the
 * lists above are recognised. The remainder must be at least two characters, so
 * `SEA` is not read as a Swedish aircraft called `A`.
 */
export function registrationPrefix(value: unknown): string {
  const text = String(value ?? '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9]{3,8}$/.test(text)) return '';
  for (const prefix of HYPHEN_PREFIXES_2) {
    if (text.startsWith(prefix) && text.length - prefix.length >= 2) return prefix;
  }
  for (const prefix of HYPHEN_PREFIXES_1) {
    if (text.startsWith(prefix) && text.length - prefix.length >= 2) return prefix;
  }
  return '';
}

/**
 * `SEXYZ` -> `SE-XYZ`, when the pilot has said that prefix takes a hyphen.
 *
 * A value that already contains a hyphen comes back untouched: the file has
 * already answered the question, and re-splitting it could only make it worse.
 * So does one whose prefix is not in `enabled` — which is how "left exactly as
 * written" is enforced rather than merely intended.
 */
export function hyphenateRegistration(value: unknown, enabled: ReadonlySet<string>): string {
  const text = String(value ?? '')
    .trim()
    .toUpperCase();
  if (text === '' || text.includes('-')) return text;
  const prefix = registrationPrefix(text);
  if (!prefix || !enabled.has(prefix)) return text;
  return `${prefix}-${text.slice(prefix.length)}`;
}

// --- Aircraft types --------------------------------------------------------

/**
 * Marketing type codes an airline export writes, and the ICAO designator each
 * one means.
 *
 * A SUGGESTION, not a rule. Every distinct value in the file is shown in the
 * import step with its proposed designator in an editable field, defaulting to
 * the value itself where this table has nothing to say — so an unrecognised
 * code is carried through unchanged rather than lost, and a recognised one can
 * still be overruled.
 *
 * `32N` is the IATA code for the A320neo, whose ICAO designator is `A20N`. It
 * is suggested as `A320` because that is what the pilot this format was
 * characterised against asked for, and because the field is editable by anyone
 * who wants the neo kept apart in their totals.
 */
export const AIRSIDE_MODEL_SUGGESTIONS: Readonly<Record<string, string>> = {
  '318': 'A318',
  '319': 'A319',
  '320': 'A320',
  '321': 'A321',
  '32A': 'A320',
  '32B': 'A321',
  '32N': 'A320',
  '32Q': 'A321',
  '32S': 'A320',
  '33N': 'A339',
  '359': 'A359',
  '73H': 'B738',
  '73J': 'B739',
  '737': 'B737',
  '738': 'B738',
  '739': 'B739',
  '7M8': 'B38M',
  '223': 'BCS1',
  '295': 'BCS3',
  AT7: 'AT76',
  DH4: 'DH8D',
  E90: 'E190',
  E95: 'E195',
  CR9: 'CRJ9',
};

/** What this app would call a model code, before the pilot edits it. */
export function suggestAircraftType(model: unknown): string {
  const code = String(model ?? '')
    .trim()
    .toUpperCase();
  if (!code) return '';
  return AIRSIDE_MODEL_SUGGESTIONS[code] ?? code;
}

// --- Landings --------------------------------------------------------------

/**
 * Airside's `Landing` column: did this pilot land the aeroplane?
 *
 * `TRUE` on the sector they flew, `FALSE` on the sector they monitored — the
 * same fact the entry form collects with its Pilot Flying / Pilot Monitoring
 * toggle. It says nothing about DAY or NIGHT; which column the landing belongs
 * in is worked out from the arrival, in `./adapt`.
 *
 * Anything unrecognised reads as `false`. A landing this app invented would be
 * a claim about currency that the pilot never made.
 */
export function parseAirsideLanding(value: unknown): boolean {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  return text === 'true' || text === 'yes' || text === '1' || text === 'y';
}
