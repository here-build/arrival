// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `apply` leaf (apply.d.ts → spread a list as a function's
// args). expect-type assertions over the ambient global functions. The args tuple is
// pinned with `as const` so it matches the callee's own parameter tuple `A`; the
// call yields the callee's return brand `R` exactly → positives pin with
// `.toEqualTypeOf<R>()`. Negatives use `// @ts-expect-error`: a wrong-element
// tuple or a non-function first arg bites at the call (2345).
// Base vocab (`number`/`string`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// args tuple matches the callee's parameter types → returns the callee's brand
expectTypeOf(apply((a: number, b: number) => a + b, [1, 2] as const)).toEqualTypeOf<number>();
expectTypeOf(apply((x: string) => x, ["hi"] as const)).toEqualTypeOf<string>();

// (apply + xs) / (apply * xs) — List is readonly; rest leaves used to be mutable
// `number[]`, so apply rejected List and rolled up phantom "required file has 1 type
// error" on clean helpers like custdev `_util` avg.
expectTypeOf(apply($plus$, [1, 2, 3] as List<number>)).toEqualTypeOf<number>();
expectTypeOf(apply($star$, [2, 3, 4] as List<number>)).toEqualTypeOf<number>();

// @ts-expect-error second arg is a string but the callee's 2nd param is number → TS2345
apply((a: number, b: number) => a + b, [1, "x"] as const);
// @ts-expect-error first arg is not a function → TS2345
apply(5, [1, 2] as const);
