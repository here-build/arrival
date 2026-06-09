// ─────────────────────────────────────────────────────────────────────────────
// Cases for `length` — good snippets must type-check clean; bad snippets must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // length of a number list returns SNum
    "__arr.length([1, 2, 3])",
    // length of a string list
    "__arr.length(['a', 'b'])",
    // length of an empty list
    "__arr.length([])",
  ],
  bad: [
    // length requires a List<unknown>, not a bare number
    "__arr.length(42)",
    // length requires a List<unknown>, not a string
    "__arr.length('hello')",
  ],
} satisfies { good: string[]; bad: string[] };
