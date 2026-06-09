// Bite cases for the `dict` leaf. `good` must type-check clean; `bad` must error.
// Snippets reference the builtin via PRE's `__arr` and `Dict`/base-type vocab.
export const cases: { good: string[]; bad: string[] } = {
  good: [
    // Precise inference: keyword entries → precise object shape.
    `const row: { name: SStr; age: SNum } = __arr.dict([["name", "alice"], ["age", 30]] as const)`,
    // Single-entry dict.
    `const r: { ok: SBool } = __arr.dict([["ok", true]] as const)`,
  ],
  bad: [
    // Wrong value type for a known key: age is SNum, not SStr.
    `const row: { name: SStr; age: SStr } = __arr.dict([["name", "alice"], ["age", 30]] as const)`,
    // Claiming a key the dict does not have bites (missing property).
    `const row: { name: SStr; age: SNum; extra: SBool } = __arr.dict([["name", "alice"], ["age", 30]] as const)`,
  ],
};
