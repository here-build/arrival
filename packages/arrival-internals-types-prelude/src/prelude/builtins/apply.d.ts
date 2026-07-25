// ─────────────────────────────────────────────────────────────────────────────
// `apply` — spread a list as the arguments of a function.
//
// Scheme semantics: (apply f args-list) → (f . args-list), i.e. call `f` with the
// elements of `args-list` spread as its positional arguments.
// The list spread back into parameters is the bite: `args` must be the function's
// own parameter tuple `A` (a `List<A[number]>` view), and the call yields `R`. A
// wrong-element-typed list (`apply` of a numeric fn over a list of strings) or a
// non-function first arg fails.
// // ─────────────────────────────────────────────────────────────────────────────

// `args` accepts A or Readonly<A>: rest-parameter callables often surface as
// mutable `number[]` in Parameters, while Scheme lists are `List<T>` (= readonly).
// Without Readonly, `(apply + xs)` with xs: List<number> falsely failed (TS2345).
declare function apply<A extends readonly unknown[], R>(f: (...a: A) => R, args: A | Readonly<A>): R;
