// ─────────────────────────────────────────────────────────────────────────────
// Cases for `number->string`, `string->number` — good must check clean; bad must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    "const s: SStr = __arr['number->string'](42);",
    "const h: SStr = __arr['number->string'](255, 16);",
    "__arr['string->number']('3.14');",
  ],
  bad: [
    // number->string wants a number
    "__arr['number->string']('x');",
    // string->number may return #f — not silently a precise SNum
    "const n: SNum = __arr['string->number']('3');",
  ],
};
