import type { ExpectedOutcome } from "../../index.js";

/**
 * `num-or-list`'s union leaves `>`'s first operand UNPROVEN — rides the
 * runtime shim. `flag` is `#t` → `7`: `(> 7 4)` → `#t`.
 */
export const expected: ExpectedOutcome = { value: true };
