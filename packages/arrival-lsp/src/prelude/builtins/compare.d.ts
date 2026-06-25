// ─────────────────────────────────────────────────────────────────────────────
// L — `<`, `>`, `<=`, `>=`, `=` — numeric comparison / equality family.
//
// Scheme semantics: (< n ...) → #t iff each argument is strictly less than
//   the next; chained n-ary comparison. All five operators work the same way:
//   they accept ≥2 number arguments and return a boolean. The emitter lowers them
//   via `chainCompare` which chains pairwise `&&`-joined comparisons for n>2.
//
// Pattern: re-declare `interface ArrShape` with these FIVE members (all in one
//   file, all operator-named → bracketed string keys), written purely in terms
//   of PRE's base types (`number`, `boolean`). TS merges this into the shared
//   `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "<"(...n: number[]): boolean;
  ">"(...n: number[]): boolean;
  "<="(...n: number[]): boolean;
  ">="(...n: number[]): boolean;
  "="(...n: number[]): boolean;
}
