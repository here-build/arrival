// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `car` — the REFERENCE leaf (car.d.ts → `car<T>(xs: List<T>): T`).
// expect-type assertions over the ambient `__arr` (typed by the merged `ArrShape`);
// base vocab (`List`/`number`/`string`) is ambient from ../types.d.ts.
//   • positives → `expectTypeOf(call).toEqualTypeOf<T>()` pins the EXACT element
//     type, so an arg-rot OR a return→any rot both bite.
//   • negatives → `// @ts-expect-error`; if the signature rots so the line stops
//     erroring, the unused directive itself becomes the compile error.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// element type threads out of the list
expectTypeOf(__arr.car([1, 2, 3])).toEqualTypeOf<number>();
expectTypeOf(__arr.car(["a", "b"])).toEqualTypeOf<string>();

// @ts-expect-error argument is not a list
__arr.car(5);
// @ts-expect-error head of a number list is number, not string
const s: string = __arr.car([1, 2, 3]);
