// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `-` — expect-type assertions over the ambient `__arr` (typed by
// the merged `ArrShape`; base vocab `SNum` is ambient from ../types.d.ts).
//   • positives  → `expectTypeOf(...).toEqualTypeOf<SNum>()` pins the EXACT result
//     type, so an arg-rot OR a return→any rot both bite.
//   • negatives  → `// @ts-expect-error`; if the signature rots so the line stops
//     erroring, the unused directive itself becomes the compile error.
// `-` requires at least one SNum argument (unary negation or n-ary subtraction).
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// unary negation: (- 5) → -5
expectTypeOf(__arr["-"](5)).toEqualTypeOf<SNum>();
// binary subtraction: (- 10 3) → 7
expectTypeOf(__arr["-"](10, 3)).toEqualTypeOf<SNum>();
// variadic: (- 100 10 5) → 85
expectTypeOf(__arr["-"](100, 10, 5)).toEqualTypeOf<SNum>();

// @ts-expect-error "-" requires at least one SNum argument — no args is disallowed
__arr["-"]();
// @ts-expect-error "-" does not accept strings
__arr["-"]("a", 1);
