// ─────────────────────────────────────────────────────────────────────────────
// L<conversions-ext> — coercion-resilience family:
//   `to-int`, `to-number`, `to-lower`, `to-upper`, `ensure-array`,
//   `ensure-string`, `trim`.
//
// Scheme semantics (the "totalic environment" coercions — never throw, always
// land on a value of the target type):
//   (to-int x)        → integer parse of x, or 0 on failure
//   (to-number x)     → numeric coercion of x, or 0 on failure / NaN
//   (to-lower s)      → s lowercased
//   (to-upper s)      → s uppercased
//   (ensure-array x)  → x if already a list, else a 1-element list wrapping x
//   (ensure-string x) → String(x), with null/undefined → ""
//   (trim s)          → s with leading/trailing whitespace removed
//
// Runtime truth (the `any` impls this SHARPENS — do NOT import them):
//   ramda-functions.ts:141  "to-int"      = (x) => parseInt(String(x),10) || 0
//   ramda-functions.ts:140  "to-number"   = (x) => Number(x) || 0
//   ramda-functions.ts:300  "to-lower"    = R.toLower
//   ramda-functions.ts:301  "to-upper"    = R.toUpper
//   ramda-functions.ts:138  "ensure-array"= (x) => Array.isArray(x) ? x : [x]
//   ramda-functions.ts:139  "ensure-string"=(x) => String(x || "")
//   ramda-functions.ts:302  "trim"        = R.trim
// (RAMDA layer, lowest precedence — none of these are shadowed by an inline /
//  safeWrappedOps / SAFE_BUILTINS binding, so the RAMDA impl is what runs.)
//
// Precision notes that earn the granularity:
//   • to-int / to-number TOTALIZE: any input → SNum (0 on failure). The input is
//     deliberately `unknown` — these exist precisely to absorb non-numeric input,
//     so constraining the param would lie about their purpose. The RETURN is the
//     sharp end: it threads SNum forward so a downstream `(string-upcase (to-int x))`
//     still bites.
//   • ensure-array<T> threads the element type: `(ensure-array x)` over an `SStr`
//     yields `List<SStr>`, so a later `(car …)` is precisely typed. An already-list
//     input is returned as-is (overload), preserving its element type.
//   • to-lower/to-upper/trim are SStr→SStr (string-preserving), matching
//     to-upper(s: SStr): SStr in the conversions reference leaf.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "to-int"(x: unknown): SNum;
  "to-number"(x: unknown): SNum;
  "to-lower"(s: SStr): SStr;
  "to-upper"(s: SStr): SStr;
  // Overload: a list input round-trips with its element type; anything else is
  // wrapped into a singleton list of that value's type.
  "ensure-array"<T>(x: List<T>): List<T>;
  "ensure-array"<T>(x: T): List<T>;
  "ensure-string"(x: unknown): SStr;
  trim(s: SStr): SStr;
}
