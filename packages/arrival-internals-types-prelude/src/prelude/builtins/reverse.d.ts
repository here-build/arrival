// ─────────────────────────────────────────────────────────────────────────────
// `reverse` — reverses a list.
//
// Scheme semantics: (reverse list) → a new list with elements in reverse order.
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  reverse<T>(xs: List<T>): List<T>;
}
