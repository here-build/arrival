// symbol.test.ts — the `arrival.symbol*` API.
//
// TEST-FIRST proof surface for env/symbol.ts + env/scheme-zod.ts. Two planes:
//   • RUNTIME (vitest): codec decode/encode, the number-codec family, validation
//     rejection (errors-as-doors), gating, native-runs-no-validation, async,
//     variadic, multiple-values, notImplemented → door.
//   • TYPE (compile-time): the generic inference proofs live in env/symbol.ts itself
//     (it is the file `pnpm typecheck` actually compiles — *.test.ts is excluded from
//     both tsconfigs). The `@ts-expect-error` lines below DOCUMENT the same proofs and
//     are enforced by an explicit `tsc` over this file during verification.

import { describe, it, expect, expectTypeOf } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import * as arrival from "../common/symbol.js";
import { testCallCtx } from "../common/symbol.js";
import * as z from "../common/scheme-zod.js";
import { APair } from "../values/primitives/APair.js";
import { AValue } from "../values/primitives/AValue.js";
import { AString } from "../values/primitives/AString.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { nil } from "../values/primitives/ANil.js";

const { symbol } = arrival;

describe("symbol.native — scheme-identity, no validation", () => {
  it("infers the impl arg+return as SCHEME VALUES from identity schemas", () => {
    const def = symbol.native`pair-id: identity on a pair`(
      { input: [z.pair], output: [z.pair] },
      (p) => {
        // z.pair is cons(value, value) where value is z.value (AValue codec). The decoded
        // param type is `APair<AValue, AValue>` — AValue satisfies SchemeValue and preserves
        // the withProvenance method signature (unlike `any`/`unknown`).
        expectTypeOf(p).toEqualTypeOf<APair<AValue, AValue>>();
        return p;
      },
    );
    expect(def.kind).toBe("native");
    expect(def.name).toBe("pair-id");
    expect(def.doc).toBe("identity on a pair");
  });

  it("runs the impl on the raw scheme term with NO decode/validate", () => {
    const def = symbol.native`car-ish: first of a pair`(
      { input: [z.pair], output: [z.string] },
      (p) => p.car as AString,
    );
    const arg = new APair(CONSTANT_CTX, new AString(CONSTANT_CTX, "hello"), nil);
    // native.impl is the binding itself — it receives the scheme value directly.
    const out = def.impl(arg);
    expect(out).toBeInstanceOf(AString);
    expect((out as AString)["arrival/toJS"]()).toBe("hello");
  });

  it("does NOT reject a value the identity schema wouldn't accept (no runtime validation)", () => {
    const def = symbol.native`as-is: passthrough`({ input: [z.pair], output: [z.pair] }, (p) => p);
    // A NON-Pair would fail a zod parse, but native never parses — it just runs.
    const notAPair = { car: 1, cdr: 2 } as unknown as APair<any, any>;
    expect(() => def.impl(notAPair)).not.toThrow();
  });
});

describe("symbol.rosetta — JS-land, codec decode/encode", () => {
  it("infers the impl arg+return as DECODED JS values from codecs", () => {
    const def = symbol.rosetta`strlen: length of a string`(
      { input: [z.string], output: [z.number] },
      (s) => {
        expectTypeOf(s).toEqualTypeOf<string>();
        return s.length;
      },
    );
    expect(def.kind).toBe("rosetta");
    expect(def.name).toBe("strlen");
  });

  it("decodes scheme args → JS, runs impl, encodes return → scheme", async () => {
    const def = symbol.rosetta`strlen: length of a string`(
      { input: [z.string], output: [z.number] },
      (s) => s.length,
    );
    const out = await def.run.call(testCallCtx(), new AString(CONSTANT_CTX, "hello"));
    // output codec is z.number → encode(number) = SchemeInexact (the chosen float type).
    expect(out).toBeInstanceOf(AInexact);
    expect((out as AInexact).real).toBe(5);
  });

  it("rejects a bad arg via the input codec (errors-as-doors)", async () => {
    const def = symbol.rosetta`strlen: length of a string`(
      { input: [z.string], output: [z.number] },
      (s) => s.length,
    );
    // A SchemeExact is not a SchemeString → the z.string codec's instanceof guard doors.
    await expect(def.run.call(testCallCtx(), new AExact(CONSTANT_CTX, 3n))).rejects.toThrow();
  });

  it("can SKIP validation (trusted call site) but still runs the codec transform", async () => {
    const def = symbol.rosetta`echo: identity string`(
      { input: [z.string], output: [z.string] },
      (s) => s,
      { validate: false },
    );
    const out = await def.run.call(testCallCtx(), new AString(CONSTANT_CTX, "x"));
    expect(out).toBeInstanceOf(AString);
    expect((out as AString)["arrival/toJS"]()).toBe("x");
  });

  it("awaits an async impl", async () => {
    const def = symbol.rosetta`async-up: async uppercase`(
      { input: [z.string], output: [z.string] },
      async (s) => {
        await Promise.resolve();
        return s.toUpperCase();
      },
    );
    const out = await def.run.call(testCallCtx(), new AString(CONSTANT_CTX, "hi"));
    expect((out as AString)["arrival/toJS"]()).toBe("HI");
  });
});

