// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `cdr` — the REST / TAIL accessor (cdr.d.ts → `cdr<T>(xs: List<T>): List<T>`).
// expect-type assertions over the ambient `__arr`; inputs are WIDENED list literals
// so the result is the exact brand `List<T>` — positives pin with `.toEqualTypeOf<T>()`
// (an arg-rot OR a return→any rot both bite). Negatives use `// @ts-expect-error`:
// the unused directive becomes the failure if the signature rots so the line stops
// erroring. Base vocab (`List`/`SNum`/`SStr`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// cdr of a typed list returns the same element-type list
expectTypeOf(__arr.cdr([1, 2, 3])).toEqualTypeOf<List<SNum>>();
// cdr of a string list
expectTypeOf(__arr.cdr(["a", "b", "c"])).toEqualTypeOf<List<SStr>>();

// @ts-expect-error cdr requires a List<T>, not a bare number
__arr.cdr(5);
// @ts-expect-error cdr requires a List<T>, not a string
__arr.cdr("hello");
