import type { ExpectedOutcome } from "../../index.js";

/**
 * Prohibited-dynamics door row (constitution §2.2): `set!` is
 * `Door("prohibited-dynamics/set!")` unconditionally — doors are syntactic,
 * not reachability-gated — so even inside `or`'s never-reached second operand
 * the program must classify as a `prohibited-dynamics` throw on both sides.
 *
 * Designed truth, not current truth: the compiled side needs CoreForm's `Door`
 * (Phase 1), and today's interpreter evaluates lazily — the untaken branch
 * never reaches `set!`, so it returns `0` instead of dooring. The row is
 * `it.fails`-tracked until the static-door mechanism exists.
 */
export const expected: ExpectedOutcome = { errorClass: "prohibited-dynamics" };
