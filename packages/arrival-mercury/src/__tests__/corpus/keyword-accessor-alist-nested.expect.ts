import type { ExpectedOutcome } from "../../index.js";

/**
 * Alist-lowering ruling (2026-07-17), the nested case: the accessor sits inside
 * an `if`'s condition, not in tail position — the SAME shape the provenance
 * campaign's own adversarial corpus mints pervasively
 * (`probe-adversarial.test.ts` row 1: `(if (:guilty e) "GUILTY" "INNOCENT")` over
 * the one-key alist idiom). Pins that the `.find(...)` lowering composes
 * correctly under Law T's truthiness test, not only when the accessor is the
 * whole program's trailing expression.
 */
export const expected: ExpectedOutcome = { value: "GUILTY" };
