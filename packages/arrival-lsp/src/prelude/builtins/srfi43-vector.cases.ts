// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for SRFI-43 vectors (srfi43-vector.d.ts) — expect-type assertions
// over the ambient `__arr`. v1 MODELS A VECTOR AS `List<T>` (the documented coarse
// choice — no distinct boxed `Vector<T>` brand). Inputs are WIDENED literals so
// element type resolves to a brand; fold/any/etc. thread T into the kons/pred
// callbacks exactly like the list family → positives pin with `.toEqualTypeOf<T>()`.
//
// ★ Leaf caveats (carried, do not "fix"):
//   • Search/index ops (vector-index/-binary-search) return `SNum | SBool` — a real
//     index OR the #f miss sentinel; downstream must account for the false case.
//   • vector-any/-every return the truthy callback result `R` unioned with SBool
//     (the #f sentinel); vector-every's R=SBool collapses the union to SBool.
//   • vector-fold's accumulator type A threads via (acc, elt)=>acc' independent of T.
// Base vocab (`List`/`SNum`/`SStr`/`SBool`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// vector constructor → List<T>
expectTypeOf(__arr.vector(1, 2, 3)).toEqualTypeOf<List<SNum>>();
// vector? returns SBool
expectTypeOf(__arr["vector?"](__arr.vector(1, 2, 3))).toEqualTypeOf<SBool>();
// vector-fold threads the accumulator type through kons
expectTypeOf(__arr["vector-fold"]((acc: SNum, elt: SNum): SNum => acc + elt, 0, [1, 2, 3])).toEqualTypeOf<SNum>();
// fold can change the accumulator type relative to elements
expectTypeOf(
  __arr["vector-fold-right"]((acc: SStr, elt: SNum): SStr => acc + elt, "", [1, 2, 3]),
).toEqualTypeOf<SStr>();
// vector-count → SNum
expectTypeOf(__arr["vector-count"]((elt: SNum) => elt > 1, [1, 2, 3])).toEqualTypeOf<SNum>();
// vector-index → SNum | SBool
expectTypeOf(__arr["vector-index"]((elt: SNum) => elt === 2, [1, 2, 3])).toEqualTypeOf<SNum | SBool>();
// vector-any returns the callback result type | SBool
expectTypeOf(__arr["vector-any"]((elt: SNum): SStr => `${elt}`, [1, 2, 3])).toEqualTypeOf<SStr | SBool>();
// vector-every likewise (R=SBool collapses the union to SBool)
expectTypeOf(__arr["vector-every"]((elt: SNum): SBool => elt > 0, [1, 2, 3])).toEqualTypeOf<SBool>();
// vector-empty? → SBool
expectTypeOf(__arr["vector-empty?"]([1, 2, 3])).toEqualTypeOf<SBool>();
// binary-search with a comparator callback → SNum | SBool
expectTypeOf(
  __arr["vector-binary-search"]([1, 2, 3], 2, (elt: SNum, value: SNum): SNum => elt - value),
).toEqualTypeOf<SNum | SBool>();

// @ts-expect-error vector elements are homogeneous T: a mixed call can't be List<SNum>
const w: List<SNum> = __arr.vector(1, "two", 3);
// @ts-expect-error vector-fold kons param must match element type (SStr elt over SNum vec)
__arr["vector-fold"]((acc: SNum, elt: SStr): SNum => acc, 0, [1, 2, 3]);
// @ts-expect-error fold accumulator type must be consistent: knil SNum vs kons returning SStr mismatch
const wr: SNum = __arr["vector-fold"]((acc: SNum, elt: SNum): SStr => `${acc}`, 0, [1, 2, 3]);
// @ts-expect-error vector-count pred must consume the element type (SStr param over SNum vec)
__arr["vector-count"]((elt: SStr) => true, [1, 2, 3]);
// @ts-expect-error binary-search value must match the vector element type
__arr["vector-binary-search"]([1, 2, 3], "two", (elt: SNum, value: SNum): SNum => 0);
