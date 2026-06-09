// ─────────────────────────────────────────────────────────────────────────────
// Cases for `abs`, `sqrt`, `floor`, `round`, `min`, `max` — good snippets must
// type-check clean; bad snippets must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // abs of a number returns SNum
    "__arr.abs(-5)",
    // sqrt of a number returns SNum
    "__arr.sqrt(9)",
    // floor of a number returns SNum
    "__arr.floor(3.7)",
    // round of a number returns SNum
    "__arr.round(2.5)",
    // min/max are variadic — one or more SNum args
    "__arr.min(1, 2, 3)",
    "__arr.max(4, 5, 6)",
  ],
  bad: [
    // abs requires SNum, not a string
    "__arr.abs('hello')",
    // min requires SNum args, not strings
    "__arr.min('a', 'b')",
    // sqrt requires SNum, not boolean
    "__arr.sqrt(true)",
  ],
} satisfies { good: string[]; bad: string[] };
