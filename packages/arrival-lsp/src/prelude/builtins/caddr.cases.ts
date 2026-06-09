// ─────────────────────────────────────────────────────────────────────────────
// Cases for `caddr` — third element accessor.
//
// good: well-typed calls that should produce 0 diagnostics.
// bad:  ill-typed calls that should bite (TSxxxx).
// ─────────────────────────────────────────────────────────────────────────────
export const cases = {
  good: [
    // (caddr (list 1 2 3)) → 3 (a number)
    "__arr.caddr([1, 2, 3])",
    // (caddr (list "a" "b" "c")) → "c" (a string)
    '__arr.caddr(["a", "b", "c"])',
  ],
  bad: [
    // caddr of a non-list (number) → Argument of type 'number' is not assignable to List<T> (TS2345)
    "__arr.caddr(42)",
  ],
};
