// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `filter` (filter.d.ts → `filter<T>(pred: (x: T) => SBool, xs: List<T>): List<T>`).
// expect-type assertions over the ambient `__arr`; inputs are WIDENED list literals
// so the result is an exact brand — positives pin with `.toEqualTypeOf<T>()`.
// filter narrows the COUNT, not the type, so the element type is preserved.
// Negatives use `// @ts-expect-error`. Callback annotations are kept verbatim —
// they drive inference and the bite.
// Base vocab (`List`/`SNum`/`SStr`/`SBool`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// predicate over numbers, list of numbers → list of numbers
expectTypeOf(__arr.filter((x: SNum) => x > 0, [1, 2, 3])).toEqualTypeOf<List<SNum>>();
// predicate over strings, list of strings → list of strings
expectTypeOf(__arr.filter((s: SStr) => s.length > 0, ["a", "b"])).toEqualTypeOf<List<SStr>>();

// @ts-expect-error predicate's parameter type disagrees with the list element type
__arr.filter((s: SStr) => s.length > 0, [1, 2, 3]);
// @ts-expect-error second argument is not a list
__arr.filter((x: SNum) => x > 0, 5);
// @ts-expect-error predicate must return SBool, not SNum
__arr.filter((x: SNum) => x, [1, 2, 3]);
