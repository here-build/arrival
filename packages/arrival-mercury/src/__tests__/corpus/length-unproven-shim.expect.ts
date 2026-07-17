import type { ExpectedOutcome } from "../../index.js";

/**
 * `list-or-string`'s union (`List<number> | string`) fails `provesArray` (a
 * string is not array/pair/nonEmptyList-shaped) — UNPROVEN, rides the runtime
 * `length` shim, which dispatches uniformly over list/vector/string carriers.
 * `flag` is `#t` → the 3-element list: `(length '(1 2 3))` → `3`.
 */
export const expected: ExpectedOutcome = { value: 3 };
