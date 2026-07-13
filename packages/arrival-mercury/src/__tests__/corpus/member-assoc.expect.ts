import type { ExpectedOutcome } from "../../index.js";

/**
 * Operator-identity cell (Appendix B): `member` returns the sublist from the
 * match (`(2 3)` → `[2, 3]`), `assoc` the matching entry (`(2 "b")` → `[2, "b"]`).
 * String alist values (not symbols) keep the row face-free.
 */
export const expected: ExpectedOutcome = {
  value: [
    [2, 3],
    [2, "b"],
  ],
};
