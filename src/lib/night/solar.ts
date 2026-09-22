/**
 * Where the sun is.
 *
 * One question underlies the whole night calculation: how far above or below
 * the horizon is the centre of the sun, at this instant, at this point on the
 * earth? EASA night is the period between the end of evening civil twilight and
 * the beginning of morning civil twilight, and civil twilight ends when that
 * number reaches −6°. So night is `sunAltitudeDegrees(...) < -6`, and everything
 * else in `night/` is bookkeeping around that one comparison.
 *
 * The algorithm is NOAA's — the Astronomical Almanac's low-precision solar
 * position — which is accurate to about 0.01° for the years 1950 to 2050. At
 * the rate the sun moves (a quarter of a degree per minute at most) that is a
 * couple of seconds of twilight timing, which is far inside the tenth of an
 * hour a logbook records.
 *
 * Deliberately plain arithmetic: no dependencies, no `Intl`, and no timezone
 * anywhere. Every `Date` passed in is read in UTC, because the logbook stores
 * block times in UTC and the sun does not care what the pilot's phone thinks
 * the local time is.
 */

/** Latitude and longitude in decimal degrees; north and east positive. */
export interface Coordinates {
  lat: number;
  lon: number;
}

const MS_PER_DAY = 86_400_000;
/** Julian day of 2000-01-01 12:00 UTC — the J2000.0 epoch NOAA reckons from. */
const J2000 = 2_451_545.0;
const DAYS_PER_CENTURY = 36_525;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const sinDeg = (d: number) => Math.sin(d * DEG);
const cosDeg = (d: number) => Math.cos(d * DEG);
const tanDeg = (d: number) => Math.tan(d * DEG);

/** Julian day number, including the fraction, for an instant. */
export function julianDay(when: Date): number {
  return when.getTime() / MS_PER_DAY + 2_440_587.5;
}

/**
 * Julian centuries since J2000.0. Every polynomial below is a series in this,
 * which is why it is computed once and threaded through rather than each
 * function taking a `Date`.
 */
export function julianCentury(when: Date): number {
  return (julianDay(when) - J2000) / DAYS_PER_CENTURY;
}

/** Geometric mean longitude of the sun, degrees, wrapped to [0, 360). */
function geomMeanLongitudeDeg(t: number): number {
  const l = 280.46646 + t * (36_000.76983 + t * 0.0003032);
  return ((l % 360) + 360) % 360;
}

/** Geometric mean anomaly of the sun, degrees (not wrapped; only its sine and
 *  cosine are ever used). */
function geomMeanAnomalyDeg(t: number): number {
  return 357.52911 + t * (35_999.05029 - 0.0001537 * t);
}

/** Eccentricity of the earth's orbit — dimensionless, and slowly shrinking. */
function orbitEccentricity(t: number): number {
  return 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
}

