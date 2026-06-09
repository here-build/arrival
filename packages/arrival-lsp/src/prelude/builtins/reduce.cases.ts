// Bite cases for the `reduce` leaf. `good` snippets must type-check clean;
// `bad` snippets must each produce a diagnostic. Referenced via PRE's `__arr`.
export const cases = {
  good: [
    // Sum a list of numbers into a number: acc/element/init/result all SNum.
    "const total: number = __arr.reduce((acc: number, x: number) => acc + x, 0, [1, 2, 3]);",
    // Heterogeneous fold: list of strings → number accumulator (A ≠ B).
    "const len: number = __arr.reduce((acc: number, s: string) => acc + s.length, 0, ['a', 'bb']);",
  ],
  bad: [
    // init type (string) disagrees with the reducer's accumulator/return (number).
    "__arr.reduce((acc: number, x: number) => acc + x, 'seed', [1, 2, 3]);",
    // reducer element param typed string but the list is List<number>.
    "__arr.reduce((acc: number, x: string) => acc + x.length, 0, [1, 2, 3]);",
  ],
} as const;
