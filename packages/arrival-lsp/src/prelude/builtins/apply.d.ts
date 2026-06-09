// ─────────────────────────────────────────────────────────────────────────────
// L?? — `apply` — spread a list as the arguments of a function.
//
// Scheme semantics: (apply f args-list) → (f . args-list), i.e. call `f` with the
// elements of `args-list` spread as its positional arguments.
// Runtime truth (the emit this SHARPENS — do NOT import it):
//   arrival-chain-view/src/stdlib.ts:229  (`apply`: `${callee}(...${x})`)
//
// The list spread back into parameters is the bite: `args` must be the function's
// own parameter tuple `A` (a `List<A[number]>` view), and the call yields `R`. A
// wrong-element-typed list (`apply` of a numeric fn over a list of strings) or a
// non-function first arg fails. Pattern: one `interface ArrShape` member written in
// terms of PRE's `List<T>` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  apply<A extends readonly unknown[], R>(f: (...a: A) => R, args: A): R;
}
