import type { ExpectedOutcome } from "../../index.js";

/** Numeric `=` compares value, not exactness: `(= 1 1.0)` is `#t` — native `1 === 1.0` agrees (Appendix B: natively correct). */
export const expected: ExpectedOutcome = { value: true };
