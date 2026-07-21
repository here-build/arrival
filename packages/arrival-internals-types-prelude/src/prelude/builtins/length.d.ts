// ─────────────────────────────────────────────────────────────────────────────
// `length` — the count of elements in a list.
//
// Scheme semantics: (length list) → the number of elements in `list`.
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  length(xs: List<unknown>): number;
}
