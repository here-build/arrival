import type { ExpectedOutcome } from "../../index.js";

/**
 * `or` returns its first Scheme-truthy operand: `0` wins. A raw `||` lowering
 * returns `999` (JS falsiness of 0) — the value-position half of the Law T cell.
 */
export const expected: ExpectedOutcome = { value: 0 };
