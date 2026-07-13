import type { ExpectedOutcome } from "../../index.js";

/**
 * `and` is value-position divergent under a raw `&&` lowering: Scheme `(and 0 1)`
 * returns the last operand `1` (0 is truthy); JS `(0 && 1)` returns `0`.
 */
export const expected: ExpectedOutcome = { value: 1 };
