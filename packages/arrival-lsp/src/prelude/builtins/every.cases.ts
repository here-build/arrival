// Type-lens bite cases for the `every` builtin.
// good = type-checks clean; bad = must error under `tsc --strict`.
export const cases: { good: string[]; bad: string[] } = {
  good: [
    "const b: SBool = __arr.every((x: SNum) => x > 0, [1, 2, 3])",
    "__arr.every((s: SStr) => s.length > 0, ['a', 'b'])",
  ],
  bad: [
    // predicate element type (SStr) mismatches the list element type (SNum)
    "__arr.every((s: SStr) => s.length > 0, [1, 2, 3])",
    // result is SBool, not assignable to SNum
    "const n: SNum = __arr.every((x: SNum) => x > 0, [1, 2, 3])",
  ],
};
