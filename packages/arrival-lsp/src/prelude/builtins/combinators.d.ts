// ─────────────────────────────────────────────────────────────────────────────
// L<combinators> — the point-free / control combinators that are ACTUALLY LIVE in
// the inference env: `always`, `clone`, `repr`, `when`, `unless`.
//
// Scheme semantics:
//   (always x)          → a thunk returning x
//   (clone xs)          → a structural copy of the list/pair xs
//   (repr obj [quote])  → a printed-representation string of obj
//   (when test e ...)   → last e if test is truthy, else nil   (a macro)
//   (unless test e ...) → last e if test is falsy, else nil    (a macro)
//
// EMPIRICAL CULL (probed against the constructed inference env, 2026-06-16): the
// former Ramda-derived members `identity` / `id` / `constant` / `negate` / `type` /
// `where`, plus the inline `tap`, are NO LONGER BOUND — cut in the 2026-06-15 Ramda
// eviction (only a curated set survived). Typing them here made the lens advertise
// symbols unbound at runtime, so they are removed. `when` / `unless` are now
// `define-macro`s (with evaluator special-forms); their honest return is `T | Nil`
// (the last body value when the gate passes, else nil — NOT `void`).
//
// Pattern: re-declare `interface ArrShape` with these members, written in terms of
// PRE's base types (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  always<T>(x: T): () => T;
  clone<T>(xs: List<T>): List<T>;
  repr(obj: unknown, quote?: unknown): string;
  when<T>(test: unknown, ...body: T[]): T | Nil;
  unless<T>(test: unknown, ...body: T[]): T | Nil;
}
