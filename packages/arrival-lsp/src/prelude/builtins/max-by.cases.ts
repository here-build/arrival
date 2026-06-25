// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `max-by` builtin (max-by.d.ts → `"max-by"<T>(key, xs): T`).
// expect-type assertions over the ambient `__arr`; inputs are WIDENED list literals
// so element type `T` resolves to the exact brand. The key callback must yield number;
// the return is the ELEMENT `T`, NOT the numeric key. Positives pin the result (or a
// field read off it) with `.toEqualTypeOf<T>()`. Negatives use `// @ts-expect-error`.
// Base vocab (`List`/`number`/`string`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// key returns a number, list of numbers → result is an element (number)
expectTypeOf(__arr["max-by"]((x: number): number => x, [3, 1, 2])).toEqualTypeOf<number>();
// result element type flows through: the returned T is the element type, so `.weight` reads number
expectTypeOf(
  __arr["max-by"]((p: { weight: number }): number => p.weight, [{ weight: 1 }, { weight: 2 }]).weight,
).toEqualTypeOf<number>();

// @ts-expect-error key returns a string, not a number → bites (key must yield a number)
__arr["max-by"]((s: string): string => s, ["a", "b"]);
// @ts-expect-error result is an element T, NOT the numeric key — assigning to string bites
const s: string = __arr["max-by"]((x: number): number => x, [1, 2, 3]);
