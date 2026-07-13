import type { ExpectedOutcome } from "../../index.js";

/**
 * The non-evaluation row: `or` takes its first truthy operand without touching
 * the second. Evaluation of the untaken branch ⇒ both sides throw ⇒ this value
 * row fails loudly. Pairs with `short-circuit-control` (the positive control
 * proving the probe actually fires when the branch IS taken). String operand
 * (not a symbol) keeps the row face-free.
 */
export const expected: ExpectedOutcome = { value: "a" };
