// ─────────────────────────────────────────────────────────────────────────────
// L03 — `second` — second element of a list.
//
// Scheme semantics: (second list) → the element at index 1 of a non-empty list.
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (here `List<T>`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  second<T>(xs: List<T>): T;
}
