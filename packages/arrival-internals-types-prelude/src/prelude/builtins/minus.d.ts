// ─────────────────────────────────────────────────────────────────────────────
// `"-"` — arithmetic subtraction (and unary negation).
//
// Scheme semantics: (- n ...) → subtract remaining args from the first, or
//   negate a single argument. At least one number required; rest are number[].
// // ─────────────────────────────────────────────────────────────────────────────

declare function $dash$(first: number, ...rest: number[]): number;
