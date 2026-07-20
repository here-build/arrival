// ─────────────────────────────────────────────────────────────────────────────
// `<`, `>`, `<=`, `>=`, `=` — numeric comparison / equality family.
//
// Scheme semantics: (< n ...) → #t iff each argument is strictly less than
//   the next; chained n-ary comparison. All five operators work the same way:
//   they accept ≥2 number arguments and return a boolean. The emitter lowers them
//   via `chainCompare` which chains pairwise `&&`-joined comparisons for n>2.
//
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "<"(...n: number[]): boolean;
  ">"(...n: number[]): boolean;
  "<="(...n: number[]): boolean;
  ">="(...n: number[]): boolean;
  "="(...n: number[]): boolean;
}
