import type { ExpectedOutcome } from "../../index.js";

/**
 * `num-or-list`'s union (`number | List<number>`) leaves `<=`'s first operand
 * UNPROVEN — rides the runtime shim. `flag` is `#t` → `7`: `(<= 7 7)` → `#t`.
 */
export const expected: ExpectedOutcome = { value: true };
