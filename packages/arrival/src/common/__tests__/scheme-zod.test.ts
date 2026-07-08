// Low-level tests for scheme-zod (the in-progress uniform vocabulary redesign).
//
// Focus: the new function forms for collections (z.list, z.vector, z.array) so that
// callers can write z.list(z.char), z.list(z.char, z.union(z.nil, z.boolean)), etc.
//
// This is deliberately *lower level* than attestation.test.ts (which exercises
// full rosetta + membrane + attestation spine walking on pairs/vectors at a higher
// system level using mostly z.value contracts). Here we test the codecs in isolation,
// roundtrips with typed elements, and (in the companion .test-d.ts) the Face projections
// (interpreter/Scheme side vs JS side).

import { describe, expect, it } from "vitest";
import * as v8 from "node:v8";
import * as vm from "node:vm";

import * as z from "../scheme-zod.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { APair } from "../../values/primitives/APair.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { ABool } from "../../values/primitives/ABool.js";
import { AVector } from "../../values/primitives/AVector.js";
import { AJSArray } from "../../values/primitives/AJSArray.js";
import { AString } from "../../values/primitives/AString.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { AVoid } from "../../values/primitives/AVoid.js";
import { ABytevector } from "../../values/primitives/ABytevector.js";
import { ADict } from "../../values/primitives/ADict.js";
import { AJSObject } from "../../values/primitives/AJSObject.js";
import { R7RSError } from "../../errors.js";
import { ANativeProcedure, applyCallback } from "../../values/primitives/ACallable.js";

function makeChar(c: string) {
  return new ACharacter(CONSTANT_CTX, c);
}
function makeBool(b: boolean) {
  return new ABool(CONSTANT_CTX, b);
}
function makeString(s: string) {
  return new AString(CONSTANT_CTX, s);
}
function makeExact(num: bigint, denom = 1n) {
  return new AExact(CONSTANT_CTX, num, denom);
}
function makeInexact(real: number) {
  return new AInexact(CONSTANT_CTX, real);
}

// Forces a REAL major GC cycle without needing the process launched with `--expose-gc`
// (vitest's default `pnpm test` invocation does not pass that flag) — flip the flag on,
// mint `gc` in a throwaway vm context, flip it back off. Used by the z.symbol GC-defect
// regression below.
function forceGc(): void {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  v8.setFlagsFromString("--no-expose-gc");
  gc();
}

