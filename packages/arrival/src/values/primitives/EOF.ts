import { INTEROP_BOUNDARY } from "../../membrane/interop-access.js";

/** R7RS end-of-file object. Compared by identity against the {@link eof} singleton, so the reader can
 *  signal "input exhausted" with a sentinel distinguishable from any datum (`#f`, `nil`, etc.). */
export class EOF {
  /** Interop boundary: EOF sits outside the AValue hierarchy the FAMILY RULE in
   *  interop-access.ts covers, so it carries its own explicit stamp. `type()` (utils/
   *  typecheck.ts) no longer has a brand to report for EOF either — it falls to the
   *  `foreign:EOF` rung, an accepted behavior change (no test pins the old "eof" text). */
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
