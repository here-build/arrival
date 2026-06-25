// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for SRFI-43 vectors (srfi43-vector.d.ts) — expect-type assertions
// over the ambient `__arr`. v1 MODELS A VECTOR AS `List<T>` (the documented coarse
// choice — no distinct boxed `Vector<T>` brand). Inputs are WIDENED literals so
// element type resolves to a brand; fold/any/etc. thread T into the kons/pred
// callbacks exactly like the list family → positives pin with `.toEqualTypeOf<T>()`.
//
// ★ Leaf caveats (carried, do not "fix"):
//   • Search/index ops (vector-index/-binary-search) return `number | boolean` — a real
//     index OR the #f miss sentinel; downstream must account for the false case.
//   • vector-any/-every return the truthy callback result `R` unioned with boolean
//     (the #f sentinel); vector-every's R=boolean collapses the union to boolean.
//   • vector-fold's accumulator type A threads via (acc, elt)=>acc' independent of T.
// Base vocab (`List`/`number`/`string`/`boolean`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// vector constructor → List<T>
expectTypeOf(__arr.vector(1, 2, 3)).toEqualTypeOf<List<number>>();
// vector? returns boolean
expectTypeOf(__arr["vector?"](__arr.vector(1, 2, 3))).toEqualTypeOf<boolean>();
// vector-fold threads the accumulator type through kons
expectTypeOf(__arr["vector-fold"]((acc: number, elt: number): number => acc + elt, 0, [1, 2, 3])).toEqualTypeOf<number>();
// fold can change the accumulator type relative to elements
expectTypeOf(
  __arr["vector-fold-right"]((acc: string, elt: number): string => acc + elt, "", [1, 2, 3]),
).toEqualTypeOf<string>();
// vector-count → number
expectTypeOf(__arr["vector-count"]((elt: number) => elt > 1, [1, 2, 3])).toEqualTypeOf<number>();
// vector-index → number | boolean
expectTypeOf(__arr["vector-index"]((elt: number) => elt === 2, [1, 2, 3])).toEqualTypeOf<number | boolean>();
// vector-any returns the callback result type | boolean
expectTypeOf(__arr["vector-any"]((elt: number): string => `${elt}`, [1, 2, 3])).toEqualTypeOf<string | boolean>();
// vector-every likewise (R=boolean collapses the union to boolean)
expectTypeOf(__arr["vector-every"]((elt: number): boolean => elt > 0, [1, 2, 3])).toEqualTypeOf<boolean>();
// vector-empty? → boolean
expectTypeOf(__arr["vector-empty?"]([1, 2, 3])).toEqualTypeOf<boolean>();
// binary-search with a comparator callback → number | boolean
expectTypeOf(
  __arr["vector-binary-search"]([1, 2, 3], 2, (elt: number, value: number): number => elt - value),
).toEqualTypeOf<number | boolean>();

// @ts-expect-error vector elements are homogeneous T: a mixed call can't be List<number>
const w: List<number> = __arr.vector(1, "two", 3);
// @ts-expect-error vector-fold kons param must match element type (string elt over number vec)
__arr["vector-fold"]((acc: number, elt: string): number => acc, 0, [1, 2, 3]);
// @ts-expect-error fold accumulator type must be consistent: knil number vs kons returning string mismatch
const wr: number = __arr["vector-fold"]((acc: number, elt: number): string => `${acc}`, 0, [1, 2, 3]);
// @ts-expect-error vector-count pred must consume the element type (string param over number vec)
__arr["vector-count"]((elt: string) => true, [1, 2, 3]);
// @ts-expect-error binary-search value must match the vector element type
__arr["vector-binary-search"]([1, 2, 3], "two", (elt: number, value: number): number => 0);
