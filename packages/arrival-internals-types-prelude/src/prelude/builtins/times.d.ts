// ─────────────────────────────────────────────────────────────────────────────
// `*` — variadic numeric multiplication.
//
// Scheme semantics: (* n ...) → the product of all arguments; (* ) → 1.
// // Operator name `*` is not a valid TS identifier → bracketed string key.
// ─────────────────────────────────────────────────────────────────────────────

// Rest is `readonly` so `(apply * xs)` accepts `List<number>` (see plus.d.ts).
declare function $star$(...n: readonly number[]): number;
