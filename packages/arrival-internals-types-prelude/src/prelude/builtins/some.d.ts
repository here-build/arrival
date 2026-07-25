// ─────────────────────────────────────────────────────────────────────────────
// `some` — does ANY element satisfy the predicate?
//
// Scheme semantics: (some pred list) → #t iff `pred` returns truthy for at least
// one element of `list` (SRFI-1 `any`, narrowed to the single-list shape the
// emitter lowers). Predicate-first, single list, boolean result.
// // Generic in the element type `T` so the predicate's parameter is checked against
// the list's element type — `(some odd? xs)` where xs is a string-list bites.
// ─────────────────────────────────────────────────────────────────────────────

declare function some<T>(pred: (x: T) => boolean, xs: List<T>): boolean;
