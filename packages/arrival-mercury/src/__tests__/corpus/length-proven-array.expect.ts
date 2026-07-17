import type { ExpectedOutcome } from "../../index.js";

/**
 * `(list 1 2 3)` is array-backed and provably so (`list: true`) — `length`
 * lowers to the bare JS `.length` member read.
 */
export const expected: ExpectedOutcome = { value: 3 };
