// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `zero?`, `even?`, `odd?`, `null?`, `empty?`, `not`, `equal?`,
// `eq?` (predicates.d.ts). expect-type assertions over the ambient `__arr`.
// These are NON-guard predicates — each returns an exact `boolean`, so positives pin
// with a single `.toEqualTypeOf<boolean>()` (it rejects a return→any rot on its own).
// Negatives use `// @ts-expect-error`: a wrong-typed arg bites at the call (2345);
// if the signature rots to `any` the line stops erroring and the unused directive
// becomes the failure.
// Base vocab (`number`/`boolean`/`List`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// numeric predicates accept number and return boolean
expectTypeOf(__arr["zero?"](0)).toEqualTypeOf<boolean>();
expectTypeOf(__arr["even?"](4)).toEqualTypeOf<boolean>();
expectTypeOf(__arr["odd?"](3)).toEqualTypeOf<boolean>();
// list predicates accept List<unknown> and return boolean
expectTypeOf(__arr["null?"]([])).toEqualTypeOf<boolean>();
expectTypeOf(__arr["empty?"]([])).toEqualTypeOf<boolean>();
// not accepts any value and returns boolean
expectTypeOf(__arr.not(false)).toEqualTypeOf<boolean>();
// equal? and eq? accept any two values and return boolean
expectTypeOf(__arr["equal?"](1, 1)).toEqualTypeOf<boolean>();
expectTypeOf(__arr["eq?"]("a", "a")).toEqualTypeOf<boolean>();

// @ts-expect-error zero? requires number, not a string
__arr["zero?"]("hello");
// @ts-expect-error null? requires List<unknown>, not a number
__arr["null?"](42);
// @ts-expect-error even? requires number, not a boolean
__arr["even?"](true);
