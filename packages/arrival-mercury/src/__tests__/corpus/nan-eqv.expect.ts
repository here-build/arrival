import type { ExpectedOutcome } from "../../index.js";

/**
 * Runtime-sentinel cell (Appendix B): interpreter `eqv?` is `Object.is`-shaped —
 * `(eqv? NaN NaN)` is `#t` (interpreter-verified, all three NaN spellings).
 * A `===` lowering yields `false` (`NaN === NaN`).
 */
export const expected: ExpectedOutcome = { value: true };