describe("scheme-zod collection functions (Zod style)", () => {
  it("z.list(element) produces a codec for homogeneous proper lists", () => {
    const charList = z.list(z.char);
    expect(charList).toBeTruthy();

    // Build a real scheme list (pair spine ending in nil)
    const p2 = new APair(CONSTANT_CTX, makeChar("b"), nil);
    const p1 = new APair(CONSTANT_CTX, makeChar("a"), p2);

    // Decode: scheme list → JS array (chars become their JS strings via the element codec)
    const decoded = charList.parse(p1); // parse runs the codec direction
    expect(decoded).toEqual(["a", "b"]);
    expect(Array.isArray(decoded)).toBe(true);

    // Encode: JS array → scheme list (roundtrip via parse both ways)
    const back = charList.parse(
      APair.fromArray(CONSTANT_CTX, [makeChar("x"), makeChar("y")], false),
    );
    expect(back).toEqual(["x", "y"]);
  });

  it("z.cons(car, cdrSchema) — dotted pair — e.g. z.cons(z.char, z.union([z.nil, z.boolean]))", () => {
    const consShape = z.cons(z.char, z.union([z.nil, z.boolean]));

    const good1 = new APair(CONSTANT_CTX, makeChar("a"), nil);
    const good2 = new APair(CONSTANT_CTX, makeChar("a"), makeBool(true));

    // These should decode without throwing (the tuple target validates the parts)
    expect(() => consShape.parse(good1)).not.toThrow();
    expect(() => consShape.parse(good2)).not.toThrow();

    const decoded1 = consShape.parse(good1);
    expect(decoded1).toEqual(["a", null]);

    // Bad cdr should fail (cdr is a char instead of nil|bool)
    const badCdr = makeChar("x");
    const bad = new APair(CONSTANT_CTX, makeChar("a"), badCdr);
    expect(() => consShape.parse(bad)).toThrow();
  });

  it("cons is exactly one cons cell, NOT a recursive list-with-typed-tail", () => {
    // z.cons(car, cdr) reads like "a list of car-typed elements, ending in cdr" — it
    // is not. The SECOND element's schema is matched against the cdr DIRECTLY, so a 2+
    // element list (whose cdr is itself a Pair, not the tail type) is rejected. Pins the
    // boundary cons's doc comment describes.
    const oneCharThenNil = z.cons(z.char, z.nil);

    const single = new APair(CONSTANT_CTX, makeChar("a"), nil);
    expect(oneCharThenNil.parse(single)).toEqual(["a", null]);

    // A real 2-char proper list: (a b) = (a . (b . ())) — cdr is a Pair, not nil.
    const twoChars = new APair(CONSTANT_CTX, makeChar("a"), new APair(CONSTANT_CTX, makeChar("b"), nil));
    expect(() => oneCharThenNil.parse(twoChars)).toThrow();
  });

  it("z.vector(element) works for both AVector and AJSArray", () => {
    const strVec = z.vector(z.string);

    const nativeVec = new AVector(CONSTANT_CTX, [makeString("x"), makeString("y")] as any);
    expect(strVec.parse(nativeVec)).toEqual(["x", "y"]);

    const jsArr = new AJSArray(CONSTANT_CTX, [makeString("p")] as any);
    expect(strVec.parse(jsArr)).toEqual(["p"]);

    // encode canonically produces AVector (the first union branch), per vector()'s own comment.
    const out = strVec.encode(["q"]);
    expect(out).toBeInstanceOf(AVector);
    expect((out as AVector).__vector__.map((v) => (v as AString)["arrival/toJS"]())).toEqual(["q"]);
  });

  it("z.array is zod's own plain array re-export (NOT a scheme list/vector union)", () => {
    // array is now the variadic arg-vector spec (zod's own). A scheme list/vector cast to an
    // array uses z.list/z.vector directly. z.array(z.string) is a plain array of the AString
    // codec: it decodes a JS array of AStrings to a JS array of strings.
    const strArr = z.array(z.string);
    expect(strArr.parse([makeString("hi"), makeString("ho")])).toEqual(["hi", "ho"]);
  });

  it("element codecs are applied (string codec turns AString <-> string)", () => {
    const strList = z.list(z.string);

    const p = APair.fromArray(CONSTANT_CTX, [makeString("hello")], false);
    const decoded = strList.parse(p);
    expect(decoded).toEqual(["hello"]);
    expect(typeof decoded[0]).toBe("string");

    // roundtrip encode
    const reEncoded = (strList as any).encode(["world"]);
    expect(reEncoded).toBeInstanceOf(APair);
    expect((reEncoded as APair<any, any>).car).toBeInstanceOf(AString);
  });

  it("rejects improper lists for homogeneous z.list", () => {
    const anyList = z.list();
    // cdr is a char (not nil and not a pair) → improper termination
    const improper = new APair(CONSTANT_CTX, makeChar("a"), makeChar("a"));
    expect(() => anyList.parse(improper)).toThrow();
  });

  it("z.list([A, B]) — exactly 2 heterogeneous heads, nil-terminated, no tail", () => {
    const heteroList = z.list([z.char, z.string]);

    const good = APair.fromArray(CONSTANT_CTX, [makeChar("x"), makeString("hi")], false);
    expect(heteroList.parse(good)).toEqual(["x", "hi"]);

    // too few heads (missing the second) → rejected
    const tooFew = APair.fromArray(CONSTANT_CTX, [makeChar("x")], false);
    expect(() => heteroList.parse(tooFew)).toThrow();

    // too many (no tail declared, so a 3rd element is out of shape) → rejected
    const tooMany = APair.fromArray(CONSTANT_CTX, [makeChar("x"), makeString("hi"), makeString("extra")], false);
    expect(() => heteroList.parse(tooMany)).toThrow();
  });

  it("z.list([A, B], E) — 2 fixed heads then zero-or-more E, nil-terminated", () => {
    const headsAndTail = z.list([z.char, z.string], z.boolean);

    // heads only, zero tail elements — the tail is zero-OR-more, not one-or-more
    const exactlyHeads = APair.fromArray(CONSTANT_CTX, [makeChar("x"), makeString("hi")], false);
    expect(headsAndTail.parse(exactlyHeads)).toEqual(["x", "hi"]);

    // heads + 2 tail elements
    const withTail = APair.fromArray(
      CONSTANT_CTX,
      [makeChar("x"), makeString("hi"), makeBool(true), makeBool(false)],
      false,
    );
    expect(headsAndTail.parse(withTail)).toEqual(["x", "hi", true, false]);

    // a tail element of the wrong type is rejected
    const badTail = APair.fromArray(CONSTANT_CTX, [makeChar("x"), makeString("hi"), makeChar("z")], false);
    expect(() => headsAndTail.parse(badTail)).toThrow();
  });

  it("sugar z.list(E) is z.list([], E) — cross-checked by round-tripping through each other", () => {
    const sugar = z.list(z.char);
    const explicit = z.list([], z.char);

    const src = APair.fromArray(CONSTANT_CTX, [makeChar("a"), makeChar("b")], false);
    expect(sugar.parse(src)).toEqual(explicit.parse(src));

    // encode via one, decode via the other — same container shape either way
    expect(explicit.parse(sugar.encode(["p", "q"]))).toEqual(["p", "q"]);
    expect(sugar.parse(explicit.encode(["p", "q"]))).toEqual(["p", "q"]);
  });
});

