// ─────────────────────────────────────────────────────────────────────────────
// L?? — `some` — does ANY element satisfy the predicate?
//
// Scheme semantics: (some pred list) → #t iff `pred` returns truthy for at least
// one element of `list` (SRFI-1 `any`, narrowed to the single-list shape the
// emitter lowers). Predicate-first, single list, boolean result.
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (`List<T>`, `SBool`). TS merges this into the
// shared `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT). Generic in the
// element type `T` so the predicate's parameter is checked against the list's
// element type — `(some odd? xs)` where xs is a string-list bites.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  some<T>(pred: (x: T) => SBool, xs: List<T>): SBool;
}
