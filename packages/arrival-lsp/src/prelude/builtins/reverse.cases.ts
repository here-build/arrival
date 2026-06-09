// ─────────────────────────────────────────────────────────────────────────────
// Cases for `reverse` — good snippets must type-check clean; bad snippets must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // reverse of a number list returns a number list
    "__arr.reverse([1, 2, 3])",
    // reverse of a string list
    "__arr.reverse(['a', 'b', 'c'])",
  ],
  bad: [
    // reverse requires a List<T>, not a bare number
    "__arr.reverse(42)",
    // reverse requires a List<T>, not a string
    "__arr.reverse('hello')",
  ],
} satisfies { good: string[]; bad: string[] };
