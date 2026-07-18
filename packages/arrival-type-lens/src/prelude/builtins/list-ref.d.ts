// ─────────────────────────────────────────────────────────────────────────────
// L05 — `list-ref` — indexed element access on a list.
//
// Scheme semantics: (list-ref list k) → the k-th element (0-based) of `list`.
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (`List<T>`, `number`). TS merges this into the
// shared `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "list-ref"<T>(xs: List<T>, i: number): T;
}
