// ─────────────────────────────────────────────────────────────────────────────
// L03 — `caddr` — third element accessor.
//
// Scheme semantics: (caddr list) → the third element of a list (index 2),
// equivalent to (car (cdr (cdr list))).
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (here `List<T>`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  caddr<T>(xs: List<T>): T;
}
