// numeric.test-d.ts — TYPE-LEVEL proofs for the numeric-pack Contract precision fix.
//
// `bind` (numeric.ts) used to degrade EVERY one of the pack's 81 ops' outer
// `symbol.native` Contract to `{ input: z.array(z.custom<unknown>()), output: [z.custom<unknown>()] }`,
// discarding the op's own precise `NumSpec` (`in`/`inRest`/`out` — the six `NCodec`s
// carved at the top of numeric.ts). This file proves the FIXED codec→zod bridge
// produces schemas whose DECODED types are precise, for one representative op per
// NumSpec shape found in the pack.
//
// `NativeSymbolDef.in`/`.out` erase to `z.ZodTypeAny` on any real EXPORTED capability
// (see `symbol.test-d.ts`'s "apply's own declared shape" note) — so, mirroring that
// established convention exactly, each proof below is a SYNTHETIC contract mirroring
// the op's real declared shape (built from the SAME `scheme-zod.ts` schemas the pack's
// codec bridge maps to), not a probe of the erased runtime export. The "did the fix
// actually land on the real 81 ops" proof — which NEEDS a runtime check, since the
// static erasure above makes it type-unobservable — lives in the sibling
// `numeric-contract-precision.test.ts`.
//
// AnyNum has no single scheme-zod schema (number-only / bigint-only don't cover the union), so
// the pack's codec bridge maps it to an inline `z.union([z.number, z.bigint])` — decodes to
// `number | bigint`. That inline union is mirrored here as `numOrBig`.

import { describe, expectTypeOf, test } from "vitest";
import * as z from "../../../common/scheme-zod.js";
import type { DecodedArgs, DecodedArgsWithRest, DecodedReturn } from "../../../common/symbol.js";
import type { ANumeric } from "../../../values/numbers.js";

// AnyNum's inline pairing (numeric.ts CODEC_SCHEMA) — decodes to `number | bigint`.
const numOrBig = z.union([z.number, z.bigint]);

describe("numeric Contract precision — representative NumSpec shapes decode precisely", () => {
  test("pure-variadic (+): in:[], inRest:SchemeNum, out:SchemeNum — args are ANumeric[], return ANumeric (matches addFn's own (...args: ANumeric[]) => ANumeric)", () => {
    expectTypeOf<DecodedArgsWithRest<[], typeof z.schemeNumber, "scheme">>().toEqualTypeOf<ANumeric[]>();
    expectTypeOf<DecodedReturn<[typeof z.schemeNumber], "scheme">>().toEqualTypeOf<ANumeric>();
  });

  test("fixed-head-plus-rest (-): in:[SchemeNum], inRest:SchemeNum, out:SchemeNum — matches subFn's (first: ANumeric, ...rest: ANumeric[]) => ANumeric", () => {
    expectTypeOf<DecodedArgsWithRest<[typeof z.schemeNumber], typeof z.schemeNumber, "scheme">>().toEqualTypeOf<
      [ANumeric, ...ANumeric[]]
    >();
  });

  test("fixed-2-arity (quotient): in:[Int,Int], out:Int — args are bigint, return bigint (matches quotientFn's (a: bigint, b: bigint) => bigint)", () => {
    expectTypeOf<DecodedArgs<[typeof z.bigint, typeof z.bigint]>>().toEqualTypeOf<[bigint, bigint]>();
    expectTypeOf<DecodedReturn<[typeof z.bigint]>>().toEqualTypeOf<bigint>();
  });

  test("fixed-1-arity over AnyNum (abs): in:[AnyNum], out:AnyNum — number|bigint, NOT unknown (matches absFn's (x: number|bigint) => number|bigint)", () => {
    // AnyNum has no pre-existing single zod schema (number/integer/bigint each cover only ONE
    // side of the number|bigint union) — the pack inlines `z.union([z.number, z.bigint])`.
    expectTypeOf<DecodedArgs<[typeof numOrBig]>>().toEqualTypeOf<[number | bigint]>();
    expectTypeOf<DecodedReturn<[typeof numOrBig]>>().toEqualTypeOf<number | bigint>();
  });

  test("boolean-output predicate (zero?): in:[AnyNum], out:Bool — return boolean, not unknown (matches isZeroFn's (x: number|bigint) => boolean)", () => {
    expectTypeOf<DecodedArgs<[typeof numOrBig]>>().toEqualTypeOf<[number | bigint]>();
    expectTypeOf<DecodedReturn<[typeof z.boolean]>>().toEqualTypeOf<boolean>();
  });

  test("multi-value output (floor/): a 2-tuple output decodes as a [ANumeric, ANumeric] values-vector, not [z.custom<unknown>()]", () => {
    expectTypeOf<DecodedReturn<[typeof z.schemeNumber, typeof z.schemeNumber], "scheme">>().toEqualTypeOf<
      [ANumeric, ANumeric]
    >();
  });
});

describe("numeric Contract precision — regression guard: the shared mechanism stays sound for a non-numeric shape", () => {
  test("apply's own declared shape (lists.ts) is untouched by anything added here — same proof symbol.test-d.ts already carries", () => {
    // Mirrors symbol.test-d.ts's own "apply's own declared shape" test byte-for-byte — a
    // canary that the numeric-pack-local additions (CODEC_SCHEMA, contractFromSpec, the inline
    // z.union([z.number, z.bigint]) AnyNum pairing) cannot have perturbed the shared inputRest mechanism itself.
    expectTypeOf<DecodedArgsWithRest<[typeof z.value], typeof z.value>>().toEqualTypeOf<
      [import("../../../values/types.js").SchemeValue, ...import("../../../values/types.js").SchemeValue[]]
    >();
  });
});
