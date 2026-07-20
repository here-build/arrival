// ─────────────────────────────────────────────────────────────────────────────
// `+` — variadic numeric addition.
//
// Scheme semantics: (+ n ...) → the sum of all arguments; (+ ) → 0.
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// Operator name `+` is not a valid TS identifier → bracketed string key.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "+"(...n: number[]): number;
}
