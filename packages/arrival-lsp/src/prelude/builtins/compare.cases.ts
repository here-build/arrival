// ─────────────────────────────────────────────────────────────────────────────
// Cases for `<`, `>`, `<=`, `>=`, `=` — good snippets must type-check clean;
// bad snippets must error. Referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // binary less-than
    "__arr['<'](1, 2)",
    // chained three-way comparison
    "__arr['<='](1, 2, 3)",
    // equality check
    "__arr['='](42, 42)",
  ],
  bad: [
    // string argument is not SNum
    "__arr['<']('a', 1)",
    // boolean argument is not SNum
    "__arr['>'](true, 2)",
    // string in equality check
    "__arr['=']('hello', 'world')",
  ],
} satisfies { good: string[]; bad: string[] };
