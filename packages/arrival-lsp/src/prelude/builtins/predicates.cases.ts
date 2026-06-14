// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `zero?`, `even?`, `odd?`, `null?`, `empty?`, `not`, `equal?`,
// `eq?` (predicates.d.ts). expect-type assertions over the ambient `__arr`.
// These are NON-guard predicates — each returns an exact `SBool`, so positives pin
// with a single `.toEqualTypeOf<SBool>()` (it rejects a return→any rot on its own).
// Negatives use `// @ts-expect-error`: a wrong-typed arg bites at the call (2345);
// if the signature rots to `any` the line stops erroring and the unused directive
// becomes the failure.
// Base vocab (`SNum`/`SBool`/`List`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// numeric predicates accept SNum and return SBool
expectTypeOf(__arr["zero?"](0)).toEqualTypeOf<SBool>();
expectTypeOf(__arr["even?"](4)).toEqualTypeOf<SBool>();
expectTypeOf(__arr["odd?"](3)).toEqualTypeOf<SBool>();
// list predicates accept List<unknown> and return SBool
expectTypeOf(__arr["null?"]([])).toEqualTypeOf<SBool>();
expectTypeOf(__arr["empty?"]([])).toEqualTypeOf<SBool>();
// not accepts any value and returns SBool
expectTypeOf(__arr.not(false)).toEqualTypeOf<SBool>();
// equal? and eq? accept any two values and return SBool
expectTypeOf(__arr["equal?"](1, 1)).toEqualTypeOf<SBool>();
expectTypeOf(__arr["eq?"]("a", "a")).toEqualTypeOf<SBool>();

// @ts-expect-error zero? requires SNum, not a string
__arr["zero?"]("hello");
// @ts-expect-error null? requires List<unknown>, not a number
__arr["null?"](42);
// @ts-expect-error even? requires SNum, not a boolean
__arr["even?"](true);
