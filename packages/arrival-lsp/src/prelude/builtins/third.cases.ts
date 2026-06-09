// ─────────────────────────────────────────────────────────────────────────────
// Cases for `third` — third element of a list.
//
// good: well-typed calls that should produce 0 diagnostics.
// bad:  ill-typed calls that should bite (TSxxxx).
// ─────────────────────────────────────────────────────────────────────────────
export const cases = {
  good: [
    // (third (list 1 2 3)) → 3 (a number)
    "__arr.third([1, 2, 3])",
    // (third (list "a" "b" "c")) → "c" (a string)
    '__arr.third(["a", "b", "c"])',
  ],
  bad: [
    // third of a non-list (number) → Argument of type 'number' is not assignable to List<T> (TS2345)
    "__arr.third(42)",
  ],
};