/** Equation of centre: the correction from the mean anomaly to the true one. */
function equationOfCentreDeg(t: number): number {
  const m = geomMeanAnomalyDeg(t);
  return (
    sinDeg(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    sinDeg(2 * m) * (0.019993 - 0.000101 * t) +
    sinDeg(3 * m) * 0.000289
  );
}

/**
 * Apparent longitude of the sun, degrees: the true longitude corrected for
 * aberration and for the moon's nutation of the earth's axis.
 */
function apparentLongitudeDeg(t: number): number {
  const trueLong = geomMeanLongitudeDeg(t) + equationOfCentreDeg(t);
  return trueLong - 0.00569 - 0.00478 * sinDeg(125.04 - 1934.136 * t);
}

/** Obliquity of the ecliptic, degrees — the tilt, corrected for nutation. */
function obliquityDeg(t: number): number {
  const mean = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  return mean + 0.00256 * cosDeg(125.04 - 1934.136 * t);
}

/**
 * Declination of the sun, degrees: the latitude at which it is directly
 * overhead. Runs between ±23.44° over a year and is what makes a high-latitude
 * winter dark and a high-latitude summer not.
 */
export function solarDeclinationDegrees(when: Date): number {
  const t = julianCentury(when);
  return Math.asin(sinDeg(obliquityDeg(t)) * sinDeg(apparentLongitudeDeg(t))) * RAD;
}

/**
 * The equation of time, in minutes: apparent solar time minus mean solar time.
 *
 * The earth's orbit is an ellipse and its axis is tilted, so the sun keeps poor
 * time: it reaches the meridian about 14 minutes LATE in mid-February (a
 * negative value here) and about 16 minutes EARLY in early November. Ignoring
 * it would put every twilight up to a quarter of an hour out.
 */
export function equationOfTimeMinutes(when: Date): number {
  const t = julianCentury(when);
  const epsilon = obliquityDeg(t);
  const l0 = geomMeanLongitudeDeg(t);
  const e = orbitEccentricity(t);
  const m = geomMeanAnomalyDeg(t);

  const y = tanDeg(epsilon / 2) ** 2;

  const radians =
    y * sinDeg(2 * l0) -
    2 * e * sinDeg(m) +
    4 * e * y * sinDeg(m) * cosDeg(2 * l0) -
    0.5 * y * y * sinDeg(4 * l0) -
    1.25 * e * e * sinDeg(2 * m);

  // Radians of earth rotation → minutes of time: 4 minutes per degree.
  return radians * RAD * 4;
}

/** Minutes since midnight UTC, including the fractional part. */
function utcMinutesOfDay(when: Date): number {
  return (
    when.getUTCHours() * 60 +
    when.getUTCMinutes() +
    when.getUTCSeconds() / 60 +
    when.getUTCMilliseconds() / 60_000
  );
}

/**
 * The sun's altitude above the horizon, in degrees, at an instant and a place.
 *
 * Positive above the horizon, negative below; the geometric centre of the disc,
 * with **no correction for refraction**. That is deliberate: the −6° civil
 * twilight threshold is defined on the geometric centre, so correcting here
 * would move the definition rather than sharpen it. (Sunrise and sunset, at
 * −0.833°, are the ones that carry refraction and the sun's radius in the
 * threshold instead — this module does not compute them, and nothing in the
 * night calculation needs them.)
 *
 * Altitude is reckoned from the horizon at **sea level**. An aircraft at FL350
 * sees the horizon about 3.3° below level and is still in twilight when the
 * ground below is not, so a cruise-level reading would log less night than this
 * one. The logbook records no cruise altitude, and the aerodrome-based
 * definition means the ground; see the decisions in `Claude Context/HOW_IT_WORKS.md`.
 */
export function sunAltitudeDegrees(when: Date, { lat, lon }: Coordinates): number {
  const time = when.getTime();
  if (!Number.isFinite(time) || !Number.isFinite(lat) || !Number.isFinite(lon)) return NaN;

  const t = julianCentury(when);
  const declination = Math.asin(sinDeg(obliquityDeg(t)) * sinDeg(apparentLongitudeDeg(t))) * RAD;
  const eqTime = equationOfTimeMinutes(when);

  // Apparent solar time at this longitude, in minutes: clock time, plus the
  // sun's own running early or late, plus four minutes per degree east.
  const trueSolarMinutes = utcMinutesOfDay(when) + eqTime + 4 * lon;

  // Hour angle: 0° at local solar noon, ±180° at solar midnight, 15° per hour.
  let hourAngle = (trueSolarMinutes / 4 - 180) % 360;
  if (hourAngle < -180) hourAngle += 360;
  if (hourAngle > 180) hourAngle -= 360;

  const cosZenith =
    sinDeg(lat) * sinDeg(declination) +
    cosDeg(lat) * cosDeg(declination) * cosDeg(hourAngle);

  // Clamp: rounding can push this a hair outside [-1, 1] at the poles, and
  // `Math.acos` answers NaN rather than 0° or 180°.
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith))) * RAD;
  return 90 - zenith;
}

/**
 * The altitude below which it is night: the end of evening civil twilight.
 *
 * A named constant rather than a `-6` in the middle of a comparison, because
 * this number *is* the regulation. Anything that wants a different definition —
 * an authority that prescribes sunset-to-sunrise instead — changes it here and
 * nowhere else.
 */
export const CIVIL_TWILIGHT_DEGREES = -6;
