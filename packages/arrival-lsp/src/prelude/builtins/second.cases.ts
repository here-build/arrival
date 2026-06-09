// Cases for `second` — proves the signature bites under tsc.
// good: well-typed calls that must type-check clean.
// bad:  mis-typed calls that must produce a TS diagnostic.
export const cases = {
  good: [
    // second element of a number list → SNum
    "__arr.second([1, 2, 3])",
    // second element of a string list → SStr
    "__arr.second(['a', 'b', 'c'])",
  ],
  bad: [
    // non-list argument → should error (SNum is not List<T>)
    "__arr.second(42)",
  ],
};
