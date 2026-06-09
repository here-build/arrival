// ─────────────────────────────────────────────────────────────────────────────
// L?? — `map` — apply a function over a list, collecting the results.
//
// Scheme semantics: (map f list) → a new list of `(f x)` for each x.
//   `map` is variadic in lists (`(map f xs ys)` index-zips), but v1 types the
//   primary unary-list form precisely so the callback ↔ element types bite.
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   sandbox-env.ts:212 (fn first, then ...lists) · stdlib.ts:144 (mapLike) ·
//   stdlib.ts:201 (map: mapLike("map"))
//
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (`List<T>`). The callback's param type is bound to
// the input element type and its return type drives the output element type, so
// `(map (lambda (n) (string-upcase n)) '(1 2 3))` bites (1 is not an SStr).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  map<A, B>(f: (a: A) => B, xs: List<A>): List<B>;
}
