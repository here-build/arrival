// ─────────────────────────────────────────────────────────────────────────────
// `+` — variadic numeric addition.
//
// Scheme semantics: (+ n ...) → the sum of all arguments; (+ ) → 0.
// // Operator name `+` is not a valid TS identifier → bracketed string key.
// ─────────────────────────────────────────────────────────────────────────────

// Rest is `readonly` so `(apply + xs)` accepts `List<number>` (also readonly).
// Mutable `number[]` rest made List unassignable — phantom dep errors on avg-like helpers.
declare function $plus$(...n: readonly number[]): number;
