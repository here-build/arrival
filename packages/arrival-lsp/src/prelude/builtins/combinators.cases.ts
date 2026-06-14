// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the combinators family (combinators.d.ts) — expect-type
// assertions over the ambient `__arr`. Inputs are WIDENED literals (`42`, `'x'`)
// so the generic `identity`/`id`/`always`/`tap` thread a LITERAL through `T`;
// those literal-returning positives are pinned by the PAIR `.toExtend<Brand>()`
// + `.not.toBeAny()` (toExtend is blind to `any`; not.toBeAny is the return→any
// guard). Where the signature pins an exact brand (`negate`→SNum, `type`/`repr`
// →SStr, `clone`/`where`→List<T>) a single `.toEqualTypeOf<T>()` suffices.
//
// ★ Precedence corrections carried from the leaf header (do not "fix"):
//   • `negate` is the RAMDA ARITHMETIC `(n)=>-n` → SNum→SNum (NOT boolean R.negate).
//   • `where` aliases `R.filter` (raw) → plain (pred, list) filtering, NOT R.where.
//   • `tap` is CURRIED: `(fn) => (x) => x` — note the two-stage call.
//   • `when`/`unless` are the inline sandbox approximations returning `T | Nil`.
// Base vocab (`List`/`SNum`/`SStr`/`Nil`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// identity / id thread the input type (literal through T)
expectTypeOf(__arr["identity"](42)).toExtend<SNum>();
expectTypeOf(__arr["identity"](42)).not.toBeAny();
expectTypeOf(__arr["id"]("x")).toExtend<SStr>();
expectTypeOf(__arr["id"]("x")).not.toBeAny();

// always / constant return a thunk of the input type — the THUNK CALL is the value
const alwaysThunk = __arr["always"]("x");
expectTypeOf(alwaysThunk()).toExtend<SStr>();
expectTypeOf(alwaysThunk()).not.toBeAny();
const constantThunk = __arr["constant"](42);
expectTypeOf(constantThunk()).toExtend<SNum>();
expectTypeOf(constantThunk()).not.toBeAny();

// negate is numeric (exact SNum)
expectTypeOf(__arr["negate"](5)).toEqualTypeOf<SNum>();

// tap is curried: (fn) => (x) => x — the returned function threads the input type
expectTypeOf(__arr["tap"]((x: SNum) => {})(5)).toExtend<SNum>();
expectTypeOf(__arr["tap"]((x: SNum) => {})(5)).not.toBeAny();

// clone preserves element type (exact brand)
expectTypeOf(__arr["clone"]([1, 2] as const as List<SNum>)).toEqualTypeOf<List<SNum>>();

// type / repr produce strings (exact brand)
expectTypeOf(__arr["type"](42 as unknown)).toEqualTypeOf<SStr>();
expectTypeOf(__arr["repr"](42 as unknown)).toEqualTypeOf<SStr>();

// where filters, preserving element type (exact brand)
expectTypeOf(__arr["where"]((x: SNum) => x > 0, [1, -1] as const as List<SNum>)).toEqualTypeOf<List<SNum>>();

// when / unless return the last body value or nil → T | Nil
expectTypeOf(__arr["when"](true, 1, 2)).toExtend<SNum | Nil>();
expectTypeOf(__arr["when"](true, 1, 2)).not.toBeAny();
expectTypeOf(__arr["unless"](false, "a")).toExtend<SStr | Nil>();
expectTypeOf(__arr["unless"](false, "a")).not.toBeAny();

// @ts-expect-error negate is numeric — a string arg bites
__arr["negate"]("x");
// @ts-expect-error identity threads type — SNum result is not SStr
const ident_s: SStr = __arr["identity"](42);
// @ts-expect-error always returns a thunk, not the bare value
const always_s: SStr = __arr["always"]("x");
// @ts-expect-error tap callback param type is threaded — using x as SStr inside bites
__arr["tap"]((x: SNum) => { const s: SStr = x; })(5);
// @ts-expect-error where predicate param is threaded from the list element type
__arr["where"]((x: SStr) => x, [1, 2] as const as List<SNum>);
