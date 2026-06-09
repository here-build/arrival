// Bite-proof snippets for the `apply` leaf. `good` must type-check clean against
// PRE + apply.d.ts; `bad` must produce a diagnostic. Referenced via `__arr`.
export const cases: { good: string[]; bad: string[] } = {
  good: [
    // args tuple matches the callee's parameter types → returns SNum
    "const n: SNum = __arr.apply((a: SNum, b: SNum) => a + b, [1, 2] as const)",
    "const s: SStr = __arr.apply((x: SStr) => x, ['hi'] as const)",
  ],
  bad: [
    // second arg is a string but the callee's 2nd param is SNum → TS2345
    "__arr.apply((a: SNum, b: SNum) => a + b, [1, 'x'] as const)",
    // first arg is not a function → TS2345
    "__arr.apply(5, [1, 2] as const)",
  ],
};
