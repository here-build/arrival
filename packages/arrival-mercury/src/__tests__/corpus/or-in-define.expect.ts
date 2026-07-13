import type { ExpectedOutcome } from "../../index.js";

/**
 * Value-returning `or` INSIDE a define — the review-mandated shape the
 * trailing-expression corpus could not see: top-level `await` is legal in
 * `.mts`, so a wrongly async-wrapped `or` only detonates inside a sync
 * function body.
 */
export const expected: ExpectedOutcome = { value: 0 };
