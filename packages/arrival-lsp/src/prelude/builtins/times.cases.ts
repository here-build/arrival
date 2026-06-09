// ─────────────────────────────────────────────────────────────────────────────
// Cases for `*` — good snippets must type-check clean; bad snippets must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // nullary: (* ) → 1
    "__arr['*']()",
    // binary multiplication
    "__arr['*'](3, 4)",
    // variadic
    "__arr['*'](2, 3, 4, 5)",
  ],
  bad: [
    // string argument is not SNum
    "__arr['*']('a', 2)",
    // boolean argument is not SNum
    "__arr['*'](true, 3)",
  ],
} satisfies { good: string[]; bad: string[] };
