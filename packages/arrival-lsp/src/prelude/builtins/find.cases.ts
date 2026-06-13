// Bite cases for the `find` leaf. `good` snippets must type-check clean;
// `bad` snippets must each produce a diagnostic. Referenced via PRE's `__arr`.
export const cases: { good: string[]; bad: string[] } = {
  good: [
    // predicate over a number-list yields the element type, widened with undefined
    "const x: SNum | undefined = __arr.find((n: SNum) => n > 0, [1, 2, 3]);",
    // predicate over a string-list
    '__arr.find((s: SStr) => s.length > 0, ["a", "b"]);',
  ],
  bad: [
    // predicate param type mismatches the list element type (string pred, number list)
    "__arr.find((s: SStr) => s.length > 0, [1, 2, 3]);",
    // result may be undefined → not assignable to a bare SNum
    "const n: SNum = __arr.find((n: SNum) => n > 0, [1, 2, 3]);",
    // second arg is not a list
    "__arr.find((n: SNum) => n > 0, 5);",
  ],
};
