// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the object-accessor moat (object-accessors.d.ts). expect-type
// assertions over the ambient `__arr`, against `as const` object literals — the
// shape the lens captures for a precise `Dict`, so the reads return LITERAL types
// (`30`, `"a"`). Each literal-returning positive is pinned by a PAIR:
//   • `.toExtend<Brand>()` — the read's literal must extend its brand (catches an
//     arg-rot that swaps the field type, e.g. SNum→SStr); and
//   • `.not.toBeAny()` — `toExtend` is BLIND to `any` (`any` extends everything),
//     so this is the explicit return→any guard. Together they bite both ways.
// Where the result is already an exact brand (key-existence SBool, the literal key
// union) a single `.toEqualTypeOf<T>()` suffices (it rejects `any` on its own).
// Negatives use `// @ts-expect-error`: a mis-key bites at the call (2345), a
// wrong-typed read at the assignment (2322); if the signature rots to `any` the
// line stops erroring and the unused directive becomes the failure.
// Base types (`List`/`SNum`/`SStr`/`SBool`) are ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// one-hop prop read is precise (literal extends the brand; never any)
expectTypeOf(__arr.prop("age", { name: "a", age: 30 } as const)).toExtend<SNum>();
expectTypeOf(__arr.prop("age", { name: "a", age: 30 } as const)).not.toBeAny();
expectTypeOf(__arr.get("name", { name: "a", age: 30 } as const)).toExtend<SStr>();
expectTypeOf(__arr.get("name", { name: "a", age: 30 } as const)).not.toBeAny();

// nested path read threads through depth precisely
expectTypeOf(__arr.path(["a", "b"] as const, { a: { b: 30 } } as const)).toExtend<SNum>();
expectTypeOf(__arr.path(["a", "b"] as const, { a: { b: 30 } } as const)).not.toBeAny();
expectTypeOf(__arr["get-in"](["a", "b"] as const, { a: { b: 30 } } as const)).toExtend<SNum>();
expectTypeOf(__arr["get-in"](["a", "b"] as const, { a: { b: 30 } } as const)).not.toBeAny();

// pick narrows to the chosen sub-record; omit drops a key
expectTypeOf(__arr.pick(["name"] as const, { name: "a", age: 30 } as const)).toExtend<{ name: SStr }>();
expectTypeOf(__arr.pick(["name"] as const, { name: "a", age: 30 } as const)).not.toBeAny();
expectTypeOf(__arr.omit(["name"] as const, { name: "a", age: 30 } as const)).toExtend<{ age: SNum }>();
expectTypeOf(__arr.omit(["name"] as const, { name: "a", age: 30 } as const)).not.toBeAny();

// props is a positional tuple of the read values
expectTypeOf(__arr.props(["name", "age"] as const, { name: "a", age: 30 } as const)).toExtend<readonly [SStr, SNum]>();
expectTypeOf(__arr.props(["name", "age"] as const, { name: "a", age: 30 } as const)).not.toBeAny();

// prop-or falls back to the default type on a missing key
expectTypeOf(__arr["prop-or"](0, "age", { name: "a", age: 30 } as const)).toExtend<SNum>();
expectTypeOf(__arr["prop-or"](0, "age", { name: "a", age: 30 } as const)).not.toBeAny();

// fromPairs reconstructs a precise record (inverse of toPairs)
expectTypeOf(__arr.fromPairs([["ok", true]] as const)).toExtend<{ ok: SBool }>();
expectTypeOf(__arr.fromPairs([["ok", true]] as const)).not.toBeAny();

// has / contains are KEY-existence → SBool exactly (open key ok); keys → literal union
expectTypeOf(__arr.has("anything", { name: "a" } as const)).toEqualTypeOf<SBool>();
expectTypeOf(__arr.contains("name", { name: "a" } as const)).toEqualTypeOf<SBool>();
expectTypeOf(__arr.keys({ name: "a", age: 30 } as const)).toEqualTypeOf<List<"name" | "age">>();

// @ts-expect-error mis-keyed prop — `naem` is not a key
__arr.prop("naem", { name: "a", age: 30 } as const);
// @ts-expect-error wrong-typing a precise prop read — age is SNum, not SStr
const s: SStr = __arr.prop("age", { name: "a", age: 30 } as const);
// @ts-expect-error mis-keyed interior path step collapses to `undefined`, so SNum bites
const z: SNum = __arr.path(["a", "nope"] as const, { a: { b: 30 } } as const);
// @ts-expect-error pick of a non-existent key bites (mis-key)
__arr.pick(["badkey"] as const, { name: "a", age: 30 } as const);
// @ts-expect-error wrong-typing the picked sub-record — name is SStr, not SNum
const p: { name: SNum } = __arr.pick(["name"] as const, { name: "a", age: 30 } as const);
// @ts-expect-error `contains` is KEY-existence (SBool), NOT a value — using it as SStr bites
const v: SStr = __arr.contains("name", { name: "a" } as const);
