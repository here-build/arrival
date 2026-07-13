import type { ExpectedOutcome } from "../../index.js";

/**
 * Non-evaluation probe: if the untaken second operand is ever evaluated, BOTH
 * sides throw and this value row fails loudly. `error` is the immutability-legal
 * side-effect probe (`set!` doors; `(car '())` is Law-U-tolerant and proves nothing).
 */
export const expected: ExpectedOutcome = { value: false };