describe("scheme-zod z.symbol codec", () => {
  it("decode then encode round-trips to the SAME ASymbol instance (opaque brand, no data loss)", () => {
    const sym = new ASymbol(CONSTANT_CTX, "my-symbol");
    const jsSymbol = z.symbol.parse(sym);
    expect(typeof jsSymbol).toBe("symbol");

    const back = z.symbol.encode(jsSymbol);
    expect(back).toBe(sym); // same instance, not just an equal one
  });

  it("two distinct ASymbol instances decode to two distinct JS symbols (no collision)", () => {
    const a = new ASymbol(CONSTANT_CTX, "a");
    const b = new ASymbol(CONSTANT_CTX, "b");
    expect(z.symbol.parse(a)).not.toBe(z.symbol.parse(b));
  });

  it("encoding a jsSymbol the codec never minted throws (not a silent wrong value)", () => {
    expect(() => z.symbol.encode(Symbol("not-from-this-codec"))).toThrow();
  });

  it("encode succeeds even after the ASymbol would otherwise be GC-eligible (forces a real GC cycle)", () => {
    // The defect this guards: the draft cached the ASymbol WEAKLY (`Map<symbol,
    // WeakRef<ASymbol>>` + FinalizationRegistry) — if nothing else held the ASymbol, it
    // could be collected out from under a live jsSymbol, making a later encode() throw
    // nondeterministically. Fix inverts the weakness: `WeakMap<symbol, ASymbol>` holds the
    // ASymbol STRONGLY as long as its jsSymbol lives. Prove it by actually collecting.
    let jsSymbol!: symbol;
    let weakRef!: WeakRef<ASymbol>;
    (() => {
      const sym = new ASymbol(CONSTANT_CTX, "gc-pressure-symbol");
      jsSymbol = z.symbol.parse(sym);
      weakRef = new WeakRef(sym);
      // `sym` goes out of scope here — only the codec's own cache (keyed off `jsSymbol`,
      // which the outer scope still holds) can keep it alive from this point on.
    })();

    forceGc();
    forceGc(); // a 2nd pass — some V8 GCs need two cycles to settle pending weak refs

    // If the OLD (weak-VALUE) direction were in place, this could already be undefined.
    expect(weakRef.deref()).toBeDefined();
    expect(z.symbol.encode(jsSymbol)).toBe(weakRef.deref());
  });
});

describe("scheme-zod z.dict(shape)/z.dict() — keyed to ADict.get()'s own protocol", () => {
  it("keyed round-trip against a real ADict", () => {
    const shaped = z.dict({ name: z.string, age: z.integer });
    const nativeDict = new ADict(CONSTANT_CTX, [
      [new ASymbol(CONSTANT_CTX, "name"), makeString("Ada")],
      [new ASymbol(CONSTANT_CTX, "age"), makeExact(36n)],
    ]);

    expect(shaped.parse(nativeDict)).toEqual({ name: "Ada", age: 36 });

    const encoded = shaped.encode({ name: "Grace", age: 85 });
    expect(encoded).toBeInstanceOf(ADict);
    expect((encoded as ADict).get("name")).toBeInstanceOf(AString);
    expect(((encoded as ADict).get("name") as AString)["arrival/toJS"]()).toBe("Grace");
    expect(((encoded as ADict).get("age") as AExact).num).toBe(85n);
  });

  it("a dict-shaped AJSObject is accepted on decode too (isDictShaped, not just instanceof ADict)", () => {
    const shaped = z.dict({ name: z.string });
    const toolResult = new AJSObject(CONSTANT_CTX, { name: "from a tool" });
    expect(shaped.parse(toolResult)).toEqual({ name: "from a tool" });
  });

  it("z.dict() bare (open-record) is the shallow BOXED record — the inside-the-sandbox shape, NOT the membrane exit", () => {
    // Rebaselined for R9 (two-tier-exec-api.md §5): `arrival/toJS` now egresses a lazy
    // proxy with values already unwrapped to plain JS — the OUTSIDE shape. This codec
    // feeds its out-schema (`z.record(z.string(), value)`) per-field, so its decode
    // builds the boxed record from keys()/get() directly and must NOT route through the
    // membrane exit.
    const a = makeExact(1n);
    const b = makeString("x");
    const nativeDict = new ADict(CONSTANT_CTX, [
      [new ASymbol(CONSTANT_CTX, "a"), a],
      [new ASymbol(CONSTANT_CTX, "b"), b],
    ]);
    expect(z.dict().parse(nativeDict)).toEqual({ a, b });
  });
});

