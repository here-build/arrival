// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `@` / `@?` / `@keys` accessor family (accessors.d.ts) — the
// A4 field-typo bite. expect-type assertions over the ambient `__arr`, against
// `as const` object literals (the shape the lens captures), so `(@ obj key)`
// returns a LITERAL `Field<O, K>`. Each literal-returning positive is pinned by a
// PAIR — `.toExtend<Brand>()` (the read's literal must extend its brand) and
// `.not.toBeAny()` (the explicit return→any guard, since `toExtend` is blind to
// `any`). `@?` is an OPEN presence check → boolean exactly; `@keys` → `List<string>`
// exactly — both pinned by a single `.toEqualTypeOf<T>()`. Negatives use
// `// @ts-expect-error`: a mis-key bites at the call (2345), a wrong-typed read at
// the assignment (2322).
// Base types (`Field`/`HasField`/`List`/`number`/`string`/`boolean`) are ambient from
// ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// (@ obj key) is a precise field read (literal extends the brand; never any)
expectTypeOf(__arr["@"]({ name: "a", age: 30 } as const, "name")).toExtend<string>();
expectTypeOf(__arr["@"]({ name: "a", age: 30 } as const, "name")).not.toBeAny();
expectTypeOf(__arr["@"]({ name: "a", age: 30 } as const, "age")).toExtend<number>();
expectTypeOf(__arr["@"]({ name: "a", age: 30 } as const, "age")).not.toBeAny();

// (@? obj key) is an OPEN presence check → boolean exactly
expectTypeOf(__arr["@?"]({ name: "a" } as const, "name")).toEqualTypeOf<boolean>();

// (@keys obj) → the object's own key strings as a list
expectTypeOf(__arr["@keys"]({ name: "a", age: 30 } as const)).toEqualTypeOf<List<string>>();

// @ts-expect-error mis-keyed field — `badkey` is not a key of the object (2345)
__arr["@"]({ name: "a", age: 30 } as const, "badkey");
// @ts-expect-error wrong-typing the precise result — `age` is number, not string (2322)
const s: string = __arr["@"]({ name: "a", age: 30 } as const, "age");
// @ts-expect-error @keys takes an object, not a primitive
__arr["@keys"](42);
