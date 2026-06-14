// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `abs` `sqrt` `floor` `round` `min` `max` — numeric math cluster.
// expect-type assertions over the ambient `__arr` (typed by the merged `ArrShape`;
// base vocab `SNum` is ambient from ../types.d.ts).
//   • positives  → `expectTypeOf(...).toEqualTypeOf<SNum>()` pins the EXACT result
//     type, so an arg-rot OR a return→any rot both bite.
//   • negatives  → `// @ts-expect-error`; if the signature rots so the line stops
//     erroring, the unused directive itself becomes the compile error.
// `abs`/`sqrt`/`floor`/`round` are unary; `min`/`max` are variadic (≥1 arg).
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// abs of a number returns SNum
expectTypeOf(__arr.abs(-5)).toEqualTypeOf<SNum>();
// sqrt of a number returns SNum
expectTypeOf(__arr.sqrt(9)).toEqualTypeOf<SNum>();
// floor of a number returns SNum
expectTypeOf(__arr.floor(3.7)).toEqualTypeOf<SNum>();
// round of a number returns SNum
expectTypeOf(__arr.round(2.5)).toEqualTypeOf<SNum>();
// min/max are variadic — one or more SNum args
expectTypeOf(__arr.min(1, 2, 3)).toEqualTypeOf<SNum>();
expectTypeOf(__arr.max(4, 5, 6)).toEqualTypeOf<SNum>();

// @ts-expect-error abs requires SNum, not a string
__arr.abs("hello");
// @ts-expect-error min requires SNum args, not strings
__arr.min("a", "b");
// @ts-expect-error sqrt requires SNum, not boolean
__arr.sqrt(true);
