// ─────────────────────────────────────────────────────────────────────────────
// L — `"-"` — arithmetic subtraction (and unary negation).
//
// Scheme semantics: (- n ...) → subtract remaining args from the first, or
//   negate a single argument. At least one SNum required; rest are SNum[].
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (`SNum`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "-"(first: SNum, ...rest: SNum[]): SNum;
}
