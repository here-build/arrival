// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `<`, `>`, `<=`, `>=`, `=` — numeric comparison / equality family
// (compare.d.ts). expect-type assertions over the ambient `__arr`. Each operator is
// variadic over SNum and returns an exact `SBool`, so positives pin with a single
// `.toEqualTypeOf<SBool>()` (it rejects a return→any rot on its own).
// Negatives use `// @ts-expect-error`: a non-SNum arg bites at the call (2345); if
// the signature rots to `any` the line stops erroring and the unused directive
// becomes the failure.
// Base vocab (`SNum`/`SBool`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// binary less-than
expectTypeOf(__arr["<"](1, 2)).toEqualTypeOf<SBool>();
// chained three-way comparison
expectTypeOf(__arr["<="](1, 2, 3)).toEqualTypeOf<SBool>();
// equality check
expectTypeOf(__arr["="](42, 42)).toEqualTypeOf<SBool>();

// @ts-expect-error string argument is not SNum
__arr["<"]("a", 1);
// @ts-expect-error boolean argument is not SNum
__arr[">"](true, 2);
// @ts-expect-error string in equality check
__arr["="]("hello", "world");
