import { INTEROP_BOUNDARY } from "../../membrane/interop-access.js";

/** R7RS end-of-file object. Compared by identity against the {@link eof} singleton, so the reader can
 *  signal "input exhausted" with a sentinel distinguishable from any datum (`#f`, `nil`, etc.). */
export class EOF {
  /** Outside AValue — explicit interop stamp (FAMILY RULE misses non-AValue).
   *  `type()` reports `foreign:EOF`. */
  static [INTEROP_BOUNDARY] = true;

  toString(): string {
    return "#<eof>";
  }

  ["arrival/print"](): string {
    return this.toString();
  }
}

/** The one EOF value — identity-compared everywhere; never construct another. */
export const eof = new EOF();
