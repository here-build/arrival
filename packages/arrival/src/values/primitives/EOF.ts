import { CLASS } from "../../well-known-symbols.js";

/** R7RS end-of-file object. Compared by identity against the {@link eof} singleton, so the reader can
 *  signal "input exhausted" with a sentinel distinguishable from any datum (`#f`, `nil`, etc.). */
export class EOF {
  /** Type identity for CLASS-brand readers (`type()` in utils/typecheck): EOF sits outside
   *  the AValue hierarchy, so without a brand it needs a bespoke instanceof arm there. */
  static [CLASS] = "eof";

  toString(): string {
    return "#<eof>";
  }

  ["arrival/print"](): string {
    return this.toString();
  }
}

/** The one EOF value — identity-compared everywhere; never construct another. */
export const eof = new EOF();
