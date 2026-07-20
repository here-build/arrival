// ─────────────────────────────────────────────────────────────────────────────
// `caddr` — third element accessor.
//
// Scheme semantics: (caddr list) → the third element of a list (index 2),
// equivalent to (car (cdr (cdr list))).
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  caddr<T>(xs: List<T>): T;
}
