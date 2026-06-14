// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the type-predicates family. References `__arr` + ambient PRE
// vocab (../types.d.ts).
//
// For the guard predicates (string?/number?/…) the bite is the NARROWING: we pin
// the predicate target with `expectTypeOf(...).guards.toEqualTypeOf<T>()`, and we
// exercise an in-branch narrowing whose wrong-type use is the `// @ts-expect-error`
// negative. Non-guard predicates just return SBool.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// guard predicates narrow to their target type
expectTypeOf(__arr["string?"]).guards.toEqualTypeOf<SStr>();
expectTypeOf(__arr["number?"]).guards.toEqualTypeOf<SNum>();
expectTypeOf(__arr["array?"]).guards.toEqualTypeOf<List<unknown>>();
expectTypeOf(__arr["list?"]).guards.toEqualTypeOf<List<unknown>>();
expectTypeOf(__arr["pair?"]).guards.toEqualTypeOf<Pair<unknown>>();

// the narrowing threads inside a guarded branch
{
  const v: unknown = "x";
  if (__arr["string?"](v)) expectTypeOf(v).toEqualTypeOf<SStr>();
}
{
  const w: unknown = 1;
  if (__arr["number?"](w)) expectTypeOf(w).toEqualTypeOf<SNum>();
}

// non-guard predicates return SBool
expectTypeOf(__arr["symbol?"]("x" as unknown)).toEqualTypeOf<SBool>();
expectTypeOf(__arr["function?"](0 as unknown)).toEqualTypeOf<SBool>();
expectTypeOf(__arr["object?"](0 as unknown)).toEqualTypeOf<SBool>();
expectTypeOf(__arr["regex?"](0 as unknown)).toEqualTypeOf<SBool>();
expectTypeOf(__arr["real?"](0 as unknown)).toEqualTypeOf<SBool>();
expectTypeOf(__arr["boolean?"](0 as unknown)).toEqualTypeOf<SBool>();

// after string? narrows to SStr, using it as SNum bites
{
  const v: unknown = "x";
  if (__arr["string?"](v)) {
    // @ts-expect-error narrowed to SStr, not SNum
    const n: SNum = v;
    void n;
  }
}
// after number? narrows to SNum, using it as SStr bites
{
  const w: unknown = 1;
  if (__arr["number?"](w)) {
    // @ts-expect-error narrowed to SNum, not SStr
    const s: SStr = w;
    void s;
  }
}
