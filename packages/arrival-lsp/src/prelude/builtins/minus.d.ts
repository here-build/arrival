// ─────────────────────────────────────────────────────────────────────────────
// L — `"-"` — arithmetic subtraction (and unary negation).
//
// Scheme semantics: (- n ...) → subtract remaining args from the first, or
//   negate a single argument. At least one number required; rest are number[].
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (`number`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "-"(first: number, ...rest: number[]): number;
}
