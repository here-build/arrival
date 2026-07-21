// ─────────────────────────────────────────────────────────────────────────────
// `append` — concatenate zero or more lists into a single list.
//
// Scheme semantics: (append list …) → a list containing all elements of each
// input list in order. Every argument must be a list of the same element type T;
// the result is `List<T>`. Zero arguments yields an empty list (Nil ≡ List<never>).
//
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  append<T>(...xs: List<T>[]): List<T>;
}
