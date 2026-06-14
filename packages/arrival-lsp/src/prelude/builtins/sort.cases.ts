// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `sort` builtin (sort.d.ts → `sort<T>(xs, cmp?): List<T>`).
// expect-type assertions over the ambient `__arr`; inputs are WIDENED list literals
// so element type `T` resolves to the exact brand. Arg order is (LIST, comparator?)
// — list FIRST, comparator OPTIONAL second. Element type is preserved in→out, so a
// positive pins the result list (or an indexed element) with `.toEqualTypeOf<T>()`.
// Negatives use `// @ts-expect-error`. Base vocab (`List`/`SNum`/`SStr`) is ambient
// from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// sort without a comparator — element type preserved
expectTypeOf(__arr.sort([3, 1, 2])).toEqualTypeOf<List<SNum>>();
// sort with a numeric comparator; result element type preserved (SNum)
expectTypeOf(__arr.sort([3, 1, 2], (a: SNum, b: SNum): SNum => a - b)[0]).toEqualTypeOf<SNum>();
// comparator over string elements
expectTypeOf(__arr.sort(["b", "a"], (a: SStr, b: SStr): SNum => (a < b ? -1 : 1))).toEqualTypeOf<List<SStr>>();

// @ts-expect-error comparator must RETURN a number, not a string
__arr.sort([1, 2], (a: SNum, b: SNum): SNum => "nope");
// @ts-expect-error comparator params are T (SNum here): cannot call a string method on them
__arr.sort([1, 2], (a: SNum, b: SNum) => a.toUpperCase());
// @ts-expect-error result is List<SNum>; assigning an element to a string is wrong
const s: SStr = __arr.sort([3, 1, 2])[0];
