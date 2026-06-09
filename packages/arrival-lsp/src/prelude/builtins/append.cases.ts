// ─────────────────────────────────────────────────────────────────────────────
// Cases for `append` — good snippets must type-check clean; bad snippets must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // append two number lists → List<SNum>
    "const r: List<SNum> = __arr.append([1, 2], [3, 4])",
    // append a single string list → List<SStr>
    "__arr.append(['a', 'b', 'c'])",
    // append three lists of the same element type
    "__arr.append([1], [2], [3])",
  ],
  bad: [
    // mixing element types: List<SNum> and List<SStr> → T cannot unify
    "__arr.append([1, 2], ['a', 'b'])",
    // a bare number is not a List
    "__arr.append(42)",
    // a string is not a List
    "__arr.append('hello', 'world')",
  ],
} satisfies { good: string[]; bad: string[] };
