import type { ExpectedOutcome } from "../../index.js";

/**
 * SRFI `any` returns the first truthy predicate RESULT (the witness, 2).
 * Mercury has no `any` emitter yet — unbound in the artifact. Phase-1
 * residual.
 */
export const expected: ExpectedOutcome = { value: 2 };
