import type { ExpectedOutcome } from "../../index.js";

/**
 * `(- 5 5)` is a numeric arithmetic expression — `numeric: true` — so `zero?`
 * lowers to the bare JS `5 - 5 === 0`.
 */
export const expected: ExpectedOutcome = { value: true };
