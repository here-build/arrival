// ─────────────────────────────────────────────────────────────────────────────
// L<intdiv> — `modulo` / `remainder` / `quotient` — integer division family.
//
// Scheme semantics:
//   (modulo   a b) → a mod b (floor-based sign; same as JS % for same-sign)
//   (remainder a b) → a remainder b (truncate-based; same as JS %)
//   (quotient  a b) → truncated integer quotient (Math.trunc(a/b))
// All three take exactly 2 numeric arguments and return a number.
//
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  modulo(a: SNum, b: SNum): SNum;
  remainder(a: SNum, b: SNum): SNum;
  quotient(a: SNum, b: SNum): SNum;
}