describe("scheme-zod z.box — whole-object unwrap, not decomposition", () => {
  it("round-trips identity: same reference, class/methods survive (not decomposed like dict)", () => {
    class Foo {
      constructor(readonly x: number) {}
      double(): number {
        return this.x * 2;
      }
    }
    const original = new Foo(21);

    const encoded = z.box.encode(original);
    expect(encoded).toBeInstanceOf(AJSObject);

    const decoded = z.box.parse(encoded);
    expect(decoded).toBe(original); // SAME reference, not a decomposed copy
    expect(decoded).toBeInstanceOf(Foo);
    expect((decoded as Foo).double()).toBe(42);
  });
});

describe("scheme-zod z.procedure — contract-aware marshaling", () => {
  it("decode direction: marshals JS args → scheme → JS result when input/output are given", async () => {
    const doubleProc = new ANativeProcedure({
      name: "double",
      arity: { min: 1, max: 1 },
      contract: undefined,
      impl: (args) => new AExact(CONSTANT_CTX, (args[0] as AExact).num * 2n),
    });
    const decoded = z.procedure(z.integer, z.integer).parse(doubleProc);
    await expect(decoded(21)).resolves.toBe(42);
  });

  it("encode direction mirrors: JS fn → scheme callable that marshals scheme args → JS → scheme", async () => {
    const proc = z.procedure(z.integer, z.integer);
    const encoded = proc.encode((...args: unknown[]) => (args[0] as number) + 1);
    expect(encoded).toBeInstanceOf(ANativeProcedure);

    const out = await applyCallback(encoded, [makeExact(41n)]);
    expect(out).toBeInstanceOf(AExact);
    expect((out as AExact).num).toBe(42n);
  });

  it("untyped fallback (no input/output): decode round-trips raw scheme values unchanged", async () => {
    const identityNative = new ANativeProcedure({
      name: "identity",
      arity: { min: 1, max: 1 },
      contract: undefined,
      impl: (args) => args[0],
    });
    const decoded = z.procedure().parse(identityNative);
    const rawArg = makeExact(5n);
    // no `input` codec supplied → jsArgs pass straight through as scheme args, untransformed
    await expect(decoded(rawArg)).resolves.toBe(rawArg);
  });

  it("untyped fallback: encode round-trips raw scheme values unchanged", async () => {
    const rawEncoded = z.procedure().encode((...args: unknown[]) => args[0]);
    const raw = makeExact(9n);
    const out = await applyCallback(rawEncoded, [raw]);
    expect(out).toBe(raw); // no `output` codec supplied → passed straight back unchanged
  });
});

describe("scheme-zod z.value — exhaustive predicate, passthrough on both faces", () => {
  it("accepts every concrete scheme value kind (the completeness fix: symbol/dict/vector/bytevector included)", () => {
    const instances: unknown[] = [
      makeBool(true),
      makeChar("x"),
      makeString("s"),
      makeExact(1n),
      makeInexact(1.5),
      new ASymbol(CONSTANT_CTX, "sym"),
      new ANil(CONSTANT_CTX),
      new AVoid(CONSTANT_CTX),
      new ABytevector(CONSTANT_CTX, new Uint8Array([1, 2, 3])),
      new AVector(CONSTANT_CTX, []),
      new AJSArray(CONSTANT_CTX, []),
      new ADict(CONSTANT_CTX, []),
      new AJSObject(CONSTANT_CTX, {}),
      new APair(CONSTANT_CTX, makeExact(1n), nil),
    ];
    for (const v of instances) {
      expect(() => z.value.parse(v)).not.toThrow();
    }
  });

  it("z.decode(value, x) === x — passthrough only, never transforms", () => {
    const sym = makeExact(7n);
    expect(z.decode(z.value, sym)).toBe(sym);
  });

  // printType(z.value) === "unknown" — NOT tested here. schema-to-ts.ts (the printer) still
  // imports v1's `common/scheme-zod.js`, not this file; wiring it to v2 is owned by the
  // parallel schema-to-ts workstream (steps 11a/11b) and that file is out of scope for this
  // pass. v1's own IMAGE_BY_NAME already maps "value" → unknownNode, so the printed-image
  // behavior isn't a gap in practice — just not yet reachable from v2's own exports.
});

