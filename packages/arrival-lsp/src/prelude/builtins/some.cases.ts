// Bite cases for the `some` leaf. `good` snippets must type-check clean;
// `bad` snippets must each produce a diagnostic. Referenced via PRE's `__arr`.
export const cases: { good: string[]; bad: string[] } = {
  good: [
    // predicate over a number-list returns a boolean
    "const b: SBool = __arr.some((x: SNum) => x > 0, [1, 2, 3]);",
    // predicate over a string-list
    '__arr.some((s: SStr) => s.length > 0, ["a", "b"]);',
  ],
  bad: [
    // predicate param type mismatches the list element type (string pred, number list)
    "__arr.some((s: SStr) => s.length > 0, [1, 2, 3]);",
    // second arg is not a list
    "__arr.some((x: SNum) => x > 0, 5);",
    // result is a SBool, not assignable to SNum
    "const n: SNum = __arr.some((x: SNum) => x > 0, [1, 2, 3]);",
  ],
};
