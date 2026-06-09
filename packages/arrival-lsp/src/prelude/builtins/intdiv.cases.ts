// ─────────────────────────────────────────────────────────────────────────────
// Cases for `modulo` / `remainder` / `quotient` — integer division family.
// Good snippets must type-check clean; bad snippets must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // modulo: two numbers → number
    "__arr.modulo(10, 3)",
    // remainder: two numbers → number
    "__arr.remainder(10, 3)",
    // quotient: two numbers → number
    "__arr.quotient(10, 3)",
  ],
  bad: [
    // string argument is not SNum
    "__arr.modulo('10', 3)",
    // boolean argument is not SNum
    "__arr.quotient(true, 2)",
    // missing second argument (arity must be exactly 2)
    "__arr.remainder(10)",
  ],
} satisfies { good: string[]; bad: string[] };
