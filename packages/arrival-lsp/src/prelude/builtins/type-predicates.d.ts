// ─────────────────────────────────────────────────────────────────────────────
// L<type-predicates> — runtime type-tag predicate family:
//   `boolean?`, `number?`, `string?`, `symbol?`, `pair?`, `list?`, `object?`,
//   `function?`, `array?`, `regex?`, `real?`.
//
// Scheme semantics: each `(<type>? obj)` returns #t iff obj is of that type.
//   (number? x)   → #t iff x is a number (raw, bigint, or boxed Scheme exact/inexact)
//   (string? x)   → #t iff x is a string (raw or SchemeString)
//   (boolean? x)  → #t iff x is a boolean (raw or SchemeBool)
//   (symbol? x)   → #t iff x is a SchemeSymbol
//   (pair? x)     → #t iff x is a cons pair
//   (list? x)     → #t iff x is a proper list
//   (array? x)    → #t iff x is a JS array
//   (object? x)   → #t iff x is a plain object (not pair/string/regex/char/number…)
//   (function? x) → #t iff x is callable
//   (regex? x)    → #t iff x is a RegExp
//   (real? x)     → #t iff x is a real number (finite, non-NaN)
//
// Runtime truth (the `any` impls these SHARPEN — do NOT import them):
//   safe_builtins.ts:75-84  (these names are pulled from lipsGlobalEnv via
//                            SAFE_BUILTINS — see sandbox-env.ts:189)
//   lips.js:3284 function? · 3286 real?  · 3296 number? · 3304 string?
//   lips.js:3308 pair?     · 3310 regex? · 3318 boolean? · 3324 symbol?
//   lips.js:3328 array?    · 3332 object? · (list?) is_list
//
// ★ Granularity via TS type-GUARDS (rule 4): where the guard TARGET is expressible
// in PRE vocab, these narrow `unknown` so a guarded branch types precisely:
//   string?  → x is SStr        number? → x is SNum      boolean? → x is SBool
//   array?   → x is List<unknown> (Array.isArray)
//   pair?    → x is Pair<unknown> (the dotted-pair brand)
//   list?    → x is List<unknown> (proper list)
// The rest (`symbol?`, `function?`, `object?`, `regex?`) have no clean PRE brand
// for their target — PRE has no Symbol/Function/RegExp/plain-object alias — so
// they stay plain `(v: unknown): SBool`. `real?` is number-ISH but not exactly
// SNum (it rejects NaN / non-reals), so narrowing to `x is SNum` would over-claim;
// kept plain `SBool`.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "string?"(v: unknown): v is SStr;
  "number?"(v: unknown): v is SNum;
  "boolean?"(v: unknown): v is SBool;
  "array?"(v: unknown): v is List<unknown>;
  "list?"(v: unknown): v is List<unknown>;
  "pair?"(v: unknown): v is Pair<unknown>;
  "symbol?"(v: unknown): SBool;
  "function?"(v: unknown): SBool;
  "object?"(v: unknown): SBool;
  "regex?"(v: unknown): SBool;
  "real?"(v: unknown): SBool;
}
