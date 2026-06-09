// ─────────────────────────────────────────────────────────────────────────────
// Cases for `"/"` — good snippets must type-check clean; bad snippets must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // unary reciprocal: (/ 4) → 0.25
    '__arr["/"](4)',
    // binary division: (/ 10 2) → 5
    '__arr["/"](10, 2)',
    // variadic: (/ 100 2 5) → 10
    '__arr["/"](100, 2, 5)',
  ],
  bad: [
    // "/" requires at least one SNum argument — no args is disallowed
    '__arr["/"]()',
    // "/" does not accept strings
    '__arr["/"]("a", 2)',
  ],
} satisfies { good: string[]; bad: string[] };
