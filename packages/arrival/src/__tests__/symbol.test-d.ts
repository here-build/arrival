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
import { symbol, type DecodedArgs, type DecodedArgsWithRest, type DecodedReturn } from "../common/symbol.js";
import type { APair } from "../values/primitives/APair.js";
import type { ANil } from "../values/primitives/ANil.js";
import type { AString } from "../values/primitives/AString.js";
import type { SchemeValue } from "../values/types.js";

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

describe("symbol contract — inputRest: a fixed head + a separately-typed variadic tail", () => {
  test("mechanism: head and rest genuinely differ in type — proves the split is real, not coincidental", () => {
    expectTypeOf<DecodedArgsWithRest<[typeof z.string], typeof z.number>>().toEqualTypeOf<[string, ...number[]]>();
  });

  test("native-identity flavored: a Pair head + a SchemeValue (z.value) rest", () => {
    expectTypeOf<DecodedArgsWithRest<[typeof z.pair], typeof z.value>>().toEqualTypeOf<[APair, ...SchemeValue[]]>();
  });

  test("no rest (Rest defaults to undefined) is BYTE-IDENTICAL to today's DecodedArgs<I> — the additive guarantee", () => {
    expectTypeOf<DecodedArgsWithRest<[typeof z.pair]>>().toEqualTypeOf<DecodedArgs<[typeof z.pair]>>();
    expectTypeOf<DecodedArgsWithRest<[typeof z.pair]>>().toEqualTypeOf<[APair]>();
    expectTypeOf<DecodedArgsWithRest<[typeof z.string]>>().toEqualTypeOf<DecodedArgs<[typeof z.string]>>();
    expectTypeOf<DecodedArgsWithRest<[typeof z.string]>>().toEqualTypeOf<[string]>();
  });

  test("apply's own declared shape: a SchemeValue head + a SchemeValue... tail", () => {
    // Mirrors apply's real migrated contract exactly: { input: [z.value], inputRest: z.value, output: [z.value] }.
    // (Native SymbolDef erases the concrete Contract type on its return, so the real bound `apply`
    // export can't be re-inspected at the type level — this synthetic contract IS apply's declared
    // shape, proving the mechanism computes the right decoded-args type for it.)
    expectTypeOf<DecodedArgsWithRest<[typeof z.value], typeof z.value>>().toEqualTypeOf<[SchemeValue, ...SchemeValue[]]>();
  });

  test("wrong-typed rest param must NOT compile", () => {
    const RUN = false as boolean;
    if (RUN) {
      symbol.rosetta`headtail: proof`(
        { input: [z.string], inputRest: z.number, output: [z.string] },
        // @ts-expect-error — rest args decode via z.number (JS number), annotating them string is wrong
        (head: string, ...rest: string[]) => head,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-07-05 audit: five declaration-precision fixes (for-each / string-map /
// string-for-each / filter / typecheck). Each proof below mirrors the REAL migrated
// contract shape synthetically (NativeSymbolDef/SequenceSymbolDef erase `I`/`O` on any
// real export — see the "apply's own declared shape" note above), proving the
// mechanism computes the right decoded type for the actual declaration each op now uses.
//
// CONVENTION NOTE: for-each/string-map/string-for-each/filter's proc/pred HEAD position
// uses the callable-schema style `z.custom<(...args: unknown[]) => T>()` — the
// established convention for "this position is invoked as a JS-callable" (vector-map's
// proc, vector-for-each's proc, curry's fn, call-with-values's producer/consumer,
// member/assoc's compare predicate all already use this shape: 7 call sites across 4
// files). `apply`'s plain `z.value` head is the outlier — its own doc comment frames
// that choice as "both happen to be z.value here" (illustrating the head/rest SPLIT,
// not a deliberate "callables are z.value" rule), and apply's body does its own runtime
// `typecheck(...,"function")` + narrowing rather than leaning on the schema for shape.
// ─────────────────────────────────────────────────────────────────────────────
describe("symbol contract — 2026-07-05 audit: for-each / string-map / string-for-each head+rest precision", () => {
  const forEachHead = z.custom<(...args: unknown[]) => SchemeValue>();
  const listRest = z.union([z.pair, z.nil]);

  test("OLD for-each shape (z.array(z.value)) decoded FLAT — no head/tail distinction", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<typeof z.value>>>>().toEqualTypeOf<SchemeValue[]>();
  });

  test("NEW for-each shape: [callable, ...list[]] — a Pair|Nil rest, not a flat array", () => {
    // Mirrors for-each's real migrated contract: { input: [z.custom<...>()], inputRest: z.union([z.pair, z.nil]), output: [z.void()] }.
    expectTypeOf<DecodedArgsWithRest<[typeof forEachHead], typeof listRest>>().toEqualTypeOf<
      [(...args: unknown[]) => SchemeValue, ...(APair | ANil)[]]
    >();
  });

  const stringHOFHead = z.custom<(...args: unknown[]) => unknown>();

  test("OLD string-map/string-for-each shape (z.array(z.unknown())) decoded FLAT unknown[]", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<ReturnType<typeof z.unknown>>>>>().toEqualTypeOf<unknown[]>();
  });

  test("NEW string-map/string-for-each shape: [callable, ...AString[]], not flat unknown[]", () => {
    // Mirrors both ops' real migrated contract: { input: [z.custom<...>()], inputRest: z.schemeString, output: [...] }.
    expectTypeOf<DecodedArgsWithRest<[typeof stringHOFHead], typeof z.schemeString>>().toEqualTypeOf<
      [(...args: unknown[]) => unknown, ...AString[]]
    >();
  });
});

describe("symbol contract — 2026-07-05 audit: filter's contract narrows to a fixed 2-tuple", () => {
  test("OLD shape: z.tuple(fixed, rest) — a SINGLE array-ish schema — decodes OPEN-ENDED", () => {
    const oldShape = z.tuple([z.unknown()], z.unknown());
    expectTypeOf<DecodedArgs<typeof oldShape>>().toEqualTypeOf<[unknown, ...unknown[]]>();
  });

  test("NEW shape: a bare 2-element array literal decodes to a FIXED [pred, seq] tuple", () => {
    // Mirrors filter's real migrated contract: { input: [predSchema, z.value], output: [z.unknown()], fanout: true }.
    const predSchema = z.custom<(...args: unknown[]) => unknown>();
    expectTypeOf<DecodedArgs<[typeof predSchema, typeof z.value]>>().toEqualTypeOf<
      [(...args: unknown[]) => unknown, SchemeValue]
    >();
  });
});

describe("symbol contract — 2026-07-05 audit: typecheck's contract narrows to a fixed 4-tuple (3 required + 1 optional)", () => {
  const s1 = z.custom<{ valueOf(): unknown }>();
  const s3 = z.custom<{ valueOf(): unknown } | Function>();
  const s4 = z.custom<number | null>().optional();

  test("OLD shape: z.tuple(fixed-3, rest) decodes to an UNBOUNDED tail, not a genuinely-optional 4th", () => {
    const oldShape = z.tuple([s1, z.unknown(), s3], s4);
    // The old shape's rest was `z.custom<number|null>()` WITHOUT `.optional()` (unbounded 0+ tail
    // of that element type) — its decoded type is an array tail, not a single optional slot.
    expectTypeOf<DecodedArgs<typeof oldShape>>().toEqualTypeOf<
      [{ valueOf(): unknown }, unknown, { valueOf(): unknown } | Function, ...(number | null | undefined)[]]
    >();
  });

  test("NEW shape: a plain 4-element array — the 4th slot's VALUE admits undefined, but there are EXACTLY 4 positions", () => {
    // Mirrors typecheck's real migrated contract exactly (2nd slot z.value per the audit's other fix).
    expectTypeOf<DecodedArgs<[typeof s1, typeof z.value, typeof s3, typeof s4]>>().toEqualTypeOf<
      [{ valueOf(): unknown }, SchemeValue, { valueOf(): unknown } | Function, number | null | undefined]
    >();
  });

  test("a 5th argument no longer compiles — the old unbounded-rest gap is closed", () => {
    const RUN = false as boolean;
    if (RUN) {
      symbol.native`tc: proof`(
        { input: [s1, z.value, s3, s4], output: [z.void()] },
        // @ts-expect-error — the contract is a fixed 4-tuple; a 5th param has no corresponding decoded arg
        (a, b, c, d, e) => {
          void a;
          void b;
          void c;
          void d;
          void e;
        },
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});

describe("symbol contract — 2026-07-05 audit: negative proofs", () => {
  test("string-map/string-for-each: a wrong-typed rest element must NOT compile", () => {
    const RUN = false as boolean;
    if (RUN) {
      symbol.native`sm: proof`(
        { input: [z.custom<(...args: unknown[]) => unknown>()], inputRest: z.schemeString, output: [z.string] },
        // @ts-expect-error — rest args decode via z.schemeString (AString), annotating them number is wrong
        (proc: (...args: unknown[]) => unknown, ...strings: number[]): string => {
          void proc;
          void strings;
          return "";
        },
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
  // typecheck's 5th-argument negative proof lives in the dedicated describe block above
  // (it needs `s1`/`s3`/`s4` in scope), rather than being duplicated here.
});
