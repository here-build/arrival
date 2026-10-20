// Regression pins for the r7rs/srfi/polyglot cleanup pass: each case was a silent wrong
// answer or a raw host error before the fix, and is now a taught door or the correct value.
import { describe, expect, it } from "vitest";
import { exec } from "../../../eval/generator-exec.js";
import { sliceRange } from "../../pack-helpers.js";

const run = async (src: string) => (await exec(src)).at(-1);
const rejects = (src: string, re: RegExp) => expect(run(src)).rejects.toThrow(re);

describe("make-list / list-ref / list-tail index doors", () => {
  it("caps allocation and refuses negative or fractional counts", async () => {
    await rejects("(make-list 1e12 0)", /make-list/);
    await rejects("(make-list -2 0)", /make-list/);
    await rejects("(make-list 2.5 0)", /make-list/);
    expect(await run("(make-list 3 7)")).toEqual([7, 7, 7]);
  });
  it("list-ref / list-tail refuse negative and fractional indices", async () => {
    await rejects("(list-ref '(1 2 3) -1)", /list-ref/);
    await rejects("(list-ref '(1 2 3) 1.5)", /list-ref/);
    await rejects("(list-tail '(1 2 3) -1)", /list-tail/);
    expect(await run("(list-ref '(1 2 3) 2)")).toBe(3);
  });
  it("list-copy survives a long list", async () => {
    expect(await run("(length (list-copy (iota 200000)))")).toBe(200_000);
    expect(await run("(list-copy '(1 2 3))")).toEqual([1, 2, 3]);
  }, 120_000);
});

describe("bytevector doors", () => {
  it("refuses out-of-range / non-integer bytes instead of wrapping", async () => {
    await rejects("(bytevector 256)", /byte/);
    await rejects("(bytevector -1)", /byte/);
    await rejects("(bytevector 1.5)", /byte/);
    await rejects("(make-bytevector 3 300)", /byte/);
  });
  it("make-bytevector caps allocation and refuses negatives", async () => {
    await rejects("(make-bytevector -1)", /make-bytevector/);
    await rejects("(make-bytevector 1e12)", /make-bytevector/);
  });
  it("bytevector-u8-ref is bounds-checked", async () => {
    await rejects("(bytevector-u8-ref (bytevector 1 2) 5)", /out of range/);
    await rejects("(bytevector-u8-ref (bytevector 1 2) -1)", /out of range/);
    expect(await run("(bytevector-u8-ref (bytevector 1 2) 1)")).toBe(2);
  });
  it("slice ranges are checked", async () => {
    await rejects("(bytevector-copy (bytevector 1 2 3) 2 9)", /out of range/);
    await rejects("(utf8->string (bytevector 104 105) -1)", /out of range/);
    await rejects('(string->utf8 "abc" 2 1)', /out of range/);
  });
});

describe("modulo / floor-remainder above 2^53", () => {
  it("keeps full precision", async () => {
    expect(await run("(modulo 9007199254740990 9007199254740991)")).toBe(9_007_199_254_740_990);
    expect(await run("(floor-remainder 9007199254740990 9007199254740991)")).toBe(9_007_199_254_740_990);
    expect(await run("(modulo -7 2)")).toBe(1);
    expect(await run("(modulo 7 -2)")).toBe(-1);
    expect(await run("(modulo -4 2)")).toBe(0);
  });
});

describe("vector slice ranges", () => {
  it("door instead of JS slice semantics", async () => {
    await rejects("(vector->list #(1 2 3) -1)", /out of range/);
    await rejects("(vector-copy #(1 2 3) -2)", /out of range/);
    await rejects("(vector-copy #(1 2 3) 2 9)", /out of range/);
    await rejects(String.raw`(vector->string #(#\a #\b) 1 5)`, /out of range/);
    expect(await run("(vector-copy #(1 2 3) 1)")).toEqual([2, 3]);
  });
  it("sliceRange resolves defaults", () => {
    expect(sliceRange("x", 4, undefined, undefined)).toEqual({ start: 0, end: 4 });
  });
});

describe("list->vector", () => {
  it("doors improper and circular lists", async () => {
    await rejects("(list->vector '(1 2 . 3))", /improper/);
    await rejects("(list->vector '#0=(1 2 . #0#))", /circular/);
    expect(await run("(list->vector '(1 2 3))")).toEqual([1, 2, 3]);
  });
});

describe("char-ci family uses case folding", () => {
  it("final sigma folds to sigma", async () => {
    expect(await run(String.raw`(char-ci=? #\σ #\ς)`)).toBe(true);
    expect(await run(String.raw`(char-ci<? #\a #\B)`)).toBe(true);
    expect(await run(String.raw`(char-ci>=? #\b #\A)`)).toBe(true);
  });
});

describe("dict arity", () => {
  it("doors an unpaired trailing key", async () => {
    await rejects("(dict :a 1 :b)", /no value/);
    expect(await run("(@ (dict :a 1 :b 2) :b)")).toBe(2);
  });
});

describe("nth (Clojure)", () => {
  it("accepts vectors and doors out-of-range / negative", async () => {
    expect(await run("(nth 0 #(1 2))")).toBe(1);
    expect(await run("(nth 1 '(5 6 7))")).toBe(6);
    await rejects("(nth -1 '(5 6 7))", /nth/);
    await rejects("(nth 9 '(5 6))", /out of range/);
    await rejects("(nth 5 #(1 2))", /out of range/);
  });
});

describe("make-comparator with #f ordering", () => {
  it("round-trips through the output schema", async () => {
    expect(await run("(comparator-ordering-predicate (make-comparator number? = #f))")).toBe(false);
  });
});
