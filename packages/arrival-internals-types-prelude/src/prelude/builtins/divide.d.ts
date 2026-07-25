// ─────────────────────────────────────────────────────────────────────────────
// `"/"` — arithmetic division (and unary reciprocal).
//
// Scheme semantics: (/ n ...) → divide the first arg by the rest, or
//   take the reciprocal of a single argument. At least one number required.
// // Operator name `/` is not a valid TS identifier → bracketed string key.
// ─────────────────────────────────────────────────────────────────────────────

// Rest is `readonly` so `(apply / xs)` accepts `List<number>` (see plus.d.ts).
declare function $slash$(first: number, ...rest: readonly number[]): number;
