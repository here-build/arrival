// ─────────────────────────────────────────────────────────────────────────────
// `<`, `>`, `<=`, `>=`, `=` — numeric comparison / equality family.
//
// Scheme semantics: (< n ...) → #t iff each argument is strictly less than
//   the next; chained n-ary comparison. All five operators work the same way:
//   they accept ≥2 number arguments and return a boolean. The emitter lowers them
//   via `chainCompare` which chains pairwise `&&`-joined comparisons for n>2.
//
// // ─────────────────────────────────────────────────────────────────────────────

// Rest is `readonly` so `(apply < xs)` etc. accept `List<number>` (see plus.d.ts).
declare function $less$(...n: readonly number[]): boolean;
declare function $greater$(...n: readonly number[]): boolean;
declare function $less$$eq$(...n: readonly number[]): boolean;
declare function $greater$$eq$(...n: readonly number[]): boolean;
declare function $eq$(...n: readonly number[]): boolean;
