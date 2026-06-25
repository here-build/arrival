// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `last` — last element of a list (last.d.ts → `last<T>(xs: List<T>): T`).
// expect-type assertions over the ambient `__arr`; inputs are WIDENED list literals
// so results are exact brands — positives pin with `.toEqualTypeOf<T>()` (an arg-rot
// OR a return→any rot both bite); negatives use `// @ts-expect-error`.
// Base vocab (`List`/`number`/`string`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// last element of a number list → number
expectTypeOf(__arr.last([1, 2, 3])).toEqualTypeOf<number>();
// last element of a string list → string
expectTypeOf(__arr.last(["a", "b", "c"])).toEqualTypeOf<string>();

// @ts-expect-error non-list argument (number) is not assignable to List<T>
__arr.last(42);
