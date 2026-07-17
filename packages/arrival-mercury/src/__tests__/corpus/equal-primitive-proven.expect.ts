import type { ExpectedOutcome } from "../../index.js";

/**
 * Both operands prove `numeric` — for a primitive, scheme `equal?` IS `===`
 * (§7's one-number law), so this lowers to the bare JS `5 === 5`.
 */
export const expected: ExpectedOutcome = { value: true };
