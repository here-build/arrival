// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `second` — element at index 1 of a list
// (second.d.ts → `second<T>(xs: List<T>): T`). expect-type assertions over the ambient
// `/*__arr*/`; inputs are WIDENED list literals so the result is the exact element brand
// — positives pin with `.toEqualTypeOf<T>()` (an arg-rot OR a return→any rot both
// bite). Negatives use `// @ts-expect-error`. Base vocab (`List`/`number`/`string`) is
// ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// second element of a number list → number
expectTypeOf(second([1, 2, 3])).toEqualTypeOf<number>();
// second element of a string list → string
expectTypeOf(second(["a", "b", "c"])).toEqualTypeOf<string>();

// @ts-expect-error non-list argument → should error (number is not List<T>)
second(42);
