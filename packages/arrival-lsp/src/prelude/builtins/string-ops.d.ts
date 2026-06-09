// ─────────────────────────────────────────────────────────────────────────────
// L<string-ops> — `string-append`, `string-length`, `string-upcase`,
//                 `string-downcase`, `string-contains`
//
// Scheme semantics:
//   (string-append s ...) → concatenation of all `s` args into one string.
//   (string-length s)     → the number of characters in `s`.
//   (string-upcase s)     → `s` converted to uppercase.
//   (string-downcase s)   → `s` converted to lowercase.
//   (string-contains s sub) → #t/#f whether `sub` appears in `s`.
//
// Runtime truth (the `any` impls this SHARPENS — do NOT import them):
//   sandbox-env.ts:330-341  (`string-length`, `string-upcase`, `string-downcase`,
//                             `string-append`, `string-contains`)
//   bridge.ts:959,1044,1105,1109  (`string-length`, `string-append`,
//                                   `string-upcase`, `string-downcase`)
//
// Pattern: re-declare `interface ArrShape` with these members, written purely
// in terms of PRE's base types (`SStr`, `SNum`, `SBool`). TS merges this into
// the shared `__arr` (see ../types.d.ts → THE LEAF MERGE CONTRACT).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "string-append"(...s: SStr[]): SStr;
  "string-length"(s: SStr): SNum;
  "string-upcase"(s: SStr): SStr;
  "string-downcase"(s: SStr): SStr;
  "string-contains"(s: SStr, sub: SStr): SBool;
}
