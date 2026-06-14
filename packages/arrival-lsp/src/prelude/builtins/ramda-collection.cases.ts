// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the RAMDA COLLECTION family (ramda-collection.d.ts) — the
// list/grouping transforms that thread the element type from input to output.
// expect-type assertions over the ambient `__arr`; inputs are WIDENED list literals
// (`[1,2,3]` → number[]) and callbacks carry explicit element-typed params, so the
// results are exact brands — positives pin with `.toEqualTypeOf<T>()` (an arg-rot
// OR a return→any rot both bite). Negatives use `// @ts-expect-error`: a
// callback↔element mismatch or wrong-returning callback bites at the call (2345),
// a wrong-typed threaded result at the assignment (2322).
//
// FAITHFULNESS NOTES (preserved from the leaf): remove/exclude are R.reject
// (inverse filter, DROP matches); select/keep are R.filter (KEEP matches, element
// preserved); aggregate/accumulate are reduce aliases (fn, init, coll) with
// reducer (acc, x); group-by/count-by/reduce-by collapse to a STRING-keyed object
// (open `string` keys → Record<string, …>); compact drops nullish (NonNullable<T>).
// Base vocab (`List`/`SNum`/`SStr`/`SBool`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// group-by / classify — key fn over T, string-keyed buckets of List<T>
expectTypeOf(__arr["group-by"]((x: SNum) => (x > 2 ? "big" : "small"), [1, 2, 3])).toEqualTypeOf<Record<string, List<SNum>>>();
expectTypeOf(__arr.classify((s: SStr) => s, ["a", "b"])).toEqualTypeOf<Record<string, List<SStr>>>();

// count-by / tally — buckets are SNum counts
expectTypeOf(__arr["count-by"]((x: SNum) => "k", [1, 2])["k"]).toEqualTypeOf<SNum>();
expectTypeOf(__arr.tally((s: SStr) => s, ["a"])).toEqualTypeOf<Record<string, SNum>>();

// reduce-by — per-bucket fold threading Acc
expectTypeOf(__arr["reduce-by"]((acc: SNum, x: SNum) => acc + x, 0, (x: SNum) => "k", [1, 2])).toEqualTypeOf<Record<string, SNum>>();

// sort-by / order-by / order / sort-with — element type preserved
expectTypeOf(__arr["sort-by"]((x: SNum) => x, [3, 1, 2])).toEqualTypeOf<List<SNum>>();
expectTypeOf(__arr["order-by"]((s: SStr) => s.length, ["bb", "a"])).toEqualTypeOf<List<SStr>>();
expectTypeOf(__arr.order((a: SNum, b: SNum) => a - b, [3, 1])).toEqualTypeOf<List<SNum>>();
expectTypeOf(__arr["sort-with"]([(a: SNum, b: SNum) => a - b], [3, 1])).toEqualTypeOf<List<SNum>>();

// reject / remove / exclude / select / keep — predicate-filter, element preserved
expectTypeOf(__arr.reject((x: SNum) => x > 2, [1, 2, 3])).toEqualTypeOf<List<SNum>>();
expectTypeOf(__arr.remove((x: SNum) => x > 2, [1, 2, 3])).toEqualTypeOf<List<SNum>>();
expectTypeOf(__arr.exclude((s: SStr) => s.length > 0, ["a"])).toEqualTypeOf<List<SStr>>();
expectTypeOf(__arr.select((x: SNum) => x > 0, [1, 2])).toEqualTypeOf<List<SNum>>();
expectTypeOf(__arr.keep((s: SStr) => s.length > 0, ["a"])).toEqualTypeOf<List<SStr>>();

// slice — from/to numbers, element preserved
expectTypeOf(__arr.slice(1, 3, [1, 2, 3, 4])).toEqualTypeOf<List<SNum>>();

// find-index / find-last-index → SNum
expectTypeOf(__arr["find-index"]((x: SNum) => x > 2, [1, 2, 3])).toEqualTypeOf<SNum>();
expectTypeOf(__arr["find-last-index"]((x: SNum) => x > 2, [1, 2, 3])).toEqualTypeOf<SNum>();

// find-last / locate → T | undefined, element-precise
expectTypeOf(__arr["find-last"]((x: SNum) => x < 3, [1, 2, 3])).toEqualTypeOf<SNum | undefined>();
expectTypeOf(__arr.locate((s: SStr) => s.length > 0, ["a", "b"])).toEqualTypeOf<SStr | undefined>();

