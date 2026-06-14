// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `cons` (cons.d.ts → `cons<H,T>(head: H, tail: List<T>): List<H|T>`).
// expect-type assertions over the ambient `__arr`; inputs are WIDENED literals so
// the result is an exact brand — positives pin with `.toEqualTypeOf<T>()`.
// Negatives use `// @ts-expect-error`; if the signature rots so the line stops
// erroring, the unused directive itself becomes the compile error.
// Base vocab (`List`/`SNum`/`SStr`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// cons a number onto a number list — result is List<SNum>
expectTypeOf(__arr.cons(1, [2, 3])).toEqualTypeOf<List<SNum>>();
// cons a string onto an empty list — T is never, so result widens to List<SStr>
expectTypeOf(__arr.cons("hello", [])).toEqualTypeOf<List<SStr>>();

// @ts-expect-error tail must be a List, not a bare number
__arr.cons(1, 2);
// @ts-expect-error tail must be a List, not a string
__arr.cons(1, "notalist");
