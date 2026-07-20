// ─────────────────────────────────────────────────────────────────────────────
// `zero?`, `even?`, `odd?`, `null?`, `empty?`, `not`, `equal?`, `eq?`
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
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "zero?"(n: number): boolean;
  "even?"(n: number): boolean;
  "odd?"(n: number): boolean;
  "null?"(xs: List<unknown>): boolean;
  "empty?"(xs: List<unknown>): boolean;
  not(v: unknown): boolean;
  "equal?"(a: unknown, b: unknown): boolean;
  "eq?"(a: unknown, b: unknown): boolean;
}
