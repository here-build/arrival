import type { ExpectedOutcome } from "../../index.js";

/**
 * Both operands are numeric literals — `numeric: true` on both, so `<` lowers
 * to the bare JS `3 < 5` (the native-leaf-lowering fact-gate's happy path).
 */
export const expected: ExpectedOutcome = { value: true };
