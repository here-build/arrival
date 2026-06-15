// ─────────────────────────────────────────────────────────────────────────────
// L05 — `length` — the count of elements in a list.
//
// Scheme semantics: (length list) → the number of elements in `list`.
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (`List<T>`, `SNum`). TS merges this into the
// shared `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  length(xs: List<unknown>): SNum;
}
