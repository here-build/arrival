// ─────────────────────────────────────────────────────────────────────────────
// Cases for `cadr` — second element (car of cdr) of a list.
//
// good: snippets that should type-check clean (0 diagnostics).
// bad:  snippets that should produce a TS error (e.g. passing a non-list).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // cadr of a number list → SNum, assigned to SNum (or left unbound — both clean)
    "__arr.cadr([10, 20, 30])",
    // cadr of a string list → SStr
    "const s: string = __arr.cadr(['a', 'b', 'c'])",
  ],
  bad: [
    // cadr of a plain number (not a List) → TS2345
    "__arr.cadr(42)",
    // result is SNum, not SStr → TS2322
    "const s: string = __arr.cadr([1, 2, 3])",
  ],
};
