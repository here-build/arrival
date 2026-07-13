import type { ExpectedOutcome } from "../../index.js";

/** `equal?` is structural: same characters ⇒ `#t`. Documents identity-vs-structure against the `eq?` twin. */
export const expected: ExpectedOutcome = { value: true };
