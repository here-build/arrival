// Cases for the `map` builtin signature. `good` snippets must type-check clean;
// `bad` snippets must each produce a diagnostic. Snippets reference the builtin
// via the ambient `__arr` (typed by the merged `ArrShape`).
export const cases: { good: string[]; bad: string[] } = {
  good: [
    // unary map: number list → number list via a number→number callback
    "const r: List<SNum> = __arr.map((n: SNum): SNum => n, [1, 2, 3])",
    // element type drives callback param + output element type
    "const s: List<SStr> = __arr.map((x: SNum): SStr => `${x}`, [1, 2, 3])",
  ],
  bad: [
    // callback param type mismatches the list element type (SStr param over SNum list)
    "__arr.map((x: SStr): SStr => x, [1, 2, 3])",
    // second arg is not a list
    "__arr.map((n: SNum): SNum => n, 5)",
  ],
};
