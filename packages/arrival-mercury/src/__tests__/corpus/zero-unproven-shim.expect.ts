import type { ExpectedOutcome } from "../../index.js";

/**
 * `num-or-list`'s union leaves `zero?`'s operand UNPROVEN — rides the runtime
 * shim (`nativeNumericOp("zero?", ...)`, which coerces + doors on a
 * non-number). `flag` is `#t` → `0`: `(zero? 0)` → `#t`.
 */
export const expected: ExpectedOutcome = { value: true };
