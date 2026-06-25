// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `every` builtin (every.d.ts → `every<T>(pred, xs): boolean`).
// expect-type assertions over the ambient `__arr`; inputs are WIDENED list literals
// so the predicate param binds to the exact element type. The result is the exact
// brand `boolean`, so positives pin with a single `.toEqualTypeOf<boolean>()`.
// Negatives use `// @ts-expect-error`. Base vocab (`List`/`number`/`string`/`boolean`)
// is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// universal quantifier over a number list → boolean
expectTypeOf(__arr.every((x: number): boolean => x > 0, [1, 2, 3])).toEqualTypeOf<boolean>();
// predicate over a string list
expectTypeOf(__arr.every((s: string): boolean => s.length > 0, ["a", "b"])).toEqualTypeOf<boolean>();

// @ts-expect-error predicate element type (string) mismatches the list element type (number)
__arr.every((s: string): boolean => s.length > 0, [1, 2, 3]);
// @ts-expect-error result is boolean, not assignable to number
const n: number = __arr.every((x: number): boolean => x > 0, [1, 2, 3]);
