import type { ExpectedOutcome } from "../../index.js";

/**
 * `equal?` is structural, recursively — two freshly-built nested lists are
 * `#t`. A `===` lowering reference-compares two distinct arrays → `false`.
 */
export const expected: ExpectedOutcome = { value: true };
