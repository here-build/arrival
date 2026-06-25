// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the type-predicates family. References `__arr` + ambient PRE
// vocab (../types.d.ts).
//
// For the guard predicates (string?/number?/…) the bite is the NARROWING: we pin
// the predicate target with `expectTypeOf(...).guards.toEqualTypeOf<T>()`, and we
// exercise an in-branch narrowing whose wrong-type use is the `// @ts-expect-error`
// negative. Non-guard predicates just return boolean.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// guard predicates narrow to their target type
expectTypeOf(__arr["string?"]).guards.toEqualTypeOf<string>();
expectTypeOf(__arr["number?"]).guards.toEqualTypeOf<number>();
expectTypeOf(__arr["array?"]).guards.toEqualTypeOf<List<unknown>>();
expectTypeOf(__arr["list?"]).guards.toEqualTypeOf<List<unknown>>();
expectTypeOf(__arr["pair?"]).guards.toEqualTypeOf<Pair<unknown>>();

// the narrowing threads inside a guarded branch
{
  const v: unknown = "x";
  if (__arr["string?"](v)) expectTypeOf(v).toEqualTypeOf<string>();
}
{
  const w: unknown = 1;
  if (__arr["number?"](w)) expectTypeOf(w).toEqualTypeOf<number>();
}

// non-guard predicates return boolean
expectTypeOf(__arr["symbol?"]("x" as unknown)).toEqualTypeOf<boolean>();
expectTypeOf(__arr["function?"](0 as unknown)).toEqualTypeOf<boolean>();
expectTypeOf(__arr["object?"](0 as unknown)).toEqualTypeOf<boolean>();
expectTypeOf(__arr["regex?"](0 as unknown)).toEqualTypeOf<boolean>();
expectTypeOf(__arr["real?"](0 as unknown)).toEqualTypeOf<boolean>();
expectTypeOf(__arr["boolean?"](0 as unknown)).toEqualTypeOf<boolean>();

// after string? narrows to string, using it as number bites
{
  const v: unknown = "x";
  if (__arr["string?"](v)) {
    // @ts-expect-error narrowed to string, not number
    const n: number = v;
    void n;
  }
}
// after number? narrows to number, using it as string bites
{
  const w: unknown = 1;
  if (__arr["number?"](w)) {
    // @ts-expect-error narrowed to number, not string
    const s: string = w;
    void s;
  }
}
