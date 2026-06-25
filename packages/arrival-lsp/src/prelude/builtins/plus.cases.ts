// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `+` — expect-type assertions over the ambient `__arr` (typed by
// the merged `ArrShape`; base vocab `number` is ambient from ../types.d.ts).
//   • positives  → `expectTypeOf(...).toEqualTypeOf<T>()` pins the EXACT result
//     type, so an arg-rot OR a return→any rot both bite.
//   • negatives  → `// @ts-expect-error`; if the signature rots so the line stops
//     erroring, the unused directive itself becomes the compile error.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// nullary: (+ ) → 0
expectTypeOf(__arr["+"]()).toEqualTypeOf<number>();
// binary addition
expectTypeOf(__arr["+"](1, 2)).toEqualTypeOf<number>();
// variadic
expectTypeOf(__arr["+"](1, 2, 3, 4)).toEqualTypeOf<number>();

// @ts-expect-error string argument is not number
__arr["+"]("a", 1);
// @ts-expect-error boolean argument is not number
__arr["+"](true, 2);
