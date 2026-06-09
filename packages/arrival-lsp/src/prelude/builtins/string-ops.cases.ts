// ─────────────────────────────────────────────────────────────────────────────
// Cases for `string-append`, `string-length`, `string-upcase`, `string-downcase`,
// `string-contains` — good snippets must type-check clean; bad snippets must error.
// These are TS source fragments referencing `__arr` (declared in ../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const cases = {
  good: [
    // string-append of multiple SStr values returns SStr
    '__arr["string-append"]("hello", " ", "world")',
    // string-length of a SStr returns SNum
    '__arr["string-length"]("hello")',
    // string-upcase returns SStr
    '__arr["string-upcase"]("hello")',
    // string-downcase returns SStr
    '__arr["string-downcase"]("HELLO")',
    // string-contains returns SBool
    '__arr["string-contains"]("hello world", "world")',
  ],
  bad: [
    // string-append requires SStr args, not SNum
    '__arr["string-append"](42, "world")',
    // string-length requires SStr, not a number
    '__arr["string-length"](42)',
    // string-contains requires two SStr args, not a number as second arg
    '__arr["string-contains"]("hello", 42)',
  ],
} satisfies { good: string[]; bad: string[] };
