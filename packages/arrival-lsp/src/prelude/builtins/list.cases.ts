// Cases for the `list` builtin leaf.
// good = should type-check clean; bad = should produce a TS error.
export const cases = {
  good: [
    // Constructing a List<SNum> from SNum arguments — result is List<number>.
    "__arr.list(1, 2, 3)",
    // Empty invocation — List<never>, assignable to any List<T>.
    "__arr.list()",
  ],
  bad: [
    // Heterogeneous args: 'oops' is not assignable to the inferred T=number.
    // TS2345 — Argument of type 'string' is not assignable to parameter of type 'number'.
    "__arr.list(1, 'oops')",
    // Assigning a List<number> to a scalar SNum should error TS2322.
    "const n: SNum = __arr.list(1, 2, 3)",
  ],
} as const;
