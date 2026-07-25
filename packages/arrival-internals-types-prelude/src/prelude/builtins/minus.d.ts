// ─────────────────────────────────────────────────────────────────────────────
// `"-"` — arithmetic subtraction (and unary negation).
//
// Scheme semantics: (- n ...) → subtract remaining args from the first, or
//   negate a single argument. At least one number required; rest are readonly.
// // ─────────────────────────────────────────────────────────────────────────────

// Rest is `readonly` so `(apply - xs)` accepts `List<number>` (see plus.d.ts).
declare function $dash$(first: number, ...rest: readonly number[]): number;
