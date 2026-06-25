// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `length` builtin (length.d.ts → `length(xs: List<unknown>): number`).
// expect-type assertions over the ambient `__arr`. The result is the exact brand
// `number`, so positives pin with a single `.toEqualTypeOf<number>()`. Negatives use
// `// @ts-expect-error`. Base vocab (`List`/`number`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// length of a number list returns number
expectTypeOf(__arr.length([1, 2, 3])).toEqualTypeOf<number>();
// length of a string list
expectTypeOf(__arr.length(["a", "b"])).toEqualTypeOf<number>();
// length of an empty list
expectTypeOf(__arr.length([])).toEqualTypeOf<number>();

// @ts-expect-error length requires a List<unknown>, not a bare number
__arr.length(42);
// @ts-expect-error length requires a List<unknown>, not a string
__arr.length("hello");
