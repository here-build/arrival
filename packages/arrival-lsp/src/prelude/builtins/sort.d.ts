// ─────────────────────────────────────────────────────────────────────────────
// L<sort> — `sort` — stable list sort with an optional comparator.
//
// Scheme semantics: (sort list [comparator]) → a new list with the same elements
//   sorted. The comparator, if supplied, is `(a b) → number` (JS-style ordering:
//   <0 a-before-b, >0 b-before-a). With no comparator, the runtime falls back to
//   the default JS `Array.prototype.sort` ordering.
//   NOTE: runtime arg order is (LIST, comparator?) — list FIRST, comparator
//   OPTIONAL second — NOT the `(cmp, xs)` shape; grounded below.
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   sandbox-env.ts:393
//
// Pattern: re-declare `interface ArrShape` with this ONE member, written purely
// in terms of PRE's base types (`List<T>`, `SNum`). Element type `T` is preserved
// in → out so a mis-typed comparator or a wrong-typed result bites.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  sort<T>(xs: List<T>, cmp?: (a: T, b: T) => SNum): List<T>;
}
