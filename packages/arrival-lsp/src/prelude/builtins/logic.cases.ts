// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `and`, `or` — variadic logic family (logic.d.ts). expect-type
// assertions over the ambient `__arr`.
// Signature note: the honest v1 return is `T[number] | boolean` (scheme truthiness
// is #f-only, so the JS &&/|| algebra would be subtly wrong). Over all-boolean
// operands the union collapses to exactly `boolean`, so predicate chains pin with a
// single `.toEqualTypeOf<boolean>()`. Value-flavored calls (mixed operand types) are
// legal; we pin them with `.not.toBeAny()` (a return→any rot bites). Negatives use
// `// @ts-expect-error`: the result is operands-or-boolean, never silently a
// precise string/number, so wrong-typing the assignment bites.
// Base vocab (`boolean`/`string`/`number`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// predicate chains stay boolean-compatible (all-boolean operands → exactly boolean)
expectTypeOf(__arr.and(__arr["odd?"](3), __arr.not(false))).toEqualTypeOf<boolean>();
expectTypeOf(__arr.or(__arr["zero?"](0), __arr["even?"](2))).toEqualTypeOf<boolean>();
// value-flavored uses are legal (scheme and/or return operands); never any
expectTypeOf(__arr.and(1, "x")).not.toBeAny();
expectTypeOf(__arr.or()).not.toBeAny();

// @ts-expect-error the result is operands-or-boolean — never silently a precise string
const s: string = __arr.and(1, 2);
// @ts-expect-error nor a precise number
const n: number = __arr.or(false, "x");
