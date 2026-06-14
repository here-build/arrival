// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `string-append`, `string-length`, `string-upcase`,
// `string-downcase`, `string-contains` (string-ops.d.ts). expect-type assertions
// over the ambient `__arr`; inputs are WIDENED string literals so the results are
// exact brands — positives pin with `.toEqualTypeOf<T>()` (an arg-rot OR a
// return→any rot both bite). Negatives use `// @ts-expect-error`: a non-SStr arg
// bites at the call (2345); if the signature rots to `any` the line stops erroring
// and the unused directive becomes the failure.
// Base vocab (`SStr`/`SNum`/`SBool`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// string-append of multiple SStr values returns SStr
expectTypeOf(__arr["string-append"]("hello", " ", "world")).toEqualTypeOf<SStr>();
// string-length of a SStr returns SNum
expectTypeOf(__arr["string-length"]("hello")).toEqualTypeOf<SNum>();
// string-upcase returns SStr
expectTypeOf(__arr["string-upcase"]("hello")).toEqualTypeOf<SStr>();
// string-downcase returns SStr
expectTypeOf(__arr["string-downcase"]("HELLO")).toEqualTypeOf<SStr>();
// string-contains returns SBool
expectTypeOf(__arr["string-contains"]("hello world", "world")).toEqualTypeOf<SBool>();

// @ts-expect-error string-append requires SStr args, not SNum
__arr["string-append"](42, "world");
// @ts-expect-error string-length requires SStr, not a number
__arr["string-length"](42);
// @ts-expect-error string-contains requires two SStr args, not a number as second arg
__arr["string-contains"]("hello", 42);
