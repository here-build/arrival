// Cases for the `max-by` builtin signature. `__arr` is PRE's merged accessor.
// good: should type-check clean. bad: should error (the bite).
export const cases: { good: string[]; bad: string[] } = {
  good: [
    // key returns a number, list of numbers, result is an element (number)
    '__arr["max-by"]((x: number) => x, [3, 1, 2])',
    // result element type flows through: the returned T is the element type
    'const w: SNum = __arr["max-by"]((p: { weight: SNum }) => p.weight, [{ weight: 1 }, { weight: 2 }]).weight',
  ],
  bad: [
    // key returns a string, not a SNum → bites (key must yield a number)
    '__arr["max-by"]((s: string) => s, ["a", "b"])',
    // result is an element T, NOT the numeric key — assigning to SStr bites
    'const s: SStr = __arr["max-by"]((x: number) => x, [1, 2, 3])',
  ],
};
