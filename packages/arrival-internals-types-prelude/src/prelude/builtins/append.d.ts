// ─────────────────────────────────────────────────────────────────────────────
// `append` — concatenate zero or more lists into a single list.
//
// Scheme semantics: (append list …) → a list containing all elements of each
// input list in order. Every argument must be a list of the same element type T;
// the result is `List<T>`. Zero arguments yields an empty list (null ≡ List<never>).
//
// Rest is `readonly List<T>[]` (not `List<T>[]`): PRE's `List` IS `readonly T[]`,
// so `(apply append (map …))` passes a `List<List<T>>` (= readonly array of lists).
// A mutable rest `List<T>[]` rejects that with TS2322/2345 ("readonly cannot be
// assigned to mutable") — a pure dialect artifact, not a Scheme error.
// ─────────────────────────────────────────────────────────────────────────────

declare function append<T>(...xs: readonly List<T>[]): List<T>;
