import type { ExpectedOutcome } from "../../index.js";

/**
 * Law T seed cell: `0` is Scheme-truthy — only `#f` is false. A JS-truthiness
 * ternary (`0 ? … : …`) picks the wrong arm. String arms keep the row
 * face-free: symbol egress is its own cell (`symbol-face`), never mixed into a
 * truthiness row.
 */
export const expected: ExpectedOutcome = { value: "a" };
