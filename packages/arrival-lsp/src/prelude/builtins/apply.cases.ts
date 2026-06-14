// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `apply` leaf (apply.d.ts → spread a list as a function's
// args). expect-type assertions over the ambient `__arr`. The args tuple is
// pinned with `as const` so it matches the callee's own parameter tuple `A`; the
// call yields the callee's return brand `R` exactly → positives pin with
// `.toEqualTypeOf<R>()`. Negatives use `// @ts-expect-error`: a wrong-element
// tuple or a non-function first arg bites at the call (2345).
// Base vocab (`SNum`/`SStr`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// args tuple matches the callee's parameter types → returns the callee's brand
expectTypeOf(__arr.apply((a: SNum, b: SNum) => a + b, [1, 2] as const)).toEqualTypeOf<SNum>();
expectTypeOf(__arr.apply((x: SStr) => x, ["hi"] as const)).toEqualTypeOf<SStr>();

// @ts-expect-error second arg is a string but the callee's 2nd param is SNum → TS2345
__arr.apply((a: SNum, b: SNum) => a + b, [1, "x"] as const);
// @ts-expect-error first arg is not a function → TS2345
__arr.apply(5, [1, 2] as const);
