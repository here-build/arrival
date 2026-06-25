// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `some` builtin (some.d.ts → `some<T>(pred, xs): boolean`).
// expect-type assertions over the ambient `__arr`; inputs are WIDENED list literals
// so the predicate param binds to the exact element type. The result is the exact
// brand `boolean`, so positives pin with a single `.toEqualTypeOf<boolean>()`.
// Negatives use `// @ts-expect-error`. Base vocab (`List`/`number`/`string`/`boolean`)
// is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// existential quantifier over a number list → boolean
expectTypeOf(__arr.some((x: number): boolean => x > 0, [1, 2, 3])).toEqualTypeOf<boolean>();
// predicate over a string list
expectTypeOf(__arr.some((s: string): boolean => s.length > 0, ["a", "b"])).toEqualTypeOf<boolean>();

// @ts-expect-error predicate param type mismatches the list element type (string pred, number list)
__arr.some((s: string): boolean => s.length > 0, [1, 2, 3]);
// @ts-expect-error second arg is not a list
__arr.some((x: number): boolean => x > 0, 5);
// @ts-expect-error result is boolean, not assignable to number
const n: number = __arr.some((x: number): boolean => x > 0, [1, 2, 3]);
