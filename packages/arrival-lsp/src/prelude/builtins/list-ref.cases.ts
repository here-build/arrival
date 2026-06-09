// ─────────────────────────────────────────────────────────────────────────────
// Cases for `list-ref` — good snippets must type-check clean; bad must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // list-ref on a number list returns SNum
    "__arr['list-ref']([1, 2, 3], 0)",
    // list-ref on a string list returns SStr
    "__arr['list-ref'](['a', 'b', 'c'], 2)",
  ],
  bad: [
    // first arg must be List<T>, not a bare number
    "__arr['list-ref'](42, 0)",
    // second arg must be SNum, not a string
    "__arr['list-ref']([1, 2, 3], 'first')",
  ],
} satisfies { good: string[]; bad: string[] };
