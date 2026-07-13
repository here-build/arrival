import type { ExpectedOutcome } from "../../index.js";

/** `quotient` truncates toward zero: `(quotient -7 3)` is `-2` (`Math.trunc(-7/3)` agrees). */
export const expected: ExpectedOutcome = { value: -2 };
