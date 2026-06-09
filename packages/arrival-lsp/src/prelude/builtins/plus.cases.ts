// ─────────────────────────────────────────────────────────────────────────────
// Cases for `+` — good snippets must type-check clean; bad snippets must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // nullary: (+ ) → 0
    "__arr['+']()",
    // binary addition
    "__arr['+'](1, 2)",
    // variadic
    "__arr['+'](1, 2, 3, 4)",
  ],
  bad: [
    // string argument is not SNum
    "__arr['+']('a', 1)",
    // boolean argument is not SNum
    "__arr['+'](true, 2)",
  ],
} satisfies { good: string[]; bad: string[] };
