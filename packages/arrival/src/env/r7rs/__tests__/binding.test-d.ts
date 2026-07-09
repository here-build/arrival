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
// runtime export.
//
// UPDATE (uniform-scheme-zod-vocabulary redesign, 2026-07-06/07): `z.unknown()` is no longer
// exported from scheme-zod at all — every genuinely-scheme-value slot uses `z.value` now (the
// codebase-wide sweep). The "OLD shape" proofs below stand in `z.custom<unknown>()` — a real,
// still-exported schema whose `z.output` is exactly `unknown`, byte-identical to what
// `z.unknown()` decoded to — so the historical contrast (bare `unknown` vs. `SchemeValue`)
// stays provable without referencing a removed export.
//
// call-with-values's output ALSO moved off its intermediate `z.undefinedResult` shape (a REAL
// bug: R7RS call-with-values returns the consumer's result, never void — see binding.ts's own
// fix comment) onto `z.value`, matching `values`'s own contract. The `maybeThen` return-type
// gap this file used to document (a bare cast would be needed to narrow it) is resolved the
// same way `rosetta.ts`'s `rawImpl` / this session's other erasure-boundary casts are: an
// INERT assertion (true by construction — the callback only ever produces `applyCallback`'s
// result) at the one call site, not a lie about the contract.

import { describe, expectTypeOf, test } from "vitest";
import * as z from "../../../common/scheme-zod.js";
import { symbol, type DecodedArgs, type DecodedReturn } from "../../../common/symbol.js";
import type { SchemeValue } from "../../../values/types.js";

describe("scheme/r7rs/binding Contract precision — values", () => {
  // OLD-shape row DELETED (2026-07-08 test-invariant-atlas sweep, [P16]
  // docs/test-invariant-atlas/verdicts/env.md, docs/test-suite-v2/REMOVAL-MANIFEST.md
  // §B "env test-d museum rows"): decoded a retired synthetic schema, documentation-as-test
  // with no reachable production path. The NEW-side row below (matching numeric.test-d.ts's
  // converged NEW-side-only shape) is the load-bearing proof.
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

  test("output is z.value — call-with-values RETURNS the consumer's result (R7RS never discards)", () => {
    // Mirrors call-with-values's CORRECTED contract shape: output: [z.value]. The intermediate
    // `z.undefinedResult` shape (claiming "void") was a real bug the readonly-slot strictness
    // pass surfaced — see binding.ts's fix comment. `z.unknown()`, the shape this proof once
    // pinned, is no longer even expressible (dropped from scheme-zod's surface entirely by the
    // uniform-vocabulary sweep) — z.value is now both the honest AND the only available choice.
    expectTypeOf<DecodedReturn<[typeof z.value]>>().toEqualTypeOf<SchemeValue>();
  });
});
