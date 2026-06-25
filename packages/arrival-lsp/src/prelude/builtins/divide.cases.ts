// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `/` — expect-type assertions over the ambient `__arr` (typed by
// the merged `ArrShape`; base vocab `number` is ambient from ../types.d.ts).
//   • positives  → `expectTypeOf(...).toEqualTypeOf<number>()` pins the EXACT result
//     type, so an arg-rot OR a return→any rot both bite.
//   • negatives  → `// @ts-expect-error`; if the signature rots so the line stops
//     erroring, the unused directive itself becomes the compile error.
// `/` requires at least one number argument (unary reciprocal or n-ary division).
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// unary reciprocal: (/ 4) → 0.25
expectTypeOf(__arr["/"](4)).toEqualTypeOf<number>();
// binary division: (/ 10 2) → 5
expectTypeOf(__arr["/"](10, 2)).toEqualTypeOf<number>();
// variadic: (/ 100 2 5) → 10
expectTypeOf(__arr["/"](100, 2, 5)).toEqualTypeOf<number>();

// @ts-expect-error "/" requires at least one number argument — no args is disallowed
__arr["/"]();
// @ts-expect-error "/" does not accept strings
__arr["/"]("a", 2);
