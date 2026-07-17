import type { ExpectedOutcome } from "../../index.js";

/** Both operands numeric literals — `>` lowers to the bare JS `9 > 4`. */
export const expected: ExpectedOutcome = { value: true };
