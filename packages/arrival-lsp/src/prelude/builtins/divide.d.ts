// ─────────────────────────────────────────────────────────────────────────────
// `"/"` — arithmetic division (and unary reciprocal).
//
// Scheme semantics: (/ n ...) → divide the first arg by the rest, or
//   take the reciprocal of a single argument. At least one number required.
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// Operator name `/` is not a valid TS identifier → bracketed string key.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "/"(first: number, ...rest: number[]): number;
}
