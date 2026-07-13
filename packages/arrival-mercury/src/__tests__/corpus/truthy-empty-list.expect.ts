import type { ExpectedOutcome } from "../../index.js";

/**
 * '() is Scheme-truthy (only #f is false) — and nil-as-array means the
 * compiled condition is a (truthy) empty array. Both worlds take the then-arm.
 */
export const expected: ExpectedOutcome = { value: "a" };
