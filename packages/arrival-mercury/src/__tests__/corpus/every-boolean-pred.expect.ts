import type { ExpectedOutcome } from "../../index.js";

/**
 * `every` with a genuinely boolean predicate — verdict-only shape where the
 * guarded `.every` agrees with SRFI every (last predicate result = #t).
 */
export const expected: ExpectedOutcome = { value: true };
