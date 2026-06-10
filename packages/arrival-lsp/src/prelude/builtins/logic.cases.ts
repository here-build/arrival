// ─────────────────────────────────────────────────────────────────────────────
// Cases for `and`, `or` — good snippets must type-check clean; bad must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // predicate chains stay boolean-compatible
    "const b: SBool = __arr.and(__arr['odd?'](3), __arr.not(false));",
    "const c: SBool = __arr.or(__arr['zero?'](0), __arr['even?'](2));",
    // value-flavored uses are legal (scheme and/or return operands)
    "__arr.and(1, 'x');",
    "__arr.or();",
  ],
  bad: [
    // the result is operands-or-boolean — never silently a precise string
    "const s: SStr = __arr.and(1, 2);",
    // nor a precise number
    "const n: SNum = __arr.or(false, 'x');",
  ],
};
