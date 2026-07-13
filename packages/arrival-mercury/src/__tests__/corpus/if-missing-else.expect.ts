import type { ExpectedOutcome } from "../../index.js";

/**
 * One-armed `if` with a false test: R7RS unspecified; both worlds land JS
 * `undefined` (interpreter void egress / compiled literal `undefined`).
 */
export const expected: ExpectedOutcome = { value: undefined };
