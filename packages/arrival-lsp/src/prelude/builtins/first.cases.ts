// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `first` — first element of a list, alias of `car`
// (first.d.ts → `first<T>(xs: List<T>): T`). expect-type assertions over the ambient
// `__arr`; inputs are WIDENED list literals so the result is the exact element brand
// — positives pin with `.toEqualTypeOf<T>()` (an arg-rot OR a return→any rot both
// bite). Negatives use `// @ts-expect-error`. Base vocab (`List`/`SNum`/`SStr`) is
// ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// first element of a number list → SNum
expectTypeOf(__arr.first([1, 2, 3])).toEqualTypeOf<SNum>();
// first element of a string list → SStr
expectTypeOf(__arr.first(["a", "b"])).toEqualTypeOf<SStr>();

// @ts-expect-error non-list argument → should error (SNum is not List<T>)
__arr.first(42);
