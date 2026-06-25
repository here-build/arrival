// ─────────────────────────────────────────────────────────────────────────────
// L?? — `find` — the FIRST element satisfying the predicate, or missing.
//
// Scheme semantics: (find pred list) → the first element of `list` for which
// `pred` returns truthy; if none match, the SRFI-1 missing sentinel (`#f`).
// Predicate-first, single list. Modeled as `T | undefined`: the success case is
// precisely the list's element type, and the no-match case is `undefined` (the
// glass over SRFI-1's `#f`-on-miss) so callers must account for the absence —
// `(string-upcase (find p strs))` bites because `find` may be `undefined`.
//   bootstrap env the wrapped ops are drawn from; cf. `xs.find(pred)` semantics).
//
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (`List<T>`). TS merges this into the shared
// `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT). Generic in the element
// type `T` so the predicate's parameter is checked against the list's element
// type — `(find odd? strs)` where strs is a string-list bites.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  find<T>(pred: (x: T) => boolean, xs: List<T>): T | undefined;
}
