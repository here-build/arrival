/**
 * JS-INTEROP CONTRACT — the README promises "natural interop in both directions".
 * This suite is that promise, by example: a JS consumer receives a value out of
 * `exec()` and uses it as a JS value WITHOUT calling `schemeToJs` first.
 *
 * `it(...)`        = a promise the boxed value KEEPS today.
 * `it.fails(...)`  = a promise it BREAKS today (documented gap). The body asserts the
 *                    IDEAL behavior; `it.fails` passes precisely because that assertion
 *                    fails right now. When the container is fixed, the assertion starts
 *                    passing → `it.fails` flips to a hard failure, prompting promotion
 *                    to `it()`. So this file doubles as the regression target.
 *
 * Empirical baseline (2026-06-16): strings/bools auto-unwrap to JS primitives (natural);
 * numbers coerce via valueOf but break JSON.stringify (BigInt / struct leak); Pair is
 * iterable but SchemeVector/SchemeBytevector are not; char stringifies to the Scheme
 * literal; schemeToJs is the working escape hatch except for symbols.
 */
import { describe, expect, it } from "vitest";
import { exec, schemeToJs } from "../index.js";

const one = async (src: string): Promise<any> => (await exec(src))[0];

describe("JS-interop: numbers", () => {
  it("coerce in arithmetic via valueOf", async () => {
    const n = await one("(+ 1 2)");
    expect(n + 1).toBe(4);
    expect(Number(n)).toBe(3);
    expect(`${n}`).toBe("3");
  });

  it("exact numbers do NOT JSON.stringify today — BigInt-backed throws (flips → promote to .toBe ideal when fixed)", async () => {
    const n = await one("(+ 1 2)");
    // Pin the SPECIFIC current failure, not an undifferentiated throw: when the
    // BigInt backing is fixed this stops throwing and the test goes red.
    expect(() => JSON.stringify(n)).toThrow(/BigInt/);
  });

  it.fails("inexact numbers SHOULD JSON.stringify to their value (BROKEN: leaks {provenance,kind,real,imag})", async () => {
    const n = await one("(+ 1.5 0.5)");
    expect(JSON.stringify(n)).toBe("2");
  });
});

describe("JS-interop: strings & booleans (boxed scheme faces — the Face split)", () => {
  it("strings come back as AStrings (grafted String.prototype keeps interop natural)", async () => {
    const s = await one('(string-append "ab" "c")');
    // Boxed under the Face split (taintString always returns the AString scheme face —
    // the raw-string no-provenance fast path was the LIPS-legacy leak). AString grafts
    // String.prototype, so string-ish interop (concat, spread, JSON) still reads naturally.
    expect(String(s)).toBe("abc");
    expect(s + "!").toBe("abc!");
    expect([...String(s)].length).toBe(3);
    expect(JSON.stringify(String(s))).toBe('"abc"');
  });

  it("booleans come back as raw JS booleans", async () => {
    expect(await one("(< 1 2)")).toBe(true);
    expect(await one("(< 2 1)")).toBe(false);
  });
});

describe("JS-interop: characters", () => {
  it.fails("char SHOULD coerce to the JS char (BROKEN: stringifies to the Scheme literal '#\\\\a')", async () => {
    const ch = await one("#\\a");
    expect(String(ch)).toBe("a");
  });
});

describe("JS-interop: symbols", () => {
  it("symbol coerces to its name in a template literal", async () => {
    const sym = await one("'foo");
    expect(`${sym}`).toBe("foo");
  });

  it.fails("schemeToJs(symbol) SHOULD unwrap to a string (BROKEN: returns the internal struct)", async () => {
    const sym = await one("'foo");
    expect(schemeToJs(sym, {})).toBe("foo");
  });
});

describe("JS-interop: lists (Pair)", () => {
  it("a list is iterable from JS (spread / for-of / Array.from)", async () => {
    const lst = await one("(list 1 2 3)");
    expect(Array.from(lst).length).toBe(3);
    let count = 0;
    for (const _ of lst) count++;
    expect(count).toBe(3);
  });

  it("JSON.stringify(list) throws today — BigInt elements (flips → promote to [1,2,3] ideal when fixed)", async () => {
    const lst = await one("(list 1 2 3)");
    expect(() => JSON.stringify(lst)).toThrow(/BigInt/);
  });

  it("schemeToJs(list) is the working escape hatch", async () => {
    expect(schemeToJs(await one("(list 1 2 3)"), {})).toEqual([1, 2, 3]);
  });
});

describe("JS-interop: vectors", () => {
  it("a vector is iterable from JS like a Pair (spread / for-of / Array.from)", async () => {
    const vec = await one("(vector 1 2 3)");
    expect(Array.from(vec).length).toBe(3);
    let count = 0;
    for (const _ of vec) count++;
    expect(count).toBe(3);
    // elements coerce to their values (numbers via valueOf, as elsewhere)
    expect([...vec].map(Number)).toEqual([1, 2, 3]);
  });

  it("schemeToJs(vector) is the working escape hatch", async () => {
    expect(schemeToJs(await one("(vector 1 2 3)"), {})).toEqual([1, 2, 3]);
  });
});

describe("JS-interop: bytevectors", () => {
  it("a bytevector is iterable from JS (spread / for-of / Array.from yield bytes)", async () => {
    const bv = await one("(bytevector 1 2 3)");
    expect([...bv]).toEqual([1, 2, 3]);
    expect(Array.from(bv).length).toBe(3);
  });
});

describe("JS-interop: dicts / objects", () => {
  it("JSON.stringify(dict) throws today — BigInt-backed values (flips → promote to {a:1,b:2} ideal when fixed)", async () => {
    const d = await one("(dict :a 1 :b 2)");
    expect(() => JSON.stringify(d)).toThrow(/BigInt/);
  });

  it("schemeToJs(dict) is the working escape hatch", async () => {
    expect(schemeToJs(await one("(dict :a 1 :b 2)"), {})).toEqual({ a: 1, b: 2 });
  });
});
