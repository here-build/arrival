// Low-level tests for scheme-zod-v2 (the in-progress uniform vocabulary redesign).
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

import * as z from "../scheme-zod-v2.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { APair } from "../../values/primitives/APair.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { ABool } from "../../values/primitives/ABool.js";
import { AVector } from "../../values/primitives/AVector.js";
import { AJSArray } from "../../values/primitives/AJSArray.js";
import { AString } from "../../values/primitives/AString.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";

function makeChar(c: string) {
  return new ACharacter(CONSTANT_CTX, c);
}
function makeBool(b: boolean) {
  return new ABool(CONSTANT_CTX, b);
}
function makeString(s: string) {
  return new AString(CONSTANT_CTX, s);
}

describe("scheme-zod-v2 collection functions (Zod style)", () => {
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

  it("z.list supports the 2-arg cons form (car, cdrSchema) — e.g. z.list(z.char, z.union([z.nil, z.boolean]))", () => {
    const consShape = z.list(z.char, z.union([z.nil, z.boolean]));

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

  it("2-arg cons form is exactly one cons cell, NOT a recursive list-with-typed-tail", () => {
    // z.list(car, cdr) reads like "a list of car-typed elements, ending in cdr" — it
    // is not. It's `cons`: the SECOND element's schema is matched against the cdr
    // DIRECTLY, so a 2+ element list (whose cdr is itself a Pair, not the tail type)
    // is rejected. Pins the boundary makeTypedCons's doc comment describes.
    const oneCharThenNil = z.list(z.char, z.nil);

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

  it("z.array(element) is the union of list+vector for the element", () => {
    const strArr = z.array(z.string);

    const asList = APair.fromArray(CONSTANT_CTX, [makeString("hi")], false);
    expect(strArr.parse(asList)).toEqual(["hi"]);

    const asVec = new AVector(CONSTANT_CTX, [makeString("ho")] as any);
    expect(strArr.parse(asVec)).toEqual(["ho"]);
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
    expect((reEncoded as APair).car).toBeInstanceOf(AString);
  });

  it("rejects improper lists for homogeneous z.list", () => {
    const anyList = z.list();
    // cdr is a char (not nil and not a pair) → improper termination
    const improper = new APair(CONSTANT_CTX, makeChar("a"), makeChar("a"));
    expect(() => anyList.parse(improper)).toThrow();
  });
});

describe("scheme-zod-v2 z.symbol codec", () => {
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
});