describe("scheme-zod z.nil", () => {
  it("null round-trip", () => {
    const n = new ANil(CONSTANT_CTX);
    expect(z.nil.parse(n)).toBe(null);
    expect(z.nil.encode(null)).toBeInstanceOf(ANil);
  });

  it("the empty-list role is absorbed by z.list's own decode — no separate schema needed", () => {
    const empty = new ANil(CONSTANT_CTX);
    expect(z.list(z.char).parse(empty)).toEqual([]);
  });
});

describe("scheme-zod z.undefinedResult / z.error — real codecs", () => {
  it("z.undefinedResult round-trips undefined ↔ AVoid", () => {
    const v = new AVoid(CONSTANT_CTX);
    expect(z.undefinedResult.parse(v)).toBeUndefined();
    expect(z.undefinedResult.encode(undefined)).toBeInstanceOf(AVoid);
  });

  it("z.error round-trips R7RSError ↔ Error, irritants ↔ cause", () => {
    const withIrritants = new R7RSError("bad arg", 1, "two");
    const decoded = z.error.parse(withIrritants);
    expect(decoded).toBeInstanceOf(Error);
    expect(decoded.message).toBe("bad arg");
    expect(decoded.cause).toEqual([1, "two"]);

    const noIrritants = new R7RSError("plain error");
    expect(z.error.parse(noIrritants).cause).toBeUndefined();

    const encoded = z.error.encode(new Error("oops", { cause: [1, 2] }));
    expect(encoded).toBeInstanceOf(R7RSError);
    expect(encoded.message).toBe("oops");
    expect(encoded.irritants).toEqual([1, 2]);

    const encodedNoCause = z.error.encode(new Error("plain"));
    expect(encodedNoCause.irritants).toEqual([]);
  });
});

