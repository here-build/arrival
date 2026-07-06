// binding.test-d.ts — TYPE-LEVEL proofs for the scheme/r7rs/binding Contract precision
// fix (`values` / `call-with-values`, env/r7rs/binding.ts).
//
// `values` used to declare `{ input: z.array(z.unknown()), output: [z.unknown()] }` —
// the impl's args/return decoded as bare `unknown`, discarding the fact that every arg
// IS a scheme term and the result IS a scheme value (possibly the `Values` multi-value
// carrier — `Values` is itself a member of the `SchemeValue` union in ../../../values/types.ts).
// This file proves the fixed contract (`z.array(z.value)` / `[z.value]`) decodes precisely,
// mirroring numeric.test-d.ts's established convention exactly: `NativeSymbolDef.in`/`.out`
// erase the concrete `I`/`O` on any REAL exported capability (see symbol.test-d.ts's "apply's
// own declared shape" note), so each proof below is a SYNTHETIC contract mirroring the op's
// real declared shape (built from the SAME scheme-zod.ts schemas), not a probe of the erased
// runtime export. The runtime-observable half of numeric/bytevectors/strings/equality's sibling
// audits (a `def.in.safeParse(garbage)` proof) does NOT apply here — see the note below.
//
// NO RUNTIME "*-contract-precision.test.ts" SIBLING: unlike bytevectors/strings/equality's
// fixes (which moved `z.unknown()` → a REFINED `z.instanceof(...)`-backed identity schema with
// real safeParse teeth), `z.value` is `z.custom<SchemeValue>()` with NO refinement — scheme-zod.ts
// documents this explicitly: "accepts anything at runtime (byte-identical to `z.unknown()` —
// and native ops run NO validation anyway), but its STATIC output is `SchemeValue`". So
// `z.array(z.unknown()).safeParse(garbage)` and `z.array(z.value).safeParse(garbage)` accept
// the exact same runtime inputs — there is no red-to-green `safeParse` delta to prove. The
// entire fix here is static (the impl's inferred arg/return types, and the future `.d.ts`
// harvest print), which is exactly what `.test-d.ts` — not a runtime test — is for.
//
// RED-before: none of these schemas are NEW (z.value already existed, used throughout
// lists.ts/lists.ts's `apply`/`list`), so this suite does not fail to COMPILE before the fix
// (unlike numeric.test-d.ts's genuinely-new `z.numberOrBigint`). The real RED for this kind of
// fix is the BUILD break on binding.ts itself the moment the contract tightens ahead of the
// impl signature (native.ts: "a wrong-typed impl is a COMPILE error — that inference is the
// load-bearing proof") — reproduced here as the `@ts-expect-error` negative proof below, and
// captured verbatim (real tsc output) in the accompanying report.

import { describe, expectTypeOf, test } from "vitest";
import * as z from "../../../common/scheme-zod.js";
import { symbol, type DecodedArgs, type DecodedReturn } from "../../../common/symbol.js";
import type { SchemeValue } from "../../../values/types.js";

describe("scheme/r7rs/binding Contract precision — values", () => {
  test("OLD shape (z.array(z.unknown())) decoded flat unknown[] / unknown — no scheme-term precision", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<ReturnType<typeof z.unknown>>>>>().toEqualTypeOf<unknown[]>();
    expectTypeOf<DecodedReturn<[ReturnType<typeof z.unknown>]>>().toEqualTypeOf<unknown>();
  });

  test("NEW shape: z.array(z.value) / [z.value] — args are SchemeValue[], return is SchemeValue (matches Values.from's own fixed signature)", () => {
    // Mirrors values's real migrated contract: { input: z.array(z.value), output: [z.value] }.
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<typeof z.value>>>>().toEqualTypeOf<SchemeValue[]>();
    expectTypeOf<DecodedReturn<[typeof z.value]>>().toEqualTypeOf<SchemeValue>();
  });

  test("wrong-typed impl must NOT compile against the tightened contract — the real RED this fix closes", () => {
    const RUN = false as boolean;
    if (RUN) {
      symbol.native`v: proof`(
        { input: z.array(z.value), output: [z.value] },
        // @ts-expect-error — the contract demands SchemeValue in/out; the old bare
        // `(...args: unknown[]): unknown` shape (what `values` declared before this fix)
        // no longer satisfies it. This is the exact TS2345 binding.ts hit mid-fix.
        (...args: unknown[]): unknown => args[0],
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});

describe("scheme/r7rs/binding Contract precision — call-with-values", () => {
  // The established callable-schema convention (symbol.test-d.ts's 2026-07-05 audit note:
  // vector-map/vector-for-each's proc, curry's fn, for-each/string-map/string-for-each's head,
  // member/assoc's compare, and call-with-values's own producer/consumer all take this shape) —
  // `unknown` both ways, NOT the disabling `any` the migration originally carried over from the
  // untyped stdlib `doc({ value })` form (binding.ts's local `SchemeFunction` alias, fixed
  // alongside this audit).
  const callable = z.lambda;

  test("producer/consumer decode as (...args: unknown[]) => unknown — precise, not any-typed", () => {
    // Checked per-position (not as one combined tuple literal) — expectTypeOf's overload
    // resolution trips on a 2-tuple of two IDENTICAL function types ("Expected 1 arguments,
    // but got 0"), a library quirk unrelated to the mechanism under test; decomposing sidesteps
    // it while proving the exact same thing.
    type Decoded = DecodedArgs<[typeof callable, typeof callable]>;
    expectTypeOf<Decoded[0]>().toEqualTypeOf<(...args: unknown[]) => unknown>();
    expectTypeOf<Decoded[1]>().toEqualTypeOf<(...args: unknown[]) => unknown>();
    expectTypeOf<Decoded["length"]>().toEqualTypeOf<2>();
  });

  test("output STAYS z.unknown() — the real, verified, honest type (not a gap)", () => {
    // Mirrors call-with-values's real (unchanged) contract shape: output: [z.unknown()].
    // Tightening this to z.value was TRIED (see the report's tsc transcript) and reds at the
    // `return unpromise(...)` line — `unpromise` (utils/promises.ts) is a genuinely-generic,
    // widely-shared helper (also used by srfi-1's fold) whose own honest signature returns
    // `unknown`; narrowing this call site would need either a bare cast (banned — see the
    // project's honest-types-no-casts convention) or making the SHARED unpromise utility
    // generic (a cross-cutting change well outside this ONE capability). `z.unknown()` here is
    // the correct, verified type — this proof pins that decision so a future pass doesn't
    // re-flag it without re-verifying.
    expectTypeOf<DecodedReturn<[ReturnType<typeof z.unknown>]>>().toEqualTypeOf<unknown>();
  });
});
