// ─────────────────────────────────────────────────────────────────────────────
// `list-ref` — indexed element access on a list.
//
// Scheme semantics: (list-ref list k) → the k-th element (0-based) of `list`.
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "list-ref"<T>(xs: List<T>, i: number): T;
}
