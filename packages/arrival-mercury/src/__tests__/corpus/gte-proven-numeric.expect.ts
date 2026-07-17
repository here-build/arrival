import type { ExpectedOutcome } from "../../index.js";

/** Both operands numeric literals — `>=` lowers to the bare JS `6 >= 6`. */
export const expected: ExpectedOutcome = { value: true };
