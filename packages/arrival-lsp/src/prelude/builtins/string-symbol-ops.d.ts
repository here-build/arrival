// ─────────────────────────────────────────────────────────────────────────────
// L<string-symbol-ops> — symbol↔string + string-indexing / regex string family:
//   `symbol->string`, `string->symbol`, `string-ref`, `substring`, `split`,
//   `join`, `replace`, `search`, `match`, `escape-regex`.
//
// Scheme semantics (R7RS + LIPS extensions):
//   (symbol->string sym)        → the symbol's name as a string
//   (string->symbol s)          → the interned symbol named s
//   (string-ref s i)            → the character at index i (a 1-char string;
//                                  nil when out of range)
//   (substring s start [end])   → the substring [start, end) of s
//   (split sep s)               → list of pieces of s split on sep (sep FIRST)
//   (join sep list)             → the list's string elements joined by sep
//   (replace pat repl s)        → s with pat replaced by repl
//   (search pat s)              → the index of the first match of pat in s, or -1
//   (match pat s)               → list of match groups, or #f when no match
//   (escape-regex s)            → s with regex metacharacters escaped
//
// Runtime truth (the `any` impls these SHARPEN — do NOT import them):
//   inference-env.ts:308-320  inline `symbol->string` / `string->symbol`
//                           (inline binding — highest precedence)
//   inference-env.ts:342      inline `string-ref` = (s,i) => s[i] ?? nil
//   inference-env.ts:338-339  inline `join` = (sep,list) => String(lipsJoin(...))
//   lips.js:3183 substring · 3204 split · 3215 replace · 3225 match
//   lips.js:3232 search    · 3236 repr  · 3239 escape-regex
//                           (LIPS builtins via SAFE_BUILTINS — substring/split/
//                            replace/match/search are in SAFE_BUILTINS, spread
//                            AFTER RAMDA in inference-env.ts:188-189, so the LIPS
//                            impl WINS over any ramda-functions.ts alias.)
//
// ★ Precedence corrections that change the signatures:
//   • `search` is NOT ramda-functions.ts:193 `R.find`. SAFE_BUILTINS' LIPS
//     `search` (string `.search` → an index) overrides it → returns SNum.
//   • `split`/`replace`/`match` take (sep|pat) FIRST then the string — LIPS arg
//     order — and `split`/`match` return Scheme LISTS (`array->list`), not arrays.
//   • `match` honestly returns `List<SStr> | SBool`: LIPS returns #f on no match,
//     so a downstream list use SHOULD bite — a latent bug, not lens noise (same
//     shape as `string->number`'s `SNum | SBool`).
//
// `string-ref` returns `SStr | Nil`: LIPS yields `nil` on an out-of-range index
// (inference-env.ts:342 `?? nil`), so the absence must be accounted for downstream.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "symbol->string"(sym: unknown): SStr;
  "string->symbol"(s: SStr): unknown;
  "string-ref"(s: SStr, i: SNum): SStr | Nil;
  substring(s: SStr, start: SNum, end?: SNum): SStr;
  split(separator: SStr, s: SStr): List<SStr>;
  join(separator: SStr, list: List<unknown>): SStr;
  replace(pattern: SStr, replacement: SStr, s: SStr): SStr;
  search(pattern: SStr, s: SStr): SNum;
  match(pattern: SStr, s: SStr): List<SStr> | SBool;
  "escape-regex"(s: SStr): SStr;
}
