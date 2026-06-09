// Good/bad TS snippets for the `sort` builtin signature.
// good = should type-check clean; bad = should error under --strict.
export const cases: { good: string[]; bad: string[] } = {
  good: [
    // sort without a comparator
    "__arr.sort([3, 1, 2])",
    // sort with a numeric comparator; result element type preserved (SNum)
    "const n: number = __arr.sort([3, 1, 2], (a, b) => a - b)[0]",
    // comparator over string elements
    '__arr.sort(["b", "a"], (a, b) => (a < b ? -1 : 1))',
  ],
  bad: [
    // comparator must RETURN a number, not a string
    '__arr.sort([1, 2], (a, b) => "nope")',
    // comparator params are T (number here): cannot call string method on them
    "__arr.sort([1, 2], (a, b) => a.toUpperCase())",
    // result is List<number>; assigning an element to a string is wrong
    "const s: string = __arr.sort([3, 1, 2])[0]",
  ],
};
