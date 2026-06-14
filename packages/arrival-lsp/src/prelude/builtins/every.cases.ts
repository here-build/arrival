// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `every` builtin (every.d.ts → `every<T>(pred, xs): SBool`).
// expect-type assertions over the ambient `__arr`; inputs are WIDENED list literals
// so the predicate param binds to the exact element type. The result is the exact
// brand `SBool`, so positives pin with a single `.toEqualTypeOf<SBool>()`.
// Negatives use `// @ts-expect-error`. Base vocab (`List`/`SNum`/`SStr`/`SBool`)
// is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// universal quantifier over a number list → SBool
expectTypeOf(__arr.every((x: SNum): SBool => x > 0, [1, 2, 3])).toEqualTypeOf<SBool>();
// predicate over a string list
expectTypeOf(__arr.every((s: SStr): SBool => s.length > 0, ["a", "b"])).toEqualTypeOf<SBool>();

// @ts-expect-error predicate element type (SStr) mismatches the list element type (SNum)
__arr.every((s: SStr): SBool => s.length > 0, [1, 2, 3]);
// @ts-expect-error result is SBool, not assignable to SNum
const n: SNum = __arr.every((x: SNum): SBool => x > 0, [1, 2, 3]);
