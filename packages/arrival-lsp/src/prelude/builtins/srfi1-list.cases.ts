// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the live SRFI-1-adjacent list family (srfi1-list.d.ts). expect-type
// assertions over the ambient `__arr`; inputs are WIDENED list literals (`[1,2,3]` →
// number[]) so the results are exact brands — positives pin with `.toEqualTypeOf<T>()`
// (an arg-rot OR a return→any rot both bite). Negatives use `// @ts-expect-error`:
// a swapped/wrong arg bites at the call (2345), a wrong-typed threaded result at the
// assignment (2322); if the signature rots to `any` the line stops erroring and the
// unused directive becomes the failure.
// Base vocab (`List`/`number`/`string`/`void`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// take / drop — count-first, element type preserved
expectTypeOf(__arr.take(2, [1, 2, 3, 4])).toEqualTypeOf<List<number>>();
expectTypeOf(__arr.drop(1, ["a", "b", "c"])).toEqualTypeOf<List<string>>();

// concat — string concat, variadic strings → string
expectTypeOf([...__arr, "a", "b", "c"]).toEqualTypeOf<string>();

// flatten — argument is a list; element type is unknown
expectTypeOf(
  __arr.flatten([
    [1, 2],
    [3, [4]],
  ]),
).toEqualTypeOf<List<unknown>>();

// fold — accumulator type B threads from seed through callback to result
expectTypeOf(__arr.fold((acc: number, x: number): number => acc + x, 0, [1, 2, 3])).toEqualTypeOf<number>();
expectTypeOf(__arr.fold((a: List<number>, x: number): List<number> => a, [], [1, 2, 3])).toEqualTypeOf<List<number>>();

// nth — index-first, element-or-undefined
expectTypeOf(__arr.nth(1, [10, 20, 30])).toEqualTypeOf<number | undefined>();

// for-each — void return; callback param bound to element type
expectTypeOf(
  __arr["for-each"](
    (x: number): void => {
      x;
    },
    [1, 2, 3],
  ),
).toEqualTypeOf<void>();

// count — number result; pred param bound to element type
expectTypeOf(__arr.count((x: number): boolean => x > 1, [1, 2, 3])).toEqualTypeOf<number>();

// remove — inverse filter, element type preserved
expectTypeOf(__arr.remove((x: number): boolean => x > 1, [1, 2, 3])).toEqualTypeOf<List<number>>();

// @ts-expect-error take — args swapped (list where the count goes)
__arr.take([1, 2, 3], 2);
// @ts-expect-error drop — wrong-typing the threaded result (string list cannot be number list)
const x: List<number> = __arr.drop(1, ["a", "b"]);
// @ts-expect-error concat — list arg where a string is required (STRING concat, not append)
[...__arr, 1, 2, 3, 4];
// @ts-expect-error flatten — argument is not a list
__arr.flatten(5);
// @ts-expect-error fold — callback acc type disagrees with the seed type (string acc vs number seed)
__arr.fold((acc: string, x: number): string => acc, 0, [1, 2, 3]);
// @ts-expect-error fold — element type mismatches the callback's x param (string x over number list)
__arr.fold((acc: number, x: string): number => acc, 0, [1, 2, 3]);
// @ts-expect-error nth — args swapped (list where the index goes)
__arr.nth([10, 20], 1);
// @ts-expect-error nth — wrong element type threaded out
const n: string | undefined = __arr.nth(1, [10, 20, 30]);
// @ts-expect-error for-each — callback param type mismatches the element type
__arr["for-each"](
  (x: string): void => {
    x;
  },
  [1, 2, 3],
);
// @ts-expect-error count — pred param type mismatches the element type
__arr.count((x: string): boolean => x.length > 0, [1, 2, 3]);
