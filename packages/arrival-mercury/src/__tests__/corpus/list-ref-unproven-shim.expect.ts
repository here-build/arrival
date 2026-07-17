import type { ExpectedOutcome } from "../../index.js";

/**
 * `num-or-list`'s union (`number | List<number>`) leaves `list-ref`'s first
 * operand UNPROVEN — rides the runtime spine-walk shim. `flag` is `#f` → the
 * list: `(list-ref '(10 20 30) 1)` → `20`.
 */
export const expected: ExpectedOutcome = { value: 20 };
