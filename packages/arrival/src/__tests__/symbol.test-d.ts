// symbol — TYPE-LEVEL PROOFS for the `arrival.symbol*` contract machinery.
//
// The load-bearing inference of the symbol API: a contract's zod tuple drives BOTH the
// decoded impl-arg types (`DecodedArgs`) and the decoded return type (`DecodedReturn`), so
// a wrong-typed impl is a COMPILE error. These assertions used to live inline in
// `src/common/symbol.ts` as a `type _Assert = …` block, because both package tsconfigs
// EXCLUDE the test dirs (`src/**/*.test.ts`, `src/__*__/**/*`) — so a plain `*.test.ts`
// would never be typechecked. This file is a `*.test-d.ts` run under `vitest --typecheck`
// (see `vitest.typecheck.config.ts` + `tsconfig.typecheck.json`, which un-exclude it), so
// the proofs now fail CI as a real test on any type regression instead of riding the build.
//
// POSITIVE proofs use `expectTypeOf().toEqualTypeOf()`. NEGATIVE proofs (a wrong-typed impl
// must NOT compile) use `@ts-expect-error` over the live constructors — vitest's typecheck
// mode honors `@ts-expect-error`, so each marked line reds if it ever starts compiling.

import { describe, expectTypeOf, test } from "vitest";
import * as z from "../common/scheme-zod.js";
import { symbol, type DecodedArgs, type DecodedReturn } from "../common/symbol.js";
import type { APair } from "../values/primitives/APair.js";

describe("symbol contract — decoded arg/return inference", () => {
  test("native: an identity-schema tuple infers the impl arg as the SCHEME TERM", () => {
    // `z.pair` is scheme-identity (`z.output = APair`); native impls work on scheme values.
    expectTypeOf<DecodedArgs<[typeof z.pair]>>().toEqualTypeOf<[APair]>();
  });

  test("rosetta: a codec tuple infers the impl arg as the DECODED JS value", () => {
    // `z.string` is a codec (`AString` ↔ `string`); rosetta impls work in JS-land.
    expectTypeOf<DecodedArgs<[typeof z.string]>>().toEqualTypeOf<[string]>();
  });

  test("the number family decodes to the codec's declared JS type", () => {
    expectTypeOf<DecodedArgs<[typeof z.number]>>().toEqualTypeOf<[number]>();
    expectTypeOf<DecodedArgs<[typeof z.bigint]>>().toEqualTypeOf<[bigint]>();
  });

  test("a 1-tuple output collapses to a SINGLE decoded return", () => {
    // The 1-tuple-collapse: `[schema]` output → the impl returns the bare value (we wrap it
    // as a 1-element values-list), NOT a 1-tuple.
    expectTypeOf<DecodedReturn<[typeof z.number]>>().toEqualTypeOf<number>();
  });

  test("variadic: an array-ish (z.array) input → the element-array as the impl's rest params", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<typeof z.number>>>>().toEqualTypeOf<number[]>();
  });
});

describe("symbol contract — wrong-typed impls must NOT compile", () => {
  // Guarded by a `false` const so the constructors never run — these are type-only proofs.
  // Each `@ts-expect-error` asserts the line BELOW it does not typecheck; the generic
  // constructor inference (contract → decoded impl signature) is the proof under test.
  const RUN = false as boolean;

  test("native impl receives a Pair (identity), not a string", () => {
    if (RUN) {
      symbol.native`p: proof`(
        { input: [z.pair], output: [z.pair] },
        // @ts-expect-error — arg is Pair, annotating it string is wrong
        (p: string) => p as unknown as APair,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });

  test("rosetta impl receives a decoded string, not a Pair", () => {
    if (RUN) {
      symbol.rosetta`r: proof`(
        { input: [z.string], output: [z.number] },
        // @ts-expect-error — arg is string, annotating it Pair is wrong
        (s: APair) => 1,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });

  test("rosetta return: the output codec wants number; returning the string arg is wrong", () => {
    if (RUN) {
      symbol.rosetta`rr: proof`(
        { input: [z.string], output: [z.number] },
        // @ts-expect-error — return must be number, not string
        (s) => s,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});
