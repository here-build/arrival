// ─────────────────────────────────────────────────────────────────────────────
// `first` — first element of a list (alias of `car`).
//
// Scheme semantics: (first list) → the head element of a non-empty list.
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  first<T>(xs: List<T>): T;
}
