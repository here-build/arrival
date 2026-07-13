import type { ExpectedOutcome } from "../../index.js";

/**
 * Operator-identity cell (Appendix B): Scheme `modulo` follows the divisor's
 * sign — `(modulo -7 3)` is `2`. JS `%` is a remainder (`-7 % 3` → `-1`).
 * The one correct algorithm: `((a % n) + n) % n`.
 */
export const expected: ExpectedOutcome = { value: 2 };
