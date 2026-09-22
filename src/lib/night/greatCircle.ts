/**
 * The path a flight takes, for the purpose of asking where the sun is.
 *
 * A flight is not a point, and a long one can leave in daylight and arrive in
 * darkness having crossed the terminator somewhere over the ocean. To know how
 * much of it was night, the app has to know where the aircraft was at each
 * moment — so it walks the great circle between the two aerodromes.
 *
 * Everything here works in 3D unit vectors rather than in degrees of latitude
 * and longitude. That is the whole trick: the antimeridian, the poles and a
 * route that crosses both stop being special cases, because a vector does not
 * know that longitude wraps.
 *
 * The model this supports is stated in `Claude Context/HOW_IT_WORKS.md` and is deliberately
 * simple: the aircraft is at the departure aerodrome at off-block and at the
 * arrival aerodrome at on-block, covering a constant fraction of the path per
 * minute. It does not fly SIDs, it does not hold, and it does not taxi.
 */
import type { Coordinates } from './solar';

export type { Coordinates };

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Mean radius of the earth in nautical miles. */
const EARTH_RADIUS_NM = 3440.065;

/** A point on the unit sphere. */
interface Vector {
  x: number;
  y: number;
  z: number;
}

function toVector({ lat, lon }: Coordinates): Vector {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const cosPhi = Math.cos(phi);
  return { x: cosPhi * Math.cos(lambda), y: cosPhi * Math.sin(lambda), z: Math.sin(phi) };
}

function toCoordinates({ x, y, z }: Vector): Coordinates {
  return {
    lat: Math.atan2(z, Math.hypot(x, y)) * RAD,
    lon: Math.atan2(y, x) * RAD,
  };
}

/** Whether a coordinate pair is usable at all. */
export function isValidCoordinates(value: Coordinates | undefined | null): value is Coordinates {
  return (
    !!value &&
    Number.isFinite(value.lat) &&
    Number.isFinite(value.lon) &&
    Math.abs(value.lat) <= 90 &&
    Math.abs(value.lon) <= 180
  );
}

/** The angle subtended at the centre of the earth, in radians. */
function centralAngle(a: Vector, b: Vector): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  // Cross-product magnitude with `atan2` rather than `acos(dot)`: the latter
  // loses most of its precision for the short hops that make up most logbooks.
  const cross = Math.hypot(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  );
  return Math.atan2(cross, dot);
}

/** Great-circle distance in nautical miles. */
export function greatCircleDistanceNm(from: Coordinates, to: Coordinates): number {
  if (!isValidCoordinates(from) || !isValidCoordinates(to)) return NaN;
  return centralAngle(toVector(from), toVector(to)) * EARTH_RADIUS_NM;
}

/**
 * The point a given fraction of the way along the great circle from `from` to
 * `to`. Fraction 0 is the departure aerodrome, 1 the arrival.
 *
 * Two degenerate cases, both handled rather than guarded against:
 *
 * - **A local flight** that returns to its departure aerodrome has no path at
 *   all. The aircraft stays put, which is the right answer for the sun as well
 *   as arithmetically the only stable one.
 * - **Antipodal aerodromes** have no unique great circle between them —
 *   infinitely many pass through both. The fallback interpolates the
 *   coordinates directly, which is *a* path and a stable one, but it is not the
 *   right answer to a question that has none. No pair of aerodromes on earth is
 *   antipodal to within the tolerance below, so this exists to keep the
 *   function total, not because a flight will meet it.
 */
export function interpolateGreatCircle(
  from: Coordinates,
  to: Coordinates,
  fraction: number,
): Coordinates {
  if (!isValidCoordinates(from) || !isValidCoordinates(to)) return { lat: NaN, lon: NaN };
  if (fraction <= 0) return { lat: from.lat, lon: from.lon };
  if (fraction >= 1) return { lat: to.lat, lon: to.lon };

  const a = toVector(from);
  const b = toVector(to);
  const angle = centralAngle(a, b);
  const sinAngle = Math.sin(angle);

  if (Math.abs(sinAngle) < 1e-9) {
    // Same point, or antipodal. See the note above.
    if (angle < 1) return { lat: from.lat, lon: from.lon };
    return {
      lat: from.lat + (to.lat - from.lat) * fraction,
      lon: from.lon + (to.lon - from.lon) * fraction,
    };
  }

  const scaleA = Math.sin((1 - fraction) * angle) / sinAngle;
  const scaleB = Math.sin(fraction * angle) / sinAngle;

  return toCoordinates({
    x: scaleA * a.x + scaleB * b.x,
    y: scaleA * a.y + scaleB * b.y,
    z: scaleA * a.z + scaleB * b.z,
  });
}
