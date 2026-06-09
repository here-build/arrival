// ─────────────────────────────────────────────────────────────────────────────
// Cases for `zero?`, `even?`, `odd?`, `null?`, `empty?`, `not`, `equal?`, `eq?`
// — good snippets must type-check clean; bad snippets must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // numeric predicates accept SNum and return SBool
    "__arr['zero?'](0)",
    "__arr['even?'](4)",
    "__arr['odd?'](3)",
    // list predicates accept List<unknown>
    "__arr['null?']([])",
    "__arr['empty?']([])",
    // not accepts any value
    "__arr.not(false)",
    // equal? and eq? accept any two values
    "__arr['equal?'](1, 1)",
    "__arr['eq?']('a', 'a')",
  ],
  bad: [
    // zero? requires SNum, not a string
    "__arr['zero?']('hello')",
    // null? requires List<unknown>, not a number
    "__arr['null?'](42)",
    // even? requires SNum, not a boolean
    "__arr['even?'](true)",
  ],
} satisfies { good: string[]; bad: string[] };
