// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `filter` (filter.d.ts → `filter<T>(pred: (x: T) => boolean, xs: List<T>): List<T>`).
// expect-type assertions over the ambient `__arr`; inputs are WIDENED list literals
// so the result is an exact brand — positives pin with `.toEqualTypeOf<T>()`.
// filter narrows the COUNT, not the type, so the element type is preserved.
// Negatives use `// @ts-expect-error`. Callback annotations are kept verbatim —
// they drive inference and the bite.
// Base vocab (`List`/`number`/`string`/`boolean`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// predicate over numbers, list of numbers → list of numbers
expectTypeOf(__arr.filter((x: number) => x > 0)).toEqualTypeOf<List<number>>();
// predicate over strings, list of strings → list of strings
expectTypeOf(__arr.filter((s: string) => s.length > 0)).toEqualTypeOf<List<string>>();

// @ts-expect-error predicate's parameter type disagrees with the list element type
__arr.filter((s: string) => s.length > 0);
// @ts-expect-error second argument is not a list
__arr.filter((x: number) => x > 0);
// @ts-expect-error predicate must return boolean, not number
__arr.filter(Boolean, [1, 2, 3]);
