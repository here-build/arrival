// ─────────────────────────────────────────────────────────────────────────────
// `string-append`, `string-length`, `string-upcase`,
//                 `string-downcase`, `string-contains`
//
// Scheme semantics:
//   (string-append s ...) → concatenation of all `s` args into one string.
//   (string-length s)     → the number of characters in `s`.
//   (string-upcase s)     → `s` converted to uppercase.
//   (string-downcase s)   → `s` converted to lowercase.
//   (string-contains s sub) → #t/#f whether `sub` appears in `s`.
//
// merge contract: ../types.d.ts THE LEAF MERGE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "string-append"(...s: string[]): string;
  "string-length"(s: string): number;
  "string-upcase"(s: string): string;
  "string-downcase"(s: string): string;
  "string-contains"(s: string, sub: string): boolean;
}
