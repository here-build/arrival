import type { ExpectedOutcome } from "../../index.js";

/**
 * SRFI `every` is value-RETURNING: last predicate result (2), not a boolean.
 * Compiled `.every` folds to `true` — Phase-1 residual territory (the
 * value-shape half; the predicate-boundary half is already fixed).
 */
export const expected: ExpectedOutcome = { value: 2 };
