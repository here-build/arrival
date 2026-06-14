// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the conversions-ext coercion-resilience family
// (conversions-ext.d.ts): to-int, to-number, to-lower, to-upper, ensure-array,
// ensure-string, trim. expect-type assertions over the ambient `__arr`; inputs are
// widened literals so the results are exact brands — positives pin with
// `.toEqualTypeOf<T>()`. Negatives use `// @ts-expect-error`: a wrong arg type
// bites at the call, a wrong-typed result at the assignment.
//
// PRECISION NOTES (preserved from the leaf): to-int/to-number TOTALIZE (any input
// → SNum, 0 on failure — input is deliberately `unknown`); ensure-array<T> threads
// the element type (an SStr singleton → List<SStr>; an existing list round-trips its
// element type via overload); to-lower/to-upper/trim are SStr→SStr.
// Base vocab (`List`/`SNum`/`SStr`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// to-int / to-number totalize any input → SNum
expectTypeOf(__arr["to-int"]("42")).toEqualTypeOf<SNum>();
expectTypeOf(__arr["to-number"](true)).toEqualTypeOf<SNum>();
// string-preserving coercions
expectTypeOf(__arr["to-lower"]("HELLO")).toEqualTypeOf<SStr>();
expectTypeOf(__arr["to-upper"]("hello")).toEqualTypeOf<SStr>();
expectTypeOf(__arr["trim"]("  x  ")).toEqualTypeOf<SStr>();
// ensure-array threads element type from a singleton
expectTypeOf(__arr["ensure-array"]("x")).toEqualTypeOf<List<SStr>>();
// ensure-array on a list returns the same element type
expectTypeOf(__arr["ensure-array"]([1, 2, 3] as const as List<SNum>)).toEqualTypeOf<List<SNum>>();
// ensure-string totalizes anything → SStr
expectTypeOf(__arr["ensure-string"](42)).toEqualTypeOf<SStr>();

// @ts-expect-error to-lower wants a string, not a number
__arr["to-lower"](42);
// @ts-expect-error to-upper wants a string
__arr["to-upper"](42);
// @ts-expect-error trim wants a string
__arr["trim"](42);
// @ts-expect-error to-int returns SNum, not SStr — assigning to SStr must bite
const x: SStr = __arr["to-int"]("42");
// @ts-expect-error ensure-array of an SStr is List<SStr>, not SStr
const y: SStr = __arr["ensure-array"]("x");