// compact — drops nullish; element type loses null/undefined
expectTypeOf(__arr.compact([1, null, 2] as List<SNum | null>)).toEqualTypeOf<List<SNum>>();

// all / any / none → SBool with precise element arg
expectTypeOf(__arr.all((x: SNum) => x > 0, [1, 2])).toEqualTypeOf<SBool>();
expectTypeOf(__arr.any((s: SStr) => s.length > 0, ["a"])).toEqualTypeOf<SBool>();
expectTypeOf(__arr.none((x: SNum) => x > 0, [-1, -2])).toEqualTypeOf<SBool>();

// prepend — widens element union
expectTypeOf(__arr.prepend(0, [1, 2])).toEqualTypeOf<List<SNum>>();
expectTypeOf(__arr.prepend("x", [1, 2])).toEqualTypeOf<List<SNum | SStr>>();

// chain — flat-map; f returns List<B>, result is List<B>
expectTypeOf(__arr.chain((x: SNum) => [x, x], [1, 2])).toEqualTypeOf<List<SNum>>();
expectTypeOf(__arr.chain((x: SNum) => ["a"], [1, 2])).toEqualTypeOf<List<SStr>>();

// aggregate / accumulate — reduce aliases, reducer (acc, x), thread Acc
expectTypeOf(__arr.aggregate((acc: SNum, x: SNum) => acc + x, 0, [1, 2, 3])).toEqualTypeOf<SNum>();
expectTypeOf(__arr.accumulate((acc: SStr, x: SNum) => acc + x, "", [1, 2])).toEqualTypeOf<SStr>();

// @ts-expect-error group-by key fn param disagrees with element type
__arr["group-by"]((s: SStr) => s, [1, 2, 3]);
// @ts-expect-error count-by key fn must return a string key, not a number
__arr["count-by"]((x: SNum) => x, [1, 2]);
// @ts-expect-error reduce-by accumulator type mismatch (acc is SNum, returns SStr)
__arr["reduce-by"]((acc: SNum, x: SNum) => "x", 0, (x: SNum) => "k", [1, 2]);
// @ts-expect-error sort-by element type mismatch
__arr["sort-by"]((s: SStr) => s, [1, 2, 3]);
// @ts-expect-error order comparator must return SNum, not SBool
__arr.order((a: SNum, b: SNum) => a > b, [3, 1]);
// @ts-expect-error sort-with comparator element type mismatch
__arr["sort-with"]([(a: SStr, b: SStr) => 0], [1, 2]);
// @ts-expect-error reject predicate element type mismatch
__arr.reject((s: SStr) => s.length > 0, [1, 2, 3]);
// @ts-expect-error exclude predicate must return SBool, not SNum
__arr.exclude((x: SNum) => x, [1, 2, 3]);
// @ts-expect-error select element mismatch poisons the typed result
const r1: List<SNum> = __arr.select((s: SStr) => s.length > 0, ["a"]);
// @ts-expect-error slice from must be a number, not a string
__arr.slice("a", 3, [1, 2, 3]);
// @ts-expect-error find-index result is SNum, not SStr
const i1: SStr = __arr["find-index"]((x: SNum) => x > 2, [1, 2, 3]);
// @ts-expect-error find-last predicate element type mismatch
__arr["find-last"]((s: SStr) => s.length > 0, [1, 2, 3]);
// @ts-expect-error locate's result is element-precise — wrong-typing it bites
const e1: SBool = __arr.locate((x: SNum) => x > 0, [1, 2]);
// @ts-expect-error all predicate must return SBool, not SNum
__arr.all((x: SNum) => x, [1, 2]);
// @ts-expect-error none element type mismatch
__arr.none((s: SStr) => s.length > 0, [1, 2]);
// @ts-expect-error chain callback must return a List, not a scalar
__arr.chain((x: SNum) => x, [1, 2]);
// @ts-expect-error aggregate accumulator type mismatch
__arr.aggregate((acc: SNum, x: SNum) => acc, "seed", [1, 2]);
// @ts-expect-error prepend into a typed list of the wrong element type bites at the use site
const r2: List<SNum> = __arr.prepend("x", [1, 2]);
