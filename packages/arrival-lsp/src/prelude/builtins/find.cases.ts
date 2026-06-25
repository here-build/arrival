// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `find` (find.d.ts → `find<T>(pred: (x: T) => boolean, xs: List<T>): T | undefined`).
// expect-type assertions over the ambient `__arr`; inputs are WIDENED list literals
// so the result is `T | undefined` (the glass over SRFI-1's `#f`-on-miss). The
// `| undefined` is PRESERVED in the pin — callers must account for the absence.
// Negatives use `// @ts-expect-error`. Callback annotations are kept verbatim.
// Base vocab (`List`/`number`/`string`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// predicate over a number-list yields the element type, widened with undefined
expectTypeOf(__arr.find((n: number) => n > 0, [1, 2, 3])).toEqualTypeOf<number | undefined>();
// predicate over a string-list
expectTypeOf(__arr.find((s: string) => s.length > 0, ["a", "b"])).toEqualTypeOf<string | undefined>();

// @ts-expect-error predicate param type mismatches the list element type (string pred, number list)
__arr.find((s: string) => s.length > 0, [1, 2, 3]);
// @ts-expect-error result may be undefined → not assignable to a bare number
const n: number = __arr.find((n: number) => n > 0, [1, 2, 3]);
// @ts-expect-error second arg is not a list
__arr.find((n: number) => n > 0, 5);
