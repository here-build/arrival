import type { ExpectedOutcome } from "../../index.js";

/**
 * THE ASYMMETRIC-GATE ROW: only ONE side (`5`) proves primitive (`numeric`);
 * the other is a freshly-built compound list — NOT proven primitive, and
 * `equalQEmitRule`'s gate is deliberately `||`, not `&&`. A primitive can
 * never `equal?`-match a compound (a type mismatch in `structuralEqual`), and
 * `===` between a number and an object is always `false` too — so `===`
 * agrees with `equal?` here even though only one side is proven. `(equal? 5
 * (list 1 2))` → `#f` either way; the emitted-fixture snapshot (not this
 * value check alone) is what confirms `===` — not the shim — was actually
 * emitted.
 */
export const expected: ExpectedOutcome = { value: false };