describe("`this: CallCtx` is mandatory (R-CTX-3) — misuse THROWS, never silently CONSTANT_CTX", () => {
  // The R-CTX-3 migration door retired 2026-07-10 (V's strictness sweep): `this: CallCtx`
  // is enforced STATICALLY (an unbound call is a compile error at every typed call site),
  // and makeCallCtx/testCallCtx never yield nullable fields. What these rows now pin is
  // the surviving INVARIANT — JS-level misuse (Reflect.apply past the types) still throws
  // LOUDLY instead of silently degrading to CONSTANT_CTX (the silent fallback hid the
  // B2-rosetta mint regression until conservation.law caught it).
  it("a bare `def.run(...)` call (no receiver) throws instead of silently defaulting", async () => {
    const def = symbol.rosetta`strlen: length of a string`(
      { input: [z.string], output: [z.number] },
      (s) => s.length,
    );
    await expect(Reflect.apply(def.run, undefined, [new AString(CONSTANT_CTX, "hello")])).rejects.toThrow();
  });

  it("an ad hoc `{}` receiver (missing runCtx/invocation) throws the same way", async () => {
    const def = symbol.rosetta`strlen: length of a string`(
      { input: [z.string], output: [z.number] },
      (s) => s.length,
    );
    await expect(Reflect.apply(def.run, {}, [new AString(CONSTANT_CTX, "hello")])).rejects.toThrow();
  });

  it("testCallCtx() is a real CallCtx — the sanctioned idiom never doors", async () => {
    const def = symbol.rosetta`strlen: length of a string`(
      { input: [z.string], output: [z.number] },
      (s) => s.length,
    );
    const out = await def.run.call(testCallCtx(), new AString(CONSTANT_CTX, "hello"));
    expect((out as AInexact).real).toBe(5);
  });
});

describe("the number codec FAMILY — exactness + range + JS-type declared by the codec", () => {
  describe("z.number ↔ JS number (encode → inexact)", () => {
    it("decodes a safe-integer exact and a float inexact to JS number", async () => {
      const def = symbol.rosetta`dbl: double`({ input: [z.number], output: [z.number] }, (n) => n * 2);
      const fromExact = await def.run.call(testCallCtx(), new AExact(CONSTANT_CTX, 21n));
      expect((fromExact as AInexact).real).toBe(42);
      const fromInexact = await def.run.call(testCallCtx(), new AInexact(CONSTANT_CTX, 1.5));
      expect((fromInexact as AInexact).real).toBe(3);
    });

    it("DOORS an over-range exact integer (no silent precision loss)", async () => {
      const def = symbol.rosetta`idn: identity number`({ input: [z.number], output: [z.number] }, (n) => n);
      const huge = new AExact(CONSTANT_CTX, BigInt(Number.MAX_SAFE_INTEGER) + 10n);
      await expect(def.run.call(testCallCtx(), huge)).rejects.toThrow(/safe-integer|faithful JS number/i);
    });

    it("DOORS a non-integer exact rational", async () => {
      const def = symbol.rosetta`idn2: identity number`({ input: [z.number], output: [z.number] }, (n) => n);
      await expect(def.run.call(testCallCtx(), new AExact(CONSTANT_CTX, 1n, 3n))).rejects.toThrow(/faithful JS number|rational/i);
    });
  });

  describe("z.integer ↔ JS number constrained to safe ints (encode → exact)", () => {
    it("decodes a safe int and encodes the return as EXACT", async () => {
      const def = symbol.rosetta`inc: increment`({ input: [z.integer], output: [z.integer] }, (n) => n + 1);
      const out = await def.run.call(testCallCtx(), new AExact(CONSTANT_CTX, 41n));
      expect(out).toBeInstanceOf(AExact);
      expect((out as AExact).num).toBe(42n);
      expect((out as AExact).denom).toBe(1n);
    });

    it("DOORS a non-safe-integer inexact input", async () => {
      const def = symbol.rosetta`idi: identity int`({ input: [z.integer], output: [z.integer] }, (n) => n);
      await expect(def.run.call(testCallCtx(), new AInexact(CONSTANT_CTX, 1.5))).rejects.toThrow(/safe integer/i);
    });
  });

  describe("z.bigint ↔ JS bigint (arbitrary precision, encode → exact)", () => {
    it("decodes to bigint faithfully beyond safe-integer range", async () => {
      const def = symbol.rosetta`bigid: identity bigint`({ input: [z.bigint], output: [z.bigint] }, (n) => n + 1n);
      const big = BigInt(Number.MAX_SAFE_INTEGER) + 100n;
      const out = await def.run.call(testCallCtx(), new AExact(CONSTANT_CTX, big));
      expect(out).toBeInstanceOf(AExact);
      expect((out as AExact).num).toBe(big + 1n);
    });

    it("infers the impl arg as bigint", () => {
      symbol.rosetta`bg: bigint impl`({ input: [z.bigint], output: [z.bigint] }, (n) => {
        expectTypeOf(n).toEqualTypeOf<bigint>();
        return n;
      });
    });

    it("round-trips bigint → scheme → bigint", async () => {
      const def = symbol.rosetta`bid: bigint identity`({ input: [z.bigint], output: [z.bigint] }, (n) => n);
      const out = (await def.run.call(testCallCtx(), new AExact(CONSTANT_CTX, 7n))) as AExact;
      // re-decode the encoded scheme value through the same codec
      const back = z.decode(z.bigint, out);
      expect(back).toBe(7n);
    });
  });
});

