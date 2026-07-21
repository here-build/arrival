// ─────────────────────────────────────────────────────────────────────────────
// `cdr` — the REST / TAIL of a list.
//
// Scheme semantics: (cdr list) → all elements of `list` after the first.
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  cdr<T>(xs: List<T>): List<T>;
}
