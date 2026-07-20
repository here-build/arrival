// ─────────────────────────────────────────────────────────────────────────────
// `and`, `or` — variadic logic family.
//
// Scheme semantics:
//   (and a b …) → the first #f-ish value, else the LAST value; (and) → #t
//   (or a b …)  → the first non-#f value, else the last;       (or)  → #f
//
// Signature note: scheme truthiness is #f-ONLY (0/""/nil are truthy), so the JS
// `&&`/`||` result-type algebra would be subtly WRONG here. The honest v1 type
// is "one of the operands, or a boolean" — `T[number] | boolean` — which keeps
// predicate chains (`(and (not (p? x)) (q? x))`) precisely boolean-compatible and
// never produces a false bite on value-flavored uses. Empty calls degenerate to
// plain boolean (T[number] of [] is never).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  and<T extends readonly unknown[]>(...xs: T): T[number] | boolean;
  or<T extends readonly unknown[]>(...xs: T): T[number] | boolean;
}
