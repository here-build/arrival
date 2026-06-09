// Bite cases for the `filter` builtin signature. `good` snippets must type-check
// clean against PRE + filter.d.ts; `bad` snippets must each produce a diagnostic.
export const cases: { good: string[]; bad: string[] } = {
  good: [
    // predicate over numbers, list of numbers → list of numbers
    "const r: List<SNum> = __arr.filter((x: SNum) => x > 0, [1, 2, 3])",
    // predicate over strings, list of strings
    "__arr.filter((s: SStr) => s.length > 0, ['a', 'b'])",
  ],
  bad: [
    // predicate's parameter type disagrees with the list element type
    "__arr.filter((s: SStr) => s.length > 0, [1, 2, 3])",
    // second argument is not a list
    "__arr.filter((x: SNum) => x > 0, 5)",
    // predicate must return SBool, not SNum
    "__arr.filter((x: SNum) => x, [1, 2, 3])",
  ],
};
