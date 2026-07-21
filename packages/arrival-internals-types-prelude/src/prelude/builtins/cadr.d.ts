// ─────────────────────────────────────────────────────────────────────────────
// `cadr` — second element (car of cdr) of a list.
//
// Scheme semantics: (cadr xs) → the second element of xs, i.e. (car (cdr xs)).
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  cadr<T>(xs: List<T>): T;
}