describe("scheme-zod number codec family — boundary cases (ported from v1's own coverage)", () => {
  describe("z.exact", () => {
    it("round-trips a safe integer both ways (bigint and number encode inputs)", () => {
      expect(z.exact.parse(makeExact(42n))).toBe(42n);
      expect((z.exact.encode(42n) as AExact).num).toBe(42n);
      expect((z.exact.encode(42) as AExact).num).toBe(42n);
    });

    it("doors a non-integer exact rational on decode (denom !== 1n)", () => {
      expect(() => z.exact.parse(makeExact(1n, 3n))).toThrow(/no integer form/);
    });

    it("doors encoding a non-safe-integer JS number", () => {
      expect(() => z.exact.encode(1.5)).toThrow(/safe integer/);
    });
  });

  describe("z.inexact", () => {
    it("decodes AInexact.real; encode accepts bigint/number, lossy accepted", () => {
      expect(z.inexact.parse(makeInexact(1.5))).toBe(1.5);
      expect((z.inexact.encode(3n) as AInexact).real).toBe(3);
      expect((z.inexact.encode(2.5) as AInexact).real).toBe(2.5);
    });
  });

  describe("z.integer", () => {
    it("decodes a safe AExact or AInexact integer; encode canonicalizes to AExact", () => {
      expect(z.integer.parse(makeExact(42n))).toBe(42);
      expect(z.integer.parse(makeInexact(42))).toBe(42);
      const out = z.integer.encode(42);
      expect(out).toBeInstanceOf(AExact);
      expect((out as AExact).denom).toBe(1n);
    });

    it("doors a non-safe-integer AInexact on decode", () => {
      expect(() => z.integer.parse(makeInexact(1.5))).toThrow(/safe integer/);
    });

    it("doors an out-of-range exact integer on decode (precision loss guard)", () => {
      const huge = makeExact(BigInt(Number.MAX_SAFE_INTEGER) + 10n);
      expect(() => z.integer.parse(huge)).toThrow(/safe-integer range/);
    });

    it("doors a non-integer exact rational on decode (shares number's exactToJsNumberOrDoor helper)", () => {
      expect(() => z.integer.parse(makeExact(1n, 3n))).toThrow(/faithful JS number|rational/i);
    });
  });

  describe("z.schemeNumber", () => {
    it("union of exact|inexact: decodes each branch through its OWN codec (bigint for exact, number for inexact)", () => {
      expect(z.schemeNumber.parse(makeExact(5n))).toBe(5n);
      expect(z.schemeNumber.parse(makeInexact(5.5))).toBe(5.5);
    });

    it("encode direction always tries exact FIRST (both members share a bigint|number out-schema): a bigint or safe-integer number encodes to AExact; a genuine float THROWS rather than falling through to inexact", () => {
      // Unlike z.number/z.bigint (whose two union members target disjoint OUT types, z.number()
      // XOR z.bigint()), exact's own out-schema is z.union([bigint, number]) — broad enough to
      // structurally match ANY encode input schemeNumber sees, so zod's union always picks the
      // FIRST matching member (exact) and never reaches inexact at all. Verified directly against
      // zod 4.3.6's real union-encode behavior, not assumed.
      expect(z.schemeNumber.encode(5n)).toBeInstanceOf(AExact);
      expect(z.schemeNumber.encode(5)).toBeInstanceOf(AExact);
      expect(() => z.schemeNumber.encode(5.5)).toThrow(/safe integer/);
    });
  });

  describe("z.number", () => {
    it("decodes exact/inexact to a JS number; encode canonically produces AInexact", () => {
      expect(z.number.parse(makeExact(21n))).toBe(21);
      expect(z.number.parse(makeInexact(1.5))).toBe(1.5);
      expect(z.number.encode(3)).toBeInstanceOf(AInexact);
    });

    it("doors an over-range exact integer (no silent precision loss)", () => {
      const huge = makeExact(BigInt(Number.MAX_SAFE_INTEGER) + 10n);
      expect(() => z.number.parse(huge)).toThrow(/safe-integer range/);
    });

    it("doors a non-integer exact rational", () => {
      expect(() => z.number.parse(makeExact(1n, 3n))).toThrow(/faithful JS number|rational/i);
    });
  });

  describe("z.bigint", () => {
    it("round-trips arbitrary precision beyond the safe-integer range; encode canonically AExact", () => {
      const big = BigInt(Number.MAX_SAFE_INTEGER) + 100n;
      expect(z.bigint.parse(makeExact(big))).toBe(big);
      const out = z.bigint.encode(big);
      expect(out).toBeInstanceOf(AExact);
      expect((out as AExact).num).toBe(big);
    });

    it("doors an exact rational with no integer bigint form", () => {
      expect(() => z.bigint.parse(makeExact(1n, 3n))).toThrow(/no integer bigint form/);
    });

    it("doors an inexact value with a fractional part", () => {
      expect(() => z.bigint.parse(makeInexact(1.5))).toThrow(/fractional part/);
    });
  });
});

describe("scheme-zod z.lookupName / named() — survives combinators, incl. the .refine() parent-walk", () => {
  it("resolves a function-constructed schema: z.list(z.char)", () => {
    expect(z.lookupName(z.list(z.char))).toBe("list");
  });

  it("resolves through .optional() (fresh wrapper holding the original by reference)", () => {
    expect(z.lookupName(z.vector(z.string).optional())).toBe("vector");
  });

  it("resolves through .refine() via the _zod.parent back-link (the new coverage this migration adds)", () => {
    // z.booleanTrue = z.boolean.refine(...) — .refine() clones via core.clone(inst, def,
    // {parent:true}), setting _zod.parent to the pre-refine (registered) instance. Unlike
    // .optional()/.default() (a fresh wrapper's def.innerType), this is the ONLY way to
    // recover the name across a `.refine()`/`.check()` — walk _zod.parent, don't assume a
    // generic "unwrap wrappers" story covers it.
    expect(z.lookupName(z.booleanTrue)).toBe("boolean");
  });
});

describe("scheme-zod z.array — guard: still zod's own plain re-export", () => {
  it("is not a scheme-collection codec — a plain JS array of already-JS values parses directly, no scheme container involved", () => {
    // A real z.list/z.vector container schema requires an APair/ANil/AVector/AJSArray on the
    // input side; z.array here is zod's OWN array factory, so a bare JS array of plain values
    // (not scheme instances at all) parses straight through.
    const plainString = z.custom<string>((v) => typeof v === "string");
    expect(z.array(plainString).parse(["already js", "values"])).toEqual(["already js", "values"]);
  });
});
