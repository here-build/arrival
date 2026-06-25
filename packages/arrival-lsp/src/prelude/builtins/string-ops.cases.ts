// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `string-append`, `string-length`, `string-upcase`,
// `string-downcase`, `string-contains` (string-ops.d.ts). expect-type assertions
// over the ambient `__arr`; inputs are WIDENED string literals so the results are
// exact brands — positives pin with `.toEqualTypeOf<T>()` (an arg-rot OR a
// return→any rot both bite). Negatives use `// @ts-expect-error`: a non-string arg
// bites at the call (2345); if the signature rots to `any` the line stops erroring
// and the unused directive becomes the failure.
// Base vocab (`string`/`number`/`boolean`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// string-append of multiple string values returns string
expectTypeOf(__arr["string-append"]("hello", " ", "world")).toEqualTypeOf<string>();
// string-length of a string returns number
expectTypeOf(__arr["string-length"]("hello")).toEqualTypeOf<number>();
// string-upcase returns string
expectTypeOf(__arr["string-upcase"]("hello")).toEqualTypeOf<string>();
// string-downcase returns string
expectTypeOf(__arr["string-downcase"]("HELLO")).toEqualTypeOf<string>();
// string-contains returns boolean
expectTypeOf(__arr["string-contains"]("hello world", "world")).toEqualTypeOf<boolean>();

// @ts-expect-error string-append requires string args, not number
__arr["string-append"](42, "world");
// @ts-expect-error string-length requires string, not a number
__arr["string-length"](42);
// @ts-expect-error string-contains requires two string args, not a number as second arg
__arr["string-contains"]("hello", 42);
