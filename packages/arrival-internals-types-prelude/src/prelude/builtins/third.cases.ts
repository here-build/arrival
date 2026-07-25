// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `third` — third element of a list (third.d.ts → `third<T>(xs: List<T>): T`).
// expect-type assertions over the ambient global functions; inputs are WIDENED list literals
// so results are exact brands — positives pin with `.toEqualTypeOf<T>()` (an arg-rot
// OR a return→any rot both bite); negatives use `// @ts-expect-error`.
// Base vocab (`List`/`number`/`string`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// (third (list 1 2 3)) → 3 (a number)
expectTypeOf(third([1, 2, 3])).toEqualTypeOf<number>();
// (third (list "a" "b" "c")) → "c" (a string)
expectTypeOf(third(["a", "b", "c"])).toEqualTypeOf<string>();

// @ts-expect-error third of a non-list (number) is not assignable to List<T>
third(42);
