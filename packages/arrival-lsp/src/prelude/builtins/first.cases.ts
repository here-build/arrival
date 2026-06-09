// Cases for `first` — proves the signature bites under tsc.
// good: well-typed calls that must type-check clean.
// bad:  mis-typed calls that must produce a TS diagnostic.
export const cases = {
  good: [
    // first element of a number list → SNum
    "__arr.first([1, 2, 3])",
    // first element of a string list → SStr
    "__arr.first(['a', 'b'])",
  ],
  bad: [
    // non-list argument → should error (SNum is not List<T>)
    "__arr.first(42)",
  ],
};
