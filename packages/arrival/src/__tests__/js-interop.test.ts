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
import { ABool } from "../values/primitives/ABool.js";

const one = async (src: string): Promise<any> => (await exec(src))[0];

describe("JS-interop: numbers", () => {
  it("coerce in arithmetic via valueOf", async () => {
    const n = await one("(+ 1 2)");
    expect(n + 1).toBe(4);
    expect(Number(n)).toBe(3);
    expect(`${n}`).toBe("3");
  });

  // [P15] FLIP-TO-FAILS (docs/test-invariant-atlas/verdicts/provenance.md, membrane.md):
  // this used to pin the current-broken BigInt-throw plain green ("documented current
  // behavior") — the test's own old comment even said "when fixed this stops throwing
  // and the test goes red," which is exactly what `it.fails` exists for. The body now
  // asserts the IDEAL behavior (matches this file's own convention, see header).
  it.fails("exact numbers SHOULD JSON.stringify to their value (BROKEN: BigInt-backed throws)", async () => {
    const n = await one("(+ 1 2)");
    expect(JSON.stringify(n)).toBe("3");
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

  // R8 mint (RULINGS.md R8, two-tier-exec-api.md §6) landed: op-helpers.mintVerdict
  // replaced the empty-provenance raw-JS-boolean fast path that used to make an
  // unstamped `(< 1 2)` exit `exec()` as a bare `true` — every boolean verdict now
  // boxes uniformly (ABool), matching every other value's boxed exit (P4). Natural
  // JS-boolean auto-unwrap returns once the SIMPLE exec tier maps `toJS` over the
  // exit (two-tier-exec-api.md §8 step 4, R1 — a later, separate migration step).
  it("booleans come back BOXED (ABool) — R8 uniform mint, not the old raw-JS-boolean escape", async () => {
    const lt = await one("(< 1 2)");
    expect(lt).toBeInstanceOf(ABool);
    expect((lt as ABool).valueOf()).toBe(true);
    const gt = await one("(< 2 1)");
    expect((gt as ABool).valueOf()).toBe(false);
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
    expect(Array.from(lst)).toHaveLength(3);
    let count = 0;
    for (const _ of lst) count++;
    expect(count).toBe(3);
  });

  // [P15] FLIP-TO-FAILS (same root cause + pattern as the exact-number BigInt row
  // above): pinned the current-broken throw plain green; body now asserts the ideal.
  it.fails("JSON.stringify(list) SHOULD serialize the list (BROKEN: BigInt elements throw)", async () => {
    const lst = await one("(list 1 2 3)");
    expect(JSON.stringify(lst)).toBe("[1,2,3]");
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
  // Was: threw on the BigInt inside a plain-object dict's boxed AExact entries.
  // Native-dict-provenance.md's ADict keeps entries inside a Map, which JSON.stringify
  // doesn't serialize at all (no own enumerable indexed properties) — so it no longer
  // throws, but it also doesn't produce anything useful: it leaks ADict's OWN wrapper
  // shape (ctx/provenance/kind), not the dict's data. No primitive in this codebase
  // implements `toJSON()` — `schemeToJs`, asserted below, is the one documented escape
  // hatch; JSON.stringify was never a supported interop path for a boxed value.
  it("JSON.stringify(dict) no longer throws, but isn't a supported interop path either", async () => {
    const d = await one("(dict :a 1 :b 2)");
    expect(() => JSON.stringify(d)).not.toThrow();
  });

  it("schemeToJs(dict) is the working escape hatch", async () => {
    expect(schemeToJs(await one("(dict :a 1 :b 2)"), {})).toEqual({ a: 1, b: 2 });
  });
});
