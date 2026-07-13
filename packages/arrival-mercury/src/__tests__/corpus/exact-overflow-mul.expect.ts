import type { ExpectedOutcome } from "../../index.js";

/**
 * Divergence-by-design (RATIO ruling, constitution §7 / Appendix B): an exact
 * product whose components leave safe-integer range THROWS the teaching error
 * on the interpreter (`ExactOverflowError` — exactness is a guarantee) while
 * the identical compiled expression floats on silently. Per-side assertions;
 * `interpreter ≡ compiled` is never checked for this row.
 *
 * 94906266² = 9007199326062756 > 2⁵³−1; the compiled value is the exact JS
 * float product (verified: `94906266 * 94906266` on V8).
 */
export const expected: ExpectedOutcome = {
  divergent: {
    interpreter: { errorClass: "exact-overflow" },
    compiled: { value: 9007199326062756 },
  },
};
