// ─────────────────────────────────────────────────────────────────────────────
// Cases for `cdr` — good snippets must type-check clean; bad snippets must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // cdr of a typed list returns the same element-type list
    "__arr.cdr([1, 2, 3])",
    // cdr of a string list
    "__arr.cdr(['a', 'b', 'c'])",
  ],
  bad: [
    // cdr requires a List<T>, not a bare number
    "__arr.cdr(5)",
    // cdr requires a List<T>, not a string
    "__arr.cdr('hello')",
  ],
} satisfies { good: string[]; bad: string[] };
