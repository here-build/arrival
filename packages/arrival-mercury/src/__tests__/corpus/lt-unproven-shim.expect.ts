import type { ExpectedOutcome } from "../../index.js";

/**
 * `num-or-list`'s two `if` branches return a number on one arm and a list on
 * the other (the same union idiom as `cons-unknown-tail.scm`) — a genuine
 * union neither arm alone claims `numeric` for (a union claims a fact only
 * when EVERY constituent does), so `<`'s first operand is UNPROVEN. The
 * residual rides the `looseCompare(wrapOrd(...))` runtime shim, never a bare
 * JS `<`. `flag` is `#t`, so `num-or-list` returns the scalar arm (`7`):
 * `(< 7 10)` → `#t`.
 */
export const expected: ExpectedOutcome = { value: true };
