// vectors.test-d.ts — TYPE-LEVEL proofs for the scheme/vectors Contract-precision audit.
//
// vectors.ts had six declarations whose Contract was looser than their own impl bodies (and
// this file's OWN sibling declarations) already assume:
//   - `vector`'s elements were `z.array(z.unknown())` where the file's own `make-vector`
//     already uses the precise `z.value` for its fill slot (the typed z.unknown() replacement —
//     same runtime acceptance, precise STATIC output `SchemeValue`).
//   - `vector-append`'s elements and `vector-ref`'s vec arg were bare `z.unknown()`/
//     `z.array(z.unknown())` where every OTHER accessor in this file (vector-length/
//     vector-copy/vector->string/list->vector/…) already uses `z.svector`.
//   - `vector-ref`/`vector->list`'s RETURN was `z.unknown()` where `z.value` is the precise
//     identity schema for "any scheme value, representation-blind by design".
//   - `vector-map`/`vector-for-each` bundled their variadic vectors into ONE combined
//     `z.tuple([head], z.unknown())` `input` rather than splitting the fixed proc head from an
//     `inputRest: z.svector` tail — the mechanism `apply` (lists.ts) and the 2026-07-05
//     for-each/string-map/string-for-each migration already use (see symbol.test-d.ts's own
//     "2026-07-05 audit" section, which this mirrors).
//
// `NativeSymbolDef.in`/`.out` erase to plain `z.ZodTypeAny` on any REAL exported capability
// (the established convention — see symbol.test-d.ts's "apply's own declared shape" note and
// numeric.test-d.ts's identical framing), so every proof below is a SYNTHETIC contract
// mirroring vectors.ts's own real declared shape (built from the SAME scheme-zod.ts schemas
// the pack uses), not a probe of the erased runtime export.
//
// The runtime-observable half of this fix (does the REAL exported op's schema actually reject
// a wrongly-shaped value?) lives in the sibling `vectors-contract-precision.test.ts` — and ONLY
// for the z.svector-backed fixes. `z.value` (`z.custom<SchemeValue>()`, no predicate) accepts
// anything at runtime BYTE-IDENTICAL to the `z.unknown()` it replaces (calibrated empirically
// against the pinned zod 4.3.6 — see scheme-zod.ts's own doc comment on `value`), so `vector`'s
// elements and `vector-ref`/`vector->list`'s returns are STATIC-ONLY precision gains — provable
// only here, at the type level.
import { describe, expectTypeOf, test } from "vitest";
import * as z from "../../../common/scheme-zod.js";
import { symbol, type DecodedArgs, type DecodedArgsWithRest, type DecodedReturn } from "../../../common/symbol.js";
import type { AVector } from "../../../values/primitives/AVector.js";
import type { AExact } from "../../../values/primitives/AExact.js";
import type { AInexact } from "../../../values/primitives/AInexact.js";
import type { SchemeValue } from "../../../values/types.js";

describe("scheme/vectors Contract precision — element/return precision (z.unknown() → z.value/z.svector)", () => {
  test("vector: OLD z.array(z.unknown()) decoded FLAT unknown[] — no element precision", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<ReturnType<typeof z.unknown>>>>>().toEqualTypeOf<unknown[]>();
  });

  test("vector: NEW z.array(z.value) decodes SchemeValue[], matching the impl's own (...objs: SchemeValue[]) body — and make-vector's own fill-slot convention", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<typeof z.value>>>>().toEqualTypeOf<SchemeValue[]>();
  });

  test("vector-append: OLD z.array(z.unknown()) decoded FLAT unknown[]", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<ReturnType<typeof z.unknown>>>>>().toEqualTypeOf<unknown[]>();
  });

  test("vector-append: NEW z.array(z.svector) decodes AVector[] — matches every OTHER accessor's z.svector convention in this file", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<typeof z.svector>>>>().toEqualTypeOf<AVector[]>();
  });

  test("vector-ref: OLD input [z.unknown(), z.schemeNumber] decoded [unknown, AExact|AInexact] — vec arg imprecise", () => {
    expectTypeOf<DecodedArgs<[ReturnType<typeof z.unknown>, typeof z.schemeNumber]>>().toEqualTypeOf<
      [unknown, AExact | AInexact]
    >();
  });

  test("vector-ref: NEW input [z.svector, z.schemeNumber] decodes [AVector, AExact|AInexact], not [unknown, …]", () => {
    expectTypeOf<DecodedArgs<[typeof z.svector, typeof z.schemeNumber]>>().toEqualTypeOf<[AVector, AExact | AInexact]>();
  });

  test("vector-ref / vector->list: OLD output [z.unknown()] collapses to a bare `unknown` return", () => {
    expectTypeOf<DecodedReturn<[ReturnType<typeof z.unknown>]>>().toEqualTypeOf<unknown>();
  });

  test("vector-ref / vector->list: NEW output [z.value] collapses to a bare `SchemeValue` return — representation-blind by design, not unknown", () => {
    expectTypeOf<DecodedReturn<[typeof z.value]>>().toEqualTypeOf<SchemeValue>();
  });
});

describe("scheme/vectors Contract precision — vector-map/vector-for-each: combined tuple → head+inputRest split", () => {
  const procHead = z.custom<(...args: unknown[]) => SchemeValue>();

  test("OLD shape: a SINGLE combined z.tuple([head], z.unknown()) as `input` (no inputRest) — rest decodes unknown[], no vector precision", () => {
    const oldShape = z.tuple([procHead], z.unknown());
    expectTypeOf<DecodedArgs<typeof oldShape>>().toEqualTypeOf<[(...args: unknown[]) => SchemeValue, ...unknown[]]>();
  });

  test("NEW shape: input:[head], inputRest: z.svector — rest decodes AVector[], mirrors for-each/string-map's own inputRest migration", () => {
    expectTypeOf<DecodedArgsWithRest<[typeof procHead], typeof z.svector>>().toEqualTypeOf<
      [(...args: unknown[]) => SchemeValue, ...AVector[]]
    >();
  });
});

describe("scheme/vectors Contract precision — negative proof", () => {
  test("vector-map/vector-for-each: a wrong-typed rest element must NOT compile", () => {
    const RUN = false as boolean;
    if (RUN) {
      symbol.native`vm: proof`(
        { input: [z.custom<(...args: unknown[]) => SchemeValue>()], inputRest: z.svector, output: [z.svector] },
        // @ts-expect-error — rest args decode via z.svector (AVector), annotating them string is wrong
        (proc: (...args: unknown[]) => SchemeValue, ...vectors: string[]): AVector => {
          void proc;
          void vectors;
          return vectors as unknown as AVector;
        },
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});

describe("scheme/vectors Contract precision — regression guard: the shared mechanism stays sound for a non-vector shape", () => {
  test("apply's own declared shape (lists.ts) is untouched by anything added here — same proof symbol.test-d.ts/numeric.test-d.ts already carry", () => {
    expectTypeOf<DecodedArgsWithRest<[typeof z.value], typeof z.value>>().toEqualTypeOf<[SchemeValue, ...SchemeValue[]]>();
  });
});
