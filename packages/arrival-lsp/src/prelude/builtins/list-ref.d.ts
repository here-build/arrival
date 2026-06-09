// ─────────────────────────────────────────────────────────────────────────────
// L05 — `list-ref` — indexed element access on a list.
//
// Scheme semantics: (list-ref list k) → the k-th element (0-based) of `list`.
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   stdlib.ts:220 · bridge.ts:1243
//
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (`List<T>`, `SNum`). TS merges this into the
// shared `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "list-ref"<T>(xs: List<T>, i: SNum): T;
}