describe("variadic + multiple values", () => {
  it("z.array input → variadic impl args", async () => {
    const def = symbol.rosetta`sum: sum of numbers`(
      { input: z.array(z.number), output: [z.number] },
      (...ns: number[]) => ns.reduce((a, b) => a + b, 0),
    );
    const out = await def.run.call(testCallCtx(), new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n));
    expect((out as AInexact).real).toBe(6);
  });

  it("z.array output → multiple return values (a scheme values vector)", async () => {
    const def = symbol.rosetta`dup: echo two strings`(
      { input: [z.string], output: z.array(z.string) },
      (s) => [s, s],
    );
    const out = await def.run.call(testCallCtx(), new AString(CONSTANT_CTX, "a"));
    // encode of z.array(z.string) → a JS array of SchemeStrings (the values-vector).
    expect(Array.isArray(out)).toBe(true);
    const vec = out as AString[];
    expect(vec).toHaveLength(2);
    expect(vec[0]["arrival/toJS"]()).toBe("a");
  });
});

describe("symbol.notImplemented — errors-as-doors", () => {
  it("bakes a door carrying name + teaching reason", () => {
    const def = symbol.notImplemented`set!: set! mutates — violates value provenance (R7RS §4.1.6 omitted)`;
    expect(def.kind).toBe("door");
    expect(def.name).toBe("set!");
    expect(def.reason).toMatch(/mutates/);
  });
});

describe("name/doc parsing", () => {
  it("splits on the first colon; trims; tolerates a missing colon", () => {
    const withColon = symbol.notImplemented`a: b: c`;
    expect(withColon.name).toBe("a");
    expect(withColon.reason).toBe("b: c");
    const noColon = symbol.notImplemented`bare-name`;
    expect(noColon.name).toBe("bare-name");
    expect(noColon.reason).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TYPE-LEVEL PROOFS (documentation; enforced by the explicit tsc verification run).
// The canonical, `pnpm typecheck`-enforced versions live in env/symbol.ts.
// ─────────────────────────────────────────────────────────────────────────────
describe("type inference (compile-time)", () => {
  it("a wrong-typed native impl is a compile error", () => {
    symbol.native`bad-native: wrong impl`(
      { input: [z.pair], output: [z.pair] },
      // @ts-expect-error — impl receives a Pair (identity), not a string
      (p: string) => new APair(CONSTANT_CTX, p, nil),
    );
    expect(true).toBe(true);
  });

  it("a wrong-typed rosetta impl is a compile error", () => {
    symbol.rosetta`bad-rosetta: wrong impl`(
      { input: [z.string], output: [z.number] },
      // @ts-expect-error — impl receives a decoded string, not a Pair
      (s: APair<any, any>) => s as unknown as number,
    );
    expect(true).toBe(true);
  });

  it("a wrong-typed rosetta RETURN is a compile error", () => {
    symbol.rosetta`bad-return: wrong return`(
      { input: [z.string], output: [z.number] },
      // @ts-expect-error — output codec wants a number, impl returns a string
      (s) => s,
    );
    expect(true).toBe(true);
  });
});
