// ─────────────────────────────────────────────────────────────────────────────
// `*` — variadic numeric multiplication.
//
// Scheme semantics: (* n ...) → the product of all arguments; (* ) → 1.
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// Operator name `*` is not a valid TS identifier → bracketed string key.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "*"(...n: number[]): number;
}
