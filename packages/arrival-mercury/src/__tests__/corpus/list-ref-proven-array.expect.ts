import type { ExpectedOutcome } from "../../index.js";

/**
 * `(list 10 20 30)` is array-backed and provably so — `list-ref` lowers to
 * the bare JS index read `xs[1]`.
 */
export const expected: ExpectedOutcome = { value: 20 };
