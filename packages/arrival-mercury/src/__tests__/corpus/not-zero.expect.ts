import type { ExpectedOutcome } from "../../index.js";

/** `(not 0)` is `#f` — 0 is truthy. A raw `!0` lowering yields `true`. */
export const expected: ExpectedOutcome = { value: false };
