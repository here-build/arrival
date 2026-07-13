import type { ExpectedOutcome } from "../../index.js";

/**
 * `eq?` is identity, not structure: a freshly-appended string is a distinct
 * object from the literal — `#f` (interpreter-verified; arrival strings are
 * boxed, so identity is observable). A `===` lowering compares JS string
 * primitives and yields `true`. Twin of `eq-vs-equal-string-equal`.
 */
export const expected: ExpectedOutcome = { value: false };
