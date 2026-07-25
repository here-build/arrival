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
// // ─────────────────────────────────────────────────────────────────────────────

declare function string$dash$append(...s: string[]): string;
declare function string$dash$length(s: string): number;
declare function string$dash$upcase(s: string): string;
declare function string$dash$downcase(s: string): string;
declare function string$dash$contains(s: string, sub: string): boolean;
