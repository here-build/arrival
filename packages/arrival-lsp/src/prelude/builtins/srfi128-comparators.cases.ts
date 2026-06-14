// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for SRFI-128 comparators (srfi128-comparators.d.ts) — expect-type
// assertions over the ambient `__arr`. A comparator is the literal-tagged 4-tuple
//   ['comparator', (x)=>SBool, (a,b)=>SBool, (a,b)=>SBool]
// (written INLINE — PRE forbids a top-level `Comparator<T>` alias). Construction
// and default-comparator pin that exact tuple brand; the relational chain ops and
// `comparator?`/`-hashable?` return SBool exactly → single `.toEqualTypeOf<T>()`.
//
// ★ Leaf caveats (carried, do not "fix"):
//   • default-comparator / make-default-comparator are NULLARY FUNCTIONS that
//     RETURN a comparator — they must be CALLED, not used as a value.
//   • The 4th `hash` arg to make-comparator is accepted (optional) but ignored.
//   • The three preds are NOT cross-parameterised over a shared T in v1 (honest-
//     coarse: type-test `(x:unknown)=>SBool`, equality/ordering `(a,b)=>SBool`).
//   • `=?`/`<?`/… take the comparator FIRST, then variadic values.
// Base vocab (`SBool`/`SNum`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// the comparator tuple shape, named once for the assertions below
type Cmp = readonly [
  "comparator",
  (x: unknown) => SBool,
  (a: unknown, b: unknown) => SBool,
  (a: unknown, b: unknown) => SBool,
];

// make-comparator with the three predicates → a comparator tuple
expectTypeOf(
  __arr["make-comparator"](
    (x: unknown): SBool => true,
    (a: unknown, b: unknown): SBool => a === b,
    (a: unknown, b: unknown): SBool => true,
  ),
).toEqualTypeOf<Cmp>();
// 4th hash arg accepted (ignored at runtime) → still a comparator tuple
expectTypeOf(
  __arr["make-comparator"](
    (x: unknown): SBool => true,
    (a: unknown, b: unknown): SBool => true,
    (a: unknown, b: unknown): SBool => true,
    (x: unknown): SNum => 0,
  ),
).toEqualTypeOf<Cmp>();

// default comparators are NULLARY functions returning a comparator
expectTypeOf(__arr["default-comparator"]()).toEqualTypeOf<Cmp>();
expectTypeOf(__arr["make-default-comparator"]()).toEqualTypeOf<Cmp>();

// comparator? returns SBool
expectTypeOf(__arr["comparator?"](__arr["default-comparator"]())).toEqualTypeOf<SBool>();

// extractors return the bundled predicates
expectTypeOf(__arr["comparator-equality-predicate"](__arr["default-comparator"]())).toEqualTypeOf<
  (a: unknown, b: unknown) => SBool
>();
expectTypeOf(__arr["comparator-ordering-predicate"](__arr["default-comparator"]())).toEqualTypeOf<
  (a: unknown, b: unknown) => SBool
>();

// relational chain ops over a comparator + values → SBool
expectTypeOf(__arr["=?"](__arr["default-comparator"](), 1, 1)).toEqualTypeOf<SBool>();
expectTypeOf(__arr["<?"](__arr["default-comparator"](), 1, 2, 3)).toEqualTypeOf<SBool>();
expectTypeOf(__arr[">=?"](__arr["default-comparator"](), 3, 2)).toEqualTypeOf<SBool>();
expectTypeOf(__arr["comparator-hashable?"](__arr["default-comparator"]())).toEqualTypeOf<SBool>();

// @ts-expect-error default-comparator is a comparator tuple, not a SBool value
const w: SBool = __arr["default-comparator"]();
// @ts-expect-error =? requires a comparator first; a bare number is not a comparator tuple
__arr["=?"](5, 1, 1);
// @ts-expect-error make-comparator's type-test must be a 1-arg predicate, not a number
__arr["make-comparator"](5, (a: unknown, b: unknown): SBool => true, (a: unknown, b: unknown): SBool => true);
// @ts-expect-error comparator-equality-predicate requires a comparator, not a list
__arr["comparator-equality-predicate"]([1, 2, 3]);
