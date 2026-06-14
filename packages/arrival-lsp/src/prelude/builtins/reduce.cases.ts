// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `reduce` (reduce.d.ts → `reduce<A,B>(fn: (acc: B, x: A) => B, init: B, xs: List<A>): B`).
// expect-type assertions over the ambient `__arr`; the accumulator type B threads
// from the seed through the reducer to the result. A may differ from B (fold a
// list of strings into a number). Result is the exact accumulator brand → pin with
// `.toEqualTypeOf<B>()`. Negatives use `// @ts-expect-error`; callback annotations
// are kept verbatim — they drive inference and the bite.
// Base vocab (`List`/`SNum`/`SStr`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// Sum a list of numbers into a number: acc/element/init/result all SNum.
expectTypeOf(__arr.reduce((acc: SNum, x: SNum) => acc + x, 0, [1, 2, 3])).toEqualTypeOf<SNum>();
// Heterogeneous fold: list of strings → number accumulator (A ≠ B).
expectTypeOf(__arr.reduce((acc: SNum, s: SStr) => acc + s.length, 0, ["a", "bb"])).toEqualTypeOf<SNum>();

// @ts-expect-error init type (string) disagrees with the reducer's accumulator/return (number)
__arr.reduce((acc: SNum, x: SNum) => acc + x, "seed", [1, 2, 3]);
// @ts-expect-error reducer element param typed string but the list is List<SNum>
__arr.reduce((acc: SNum, x: SStr) => acc + x.length, 0, [1, 2, 3]);
