// ─────────────────────────────────────────────────────────────────────────────
// L<xx> — `every` — universal quantifier over a list.
//
// Scheme semantics: (every pred xs) → #t iff `pred` holds for ALL elements of
// `xs` (predicate FIRST, list SECOND). Lowers to `xs.every(pred)`.
// Runtime truth (the `any` impl this SHARPENS — do NOT import it):
//   stdlib.ts:145 (mapLike) · stdlib.ts:203 (every: mapLike("every"))
//
// Precise where Scheme is polymorphic: the predicate's parameter type is bound to
// the list's element type `T`, so passing a predicate that expects the wrong
// element type bites. Return is `SBool`.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  every<T>(pred: (x: T) => SBool, xs: List<T>): SBool;
}
