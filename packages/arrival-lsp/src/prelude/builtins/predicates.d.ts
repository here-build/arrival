// ─────────────────────────────────────────────────────────────────────────────
// L — `zero?`, `even?`, `odd?`, `null?`, `empty?`, `not`, `equal?`, `eq?`
//   — predicate family.
//
// Scheme semantics:
//   (zero? n)     → #t iff n is 0
//   (even? n)     → #t iff n is even
//   (odd? n)      → #t iff n is odd
//   (null? xs)    → #t iff xs is the empty list / nil
//   (empty? xs)   → #t iff xs is the empty list / nil
//   (not v)       → #t iff v is #f (R7RS: only #f is falsy)
//   (equal? a b)  → #t iff a and b are structurally equal
//   (eq? a b)     → #t iff a and b are identical (reference equal)
//
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   stdlib.ts:72-77, stdlib.ts:302-307 · lips.ts:3498, 3844
//   inference-env.ts:323, inference-env.ts:348
//   operators/numeric.ts:577, 598, 605
//
// Pattern: re-declare `interface ArrShape` with these EIGHT members (all in one
//   file, all predicate-named → bracketed string keys where TS-illegal), written
//   purely in terms of PRE's base types. TS merges this into the shared `__arr`
//   (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "zero?"(n: SNum): SBool;
  "even?"(n: SNum): SBool;
  "odd?"(n: SNum): SBool;
  "null?"(xs: List<unknown>): SBool;
  "empty?"(xs: List<unknown>): SBool;
  not(v: unknown): SBool;
  "equal?"(a: unknown, b: unknown): SBool;
  "eq?"(a: unknown, b: unknown): SBool;
}
