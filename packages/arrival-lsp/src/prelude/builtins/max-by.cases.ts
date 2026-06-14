// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `max-by` builtin (max-by.d.ts → `"max-by"<T>(key, xs): T`).
// expect-type assertions over the ambient `__arr`; inputs are WIDENED list literals
// so element type `T` resolves to the exact brand. The key callback must yield SNum;
// the return is the ELEMENT `T`, NOT the numeric key. Positives pin the result (or a
// field read off it) with `.toEqualTypeOf<T>()`. Negatives use `// @ts-expect-error`.
// Base vocab (`List`/`SNum`/`SStr`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// key returns a number, list of numbers → result is an element (SNum)
expectTypeOf(__arr["max-by"]((x: SNum): SNum => x, [3, 1, 2])).toEqualTypeOf<SNum>();
// result element type flows through: the returned T is the element type, so `.weight` reads SNum
expectTypeOf(
  __arr["max-by"]((p: { weight: SNum }): SNum => p.weight, [{ weight: 1 }, { weight: 2 }]).weight,
).toEqualTypeOf<SNum>();

// @ts-expect-error key returns a string, not a SNum → bites (key must yield a number)
__arr["max-by"]((s: SStr): SStr => s, ["a", "b"]);
// @ts-expect-error result is an element T, NOT the numeric key — assigning to SStr bites
const s: SStr = __arr["max-by"]((x: SNum): SNum => x, [1, 2, 3]);
