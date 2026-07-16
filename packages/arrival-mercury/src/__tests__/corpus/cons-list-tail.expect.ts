import type { ExpectedOutcome } from "../../index.js";

/**
 * `cons` with a PROVEN list tail (a quoted list — `quoteFacts` derives `list`/
 * `nonEmptyList` structurally, no query needed): the spread golden, unchanged by
 * the tail-shape fact gate. Regression guard — `consEmitRule`'s three-way branch
 * must keep emitting `[x, ...xs]` for this shape, never fall back to the runtime
 * shim.
 */
export const expected: ExpectedOutcome = { value: [1, 2, 3] };
