// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `<`, `>`, `<=`, `>=`, `=` — numeric comparison / equality family
// (compare.d.ts). expect-type assertions over the ambient `__arr`. Each operator is
// variadic over number and returns an exact `boolean`, so positives pin with a single
// `.toEqualTypeOf<boolean>()` (it rejects a return→any rot on its own).
// Negatives use `// @ts-expect-error`: a non-number arg bites at the call (2345); if
// the signature rots to `any` the line stops erroring and the unused directive
// becomes the failure.
// Base vocab (`number`/`boolean`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// binary less-than
expectTypeOf(__arr["<"](1, 2)).toEqualTypeOf<boolean>();
// chained three-way comparison
expectTypeOf(__arr["<="](1, 2, 3)).toEqualTypeOf<boolean>();
// equality check
expectTypeOf(__arr["="](42, 42)).toEqualTypeOf<boolean>();

// @ts-expect-error string argument is not number
__arr["<"]("a", 1);
// @ts-expect-error boolean argument is not number
__arr[">"](true, 2);
// @ts-expect-error string in equality check
__arr["="]("hello", "world");
