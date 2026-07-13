import type { ExpectedOutcome } from "../../index.js";

/**
 * Law T at the PREDICATE boundary — the review-found live divergence:
 * `.filter(f)` consumes results with JS ToBoolean, silently dropping a
 * Scheme-truthy `0` return. The emitter now guards `(…) !== false`.
 */
export const expected: ExpectedOutcome = { value: [0, 1] };
