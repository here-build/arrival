import type { ExpectedOutcome } from "../../index.js";

/**
 * 3-ary `and` — the right-nested ternary chain must thread values through
 * every rung: first `#f` operand or the LAST value (2), never a JS `&&` fold.
 */
export const expected: ExpectedOutcome = { value: 2 };
