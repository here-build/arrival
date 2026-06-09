// ─────────────────────────────────────────────────────────────────────────────
// Cases for `"-"` — good snippets must type-check clean; bad snippets must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // unary negation: (- 5) → -5
    '__arr["-"](5)',
    // binary subtraction: (- 10 3) → 7
    '__arr["-"](10, 3)',
    // variadic: (- 100 10 5) → 85
    '__arr["-"](100, 10, 5)',
  ],
  bad: [
    // "-" requires at least one SNum argument — no args is disallowed
    '__arr["-"]()',
    // "-" does not accept strings
    '__arr["-"]("a", 1)',
  ],
} satisfies { good: string[]; bad: string[] };
