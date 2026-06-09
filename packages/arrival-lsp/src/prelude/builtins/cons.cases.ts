// Cases for `cons`: good = should type-check clean; bad = should error.
export const cases = {
  good: [
    // cons a number onto a number list — result is List<number>
    "__arr.cons(1, [2, 3])",
    // cons a string onto an empty list — widened to List<string>
    '__arr.cons("hello", [])',
  ],
  bad: [
    // tail must be a List, not a bare number
    "__arr.cons(1, 2)",
    // tail must be a List, not a string
    '__arr.cons(1, "notalist")',
  ],
};
