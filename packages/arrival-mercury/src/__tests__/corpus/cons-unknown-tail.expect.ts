import type { ExpectedOutcome } from "../../index.js";

/**
 * `cons` with an UNKNOWN tail: `num-or-list`'s two `if` branches return a number
 * on one arm and a list on the other, so its inferred return type is a genuine
 * union neither `provesArray` nor `provesScalar` can claim (a union claims a fact
 * only when EVERY constituent does). Neither the spread nor the bare-pair form is
 * safe here — the tail really could be either shape at runtime — so the residual
 * rides the `cons` stage-0 shim, which decides with a real `Array.isArray` check.
 * `flag` is `#t`, so `num-or-list` returns the scalar arm (`7`): `["key", 7]`.
 */
export const expected: ExpectedOutcome = { value: ["key", 7] };
