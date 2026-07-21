// ─────────────────────────────────────────────────────────────────────────────
// `last` — last element of a list.
//
// Scheme semantics: (last list) → the final element of a non-empty list.
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  last<T>(xs: List<T>): T;
}
