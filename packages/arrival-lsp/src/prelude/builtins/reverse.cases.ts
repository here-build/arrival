// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `reverse` — reverses a list (reverse.d.ts → `reverse<T>(xs: List<T>): List<T>`).
// expect-type assertions over the ambient `__arr`; inputs are WIDENED list literals
// so results are exact brands — positives pin with `.toEqualTypeOf<T>()` (an arg-rot
// OR a return→any rot both bite); negatives use `// @ts-expect-error`.
// Base vocab (`List`/`SNum`/`SStr`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// reverse of a number list returns a number list
expectTypeOf(__arr.reverse([1, 2, 3])).toEqualTypeOf<List<SNum>>();
// reverse of a string list returns a string list
expectTypeOf(__arr.reverse(["a", "b", "c"])).toEqualTypeOf<List<SStr>>();

// @ts-expect-error reverse requires a List<T>, not a bare number
__arr.reverse(42);
// @ts-expect-error reverse requires a List<T>, not a string
__arr.reverse("hello");
