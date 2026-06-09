// Cases for `last` — proves the signature bites under tsc.
// good: well-typed calls that must type-check clean.
// bad:  mis-typed calls that must produce a TS diagnostic.
export const cases = {
  good: [
    // last element of a number list → SNum
    "__arr.last([1, 2, 3])",
    // last element of a string list → SStr
    "__arr.last(['a', 'b', 'c'])",
  ],
  bad: [
    // non-list argument (SNum) → should error
    "__arr.last(42)",
  ],
};
