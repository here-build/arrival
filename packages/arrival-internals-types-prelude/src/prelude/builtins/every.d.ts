// ─────────────────────────────────────────────────────────────────────────────
// `every` — universal quantifier over a list.
//
// Scheme semantics: (every pred xs) → #t iff `pred` holds for ALL elements of
// `xs` (predicate FIRST, list SECOND). Lowers to `xs.every(pred)`.
// Precise where Scheme is polymorphic: the predicate's parameter type is bound to
// the list's element type `T`, so passing a predicate that expects the wrong
// element type bites. Return is `boolean`.
// ─────────────────────────────────────────────────────────────────────────────

declare function every<T>(pred: (x: T) => boolean, xs: List<T>): boolean;
