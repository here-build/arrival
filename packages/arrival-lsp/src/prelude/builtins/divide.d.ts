// ─────────────────────────────────────────────────────────────────────────────
// L — `"/"` — arithmetic division (and unary reciprocal).
//
// Scheme semantics: (/ n ...) → divide the first arg by the rest, or
//   take the reciprocal of a single argument. At least one number required.
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (`number`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// Operator name `/` is not a valid TS identifier → bracketed string key.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "/"(first: number, ...rest: number[]): number;
}
