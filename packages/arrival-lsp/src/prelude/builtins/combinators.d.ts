// ─────────────────────────────────────────────────────────────────────────────
// L<combinators> — point-free / control combinator family:
//   `identity`, `id`, `always`, `constant`, `negate`, `tap`, `clone`, `type`,
//   `repr`, `where`, `when`, `unless`.
//
// Scheme semantics:
//   (identity x)       → x  (alias: id)
//   (always x)         → a thunk returning x  (alias: constant)
//   (negate n)         → arithmetic negation of n  (★ NUMERIC, see below)
//   (tap fn)           → a function that runs fn for effect and returns its input
//   (clone xs)         → a structural copy of the list/pair xs
//   (type obj)         → a string naming obj's runtime type ("number", "pair", …)
//   (repr obj [quote]) → a printed-representation string of obj
//   (where pred list)  → list filtered by pred  (★ = filter, see below)
//   (when test e ...)  → last e if test is truthy, else nil
//   (unless test e ...)→ last e if test is falsy, else nil
//
// Runtime truth (the `any` impls these SHARPEN — do NOT import them):
//   ramda-functions.ts:75-76  identity / id      = R.identity
//   ramda-functions.ts:77-78  always / constant  = R.always
//   ramda-functions.ts:350    negate             = (a) => -a   (★ numeric, NOT R.negate)
//   ramda-functions.ts:181    where              = R.filter    (★ filter, NOT R.where)
//   sandbox-env.ts:410-413    tap   (inline)     = (fn) => (x) => { fn(x); return x; }
//   sandbox-env.ts:364-373    when / unless (inline)
//   lips.js:3101 clone · 3236 repr · stdlib type() helper (via SAFE_BUILTINS)
//
// ★ Precedence corrections that change the signatures:
//   • `negate` is the RAMDA ARITHMETIC `(a) => -a`, NOT boolean R.negate → SNum→SNum.
//   • `where` aliases `R.filter` (raw), NOT R.where's spec-object predicate map →
//     it is plain (pred, list) filtering.
//   • `tap` is CURRIED (inline wins): `(fn) => (x) => x` — note the two-stage call.
//   • `when`/`unless` are the INLINE sandbox approximations (sandbox-env.ts:364),
//     which return the last body value when the gate passes, else `nil` — so the
//     honest return is `T | Nil`, NOT `Unit`.
//
// `instanceof` (assigned) is INTENTIONALLY OMITTED: it is in FORBIDDEN_IN_SANDBOX
// (sandbox-env.ts:178) and stripped from `wrappedOps`, so it is not reachable from
// sandbox code — there is no runtime binding to type.
//
// identity/always thread their input type so a `(map identity xs)` or
// `((always v))` stays precise rather than collapsing to `any`.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  identity<T>(x: T): T;
  id<T>(x: T): T;
  always<T>(x: T): () => T;
  constant<T>(x: T): () => T;
  negate(n: SNum): SNum;
  tap<T>(fn: (x: T) => Unit): (x: T) => T;
  clone<T>(xs: List<T>): List<T>;
  type(obj: unknown): SStr;
  repr(obj: unknown, quote?: unknown): SStr;
  where<T>(pred: (x: T) => unknown, list: List<T>): List<T>;
  when<T>(test: unknown, ...body: T[]): T | Nil;
  unless<T>(test: unknown, ...body: T[]): T | Nil;
}
