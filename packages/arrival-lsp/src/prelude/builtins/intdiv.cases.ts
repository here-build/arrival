// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `modulo` / `remainder` / `quotient` — integer division family.
// expect-type assertions over the ambient `__arr` (typed by the merged `ArrShape`;
// base vocab `number` is ambient from ../types.d.ts).
//   • positives  → `expectTypeOf(...).toEqualTypeOf<number>()` pins the EXACT result
//     type, so an arg-rot OR a return→any rot both bite.
//   • negatives  → `// @ts-expect-error`; if the signature rots so the line stops
//     erroring, the unused directive itself becomes the compile error.
// All three take exactly 2 numeric arguments.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// modulo: two numbers → number
expectTypeOf(__arr.modulo(10, 3)).toEqualTypeOf<number>();
// remainder: two numbers → number
expectTypeOf(__arr.remainder(10, 3)).toEqualTypeOf<number>();
// quotient: two numbers → number
expectTypeOf(__arr.quotient(10, 3)).toEqualTypeOf<number>();

// @ts-expect-error string argument is not number
__arr.modulo("10", 3);
// @ts-expect-error boolean argument is not number
__arr.quotient(true, 2);
// @ts-expect-error missing second argument (arity must be exactly 2)
__arr.remainder(10);
