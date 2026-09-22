/**
 * What the app knows about an aerodrome: where it is, and nothing else.
 *
 * Not a name, not a country, not a runway. The night calculation needs a
 * latitude and a longitude, and every extra column would be bytes shipped to
 * every device to answer a question nobody asked. If a later feature needs
 * names, that is a deliberate decision with a size attached to it, not a
 * convenience to slip in here.
 */
import type { Coordinates } from '../night/solar';

export interface Airport extends Coordinates {
  /** The code as the logbook writes it — trimmed and uppercased, e.g. "ENGM". */
  code: string;
}

export type { Coordinates };
