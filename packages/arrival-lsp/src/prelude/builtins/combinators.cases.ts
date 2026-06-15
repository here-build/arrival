// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the combinators family (combinators.d.ts) — expect-type
// assertions over the ambient `__arr`. Only the LIVE members remain: `always`,
// `clone`, `repr`, `when`, `unless` (the Ramda-derived `identity`/`id`/`constant`/
// `negate`/`type`/`where` + inline `tap` were cut 2026-06-16 — see the leaf header).
// Base vocab (`List`/`SNum`/`SStr`/`Nil`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// always returns a thunk of the input type — the THUNK CALL is the value
const alwaysThunk = __arr["always"]("x");
expectTypeOf(alwaysThunk()).toExtend<SStr>();
expectTypeOf(alwaysThunk()).not.toBeAny();

// clone preserves element type (exact brand)
expectTypeOf(__arr["clone"]([1, 2] as const as List<SNum>)).toEqualTypeOf<List<SNum>>();

// repr produces a string (exact brand)
expectTypeOf(__arr["repr"](42 as unknown)).toEqualTypeOf<SStr>();

// when / unless return the last body value or nil → T | Nil
expectTypeOf(__arr["when"](true, 1, 2)).toExtend<SNum | Nil>();
expectTypeOf(__arr["when"](true, 1, 2)).not.toBeAny();
expectTypeOf(__arr["unless"](false, "a")).toExtend<SStr | Nil>();
expectTypeOf(__arr["unless"](false, "a")).not.toBeAny();

// @ts-expect-error always returns a thunk, not the bare value
const always_s: SStr = __arr["always"]("x");
