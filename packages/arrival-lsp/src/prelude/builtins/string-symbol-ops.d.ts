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
//   Inline (highest precedence): `string-ref` = (s,i) => s[i] ?? nil ·
//   `join` = (sep,list) => String(lipsJoin(...)).
//   LIPS builtins via SAFE_BUILTINS: substring / split / replace / match / search /
//   repr / escape-regex — these LIPS impls WIN over any former Ramda alias.
//
// ★ Precedence corrections that change the signatures:
//   • `search` is NOT a Ramda `find`. SAFE_BUILTINS' LIPS
//     `search` (string `.search` → an index) overrides it → returns SNum.
//   • `split`/`replace`/`match` take (sep|pat) FIRST then the string — LIPS arg
//     order — and `split`/`match` return Scheme LISTS (`array->list`), not arrays.
//   • `match` honestly returns `List<SStr> | SBool`: LIPS returns #f on no match,
//     so a downstream list use SHOULD bite — a latent bug, not lens noise (same
//     shape as `string->number`'s `SNum | SBool`).
//
// `string-ref` returns `SStr | Nil`: LIPS yields `nil` on an out-of-range index,
// so the absence must be accounted for downstream.
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
