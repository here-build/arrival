import type { ExpectedOutcome } from "../../index.js";

/**
 * Fuzzer-found (first run, 2026-07-14) and FIXED the same day: null?'s clean
 * `.length` form is now fact-gated (Law F) — an unproven argument rides the
 * stage-0 Array.isArray shim, so a string (which also carries .length) answers
 * #f exactly like the interpreter. Kept as the permanent deterministic
 * regression row for the representation-collision class.
 */
export const expected: ExpectedOutcome = { value: false };
