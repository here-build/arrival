import type { ExpectedOutcome } from "../../index.js";

/**
 * Resolved by ELIMINATION, not by a static prohibited-dynamics door
 * (gate3-human-grade-rulings.md R-G6; OQ8a's own follow-up, oracle-harness.md).
 * `set!` still classifies to `Door("prohibited-dynamics/set!")` unconditionally
 * (constitution §2.2 — doors are syntactic, not reachability-gated) — but `or`'s
 * FIRST operand here is the literal `#t`, so static prevaluation
 * (`../../prevalue/index.ts`) folds the whole `or` to that value and drops the
 * `(begin (set! n 999) 'x)` branch WHOLE, Door included, before the walker ever
 * lowers it. The compiled artifact ends up with no `set!` and nothing to door on;
 * the interpreter already never evaluated that branch either (lazy `or`). Both
 * sides agree on `n`'s untouched value, `0` — a prior draft considered re-ruling
 * this row to `{ value: 0 }` without fixing the mechanism ("papering," V's own
 * word for it, gate3-human-grade-rulings.md); this greens the honest way, by
 * making the dead branch structurally unreachable.
 */
export const expected: ExpectedOutcome = { value: 0 };
