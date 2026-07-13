import type { ExpectedOutcome } from "../../index.js";

/**
 * RATIO ruling (constitution §7): the interpreter holds exact 1/3 internally
 * but egresses divided (`AExact["arrival/toJS"]` → `num/denom`); the compiled
 * side is plain JS division. Same double on the same V8 — agreement by
 * construction, exact float equality (no epsilon).
 */
export const expected: ExpectedOutcome = { value: 0.3333333333333333 };
