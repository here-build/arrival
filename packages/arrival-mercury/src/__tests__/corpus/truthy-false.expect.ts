import type { ExpectedOutcome } from "../../index.js";

/** Regression guard for the one genuinely false value: `#f` takes the else arm. */
export const expected: ExpectedOutcome = { value: "b" };
