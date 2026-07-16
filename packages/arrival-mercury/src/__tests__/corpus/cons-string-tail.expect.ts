import type { ExpectedOutcome } from "../../index.js";

/**
 * `cons` with a PROVEN string tail: unconditional spread silently char-exploded
 * a string (`[1, ..."ab"]` → `[1, "a", "b"]`) instead of throwing — the quieter
 * half of the same defect the scalar-tail row catches loudly. The tail fact gate
 * proves `stringy` here (a literal), so the residual keeps the string whole as
 * the second slot: `[1, "ab"]`.
 */
export const expected: ExpectedOutcome = { value: [1, "ab"] };
