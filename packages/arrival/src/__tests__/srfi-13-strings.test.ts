/**
 * SRFI-13 string library (env/srfi/srfi-13.ts) — the completion pack.
 *
 * The base env already binds `string-contains` (SRFI-13) and the case trio, so a
 * model correctly extrapolates to the REST of the standard string library — then
 * crashes on `Unbound variable 'string-split'`. This suite pins the completed
 * surface: predicates, index/count (char OR one-arg predicate criteria — no
 * charsets), slices (take/drop and -right twins, out-of-range IS an error),
 * trim/pad, reverse, join/tokenize, and SRFI-152's `string-split`.
 *
 * Provenance discipline mirrors string-contains.test.ts: booleans/indices carry
 * the searched strings' lineage; derived strings carry the source's; split/tokenize
 * taint EACH piece so list elements stay grounded.
 */

import { describe, it, expect } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { initBridge } from "../bridge.js";
import { exec } from "../eval/generator-exec.js";
import { inferenceEnv } from "../inference-env.js";
import { AString } from "../values/primitives/AString.js";
import { AValue } from "../values/primitives/AValue.js";

const stamped = (s: string, ...points: number[]) => new AString(CONSTANT_CTX, s, new Set(points));
const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
// Literal-string args carry no provenance, so results come back raw (JS boolean/string
// or a bare SchemeExact); a provenanced input boxes it. Unwrap either shape.
const js = (x: unknown) => (x instanceof AValue ? x.toJs() : x);

let seq = 0;
async function run(src: string, bindings: Record<string, AString> = {}): Promise<unknown> {
  await initBridge();
  const env = inferenceEnv.inherit(`srfi-13-${seq++}`);
  for (const [k, v] of Object.entries(bindings)) env.set(k, v);
  const [r] = await exec(src, { env });
  return r;
}

describe("string-null? — emptiness predicate", () => {
  it("#t on the empty string, #f otherwise", async () => {
    expect(js(await run('(string-null? "")'))).toBe(true);
    expect(js(await run('(string-null? "a")'))).toBe(false);
  });
});

describe("string-prefix? / string-suffix? — SRFI-13 affix-first argument order", () => {
  it("(string-prefix? prefix s)", async () => {
    expect(js(await run('(string-prefix? "foo" "foobar")'))).toBe(true);
    expect(js(await run('(string-prefix? "bar" "foobar")'))).toBe(false);
    expect(js(await run('(string-prefix? "" "foobar")'))).toBe(true);
  });
  it("(string-suffix? suffix s)", async () => {
    expect(js(await run('(string-suffix? "bar" "foobar")'))).toBe(true);
    expect(js(await run('(string-suffix? "foo" "foobar")'))).toBe(false);
  });
  it("carries the provenance of the searched string", async () => {
    const r = await run('(string-prefix? "Al" name)', { name: stamped("Alloy.exe", 7) });
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([7]);
  });
});

describe("string-index — index of first match, or #f (char OR predicate)", () => {
  it("char criterion", async () => {
    expect(js(await run('(string-index "abc" #\\b)'))).toBe(1);
    expect(js(await run('(string-index "abc" #\\z)'))).toBe(false);
  });
  it("index 0 is a real (truthy) index — #f is the only false", async () => {
    expect(js(await run('(if (string-index "abc" #\\a) 1 0)'))).toBe(1);
    expect(js(await run('(string-index "abc" #\\a)'))).toBe(0);
  });
  it("predicate criterion (a scheme callable)", async () => {
    expect(js(await run('(string-index "hello world" char-whitespace?)'))).toBe(5);
    expect(js(await run('(string-index "abc123" (lambda (c) (char-numeric? c)))'))).toBe(3);
  });
  it("empty string never matches", async () => {
    expect(js(await run('(string-index "" #\\a)'))).toBe(false);
  });
});

describe("string-count — how many chars match", () => {
  it("char and predicate criteria", async () => {
    expect(js(await run('(string-count "banana" #\\a)'))).toBe(3);
    expect(js(await run('(string-count "a1b2c3" char-numeric?)'))).toBe(3);
    expect(js(await run('(string-count "" #\\a)'))).toBe(0);
  });
});

describe("string-take / string-drop and the -right twins", () => {
  it("normal slices", async () => {
    expect(js(await run('(string-take "hello" 2)'))).toBe("he");
    expect(js(await run('(string-drop "hello" 2)'))).toBe("llo");
    expect(js(await run('(string-take-right "hello" 2)'))).toBe("lo");
    expect(js(await run('(string-drop-right "hello" 2)'))).toBe("hel");
  });
  it("n=0 and n=length boundaries", async () => {
    expect(js(await run('(string-take "hello" 0)'))).toBe("");
    expect(js(await run('(string-take "hello" 5)'))).toBe("hello");
    expect(js(await run('(string-drop "hello" 0)'))).toBe("hello");
    expect(js(await run('(string-drop "hello" 5)'))).toBe("");
  });
  it("n out of range is an error (SRFI-13)", async () => {
    await expect(run('(string-take "hi" 3)')).rejects.toThrow(/out of range/);
    await expect(run('(string-drop-right "hi" 3)')).rejects.toThrow(/out of range/);
  });
  it("slices carry the source string's lineage", async () => {
    const r = await run("(string-take name 2)", { name: stamped("Alloy", 7) });
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([7]);
  });
});

describe("string-trim family — default whitespace; char/predicate criteria", () => {
  it("default: whitespace at both/left/right", async () => {
    expect(js(await run('(string-trim "  hi  ")'))).toBe("hi");
    expect(js(await run('(string-trim-left "  hi  ")'))).toBe("hi  ");
    expect(js(await run('(string-trim-right "  hi  ")'))).toBe("  hi");
  });
  it("char criterion", async () => {
    expect(js(await run('(string-trim "xxhixx" #\\x)'))).toBe("hi");
  });
  it("predicate criterion", async () => {
    expect(js(await run('(string-trim "12hi34" char-numeric?)'))).toBe("hi");
  });
  it("all-trimmed and empty strings", async () => {
    expect(js(await run('(string-trim "   ")'))).toBe("");
    expect(js(await run('(string-trim "")'))).toBe("");
  });
});

describe("string-pad / string-pad-right — to EXACTLY len (SRFI-13 truncation)", () => {
  it("pads on the left / right with space by default", async () => {
    expect(js(await run('(string-pad "7" 3)'))).toBe("  7");
    expect(js(await run('(string-pad-right "7" 3)'))).toBe("7  ");
  });
  it("custom pad char", async () => {
    expect(js(await run('(string-pad "7" 3 #\\0)'))).toBe("007");
  });
  it("TRUNCATES when too long — string-pad keeps the tail, pad-right the head", async () => {
    expect(js(await run('(string-pad "hello" 3)'))).toBe("llo");
    expect(js(await run('(string-pad-right "hello" 3)'))).toBe("hel");
  });
  it("len equal to length is identity", async () => {
    expect(js(await run('(string-pad "abc" 3)'))).toBe("abc");
  });
});

describe("string-reverse", () => {
  it("reversed copy", async () => {
    expect(js(await run('(string-reverse "abc")'))).toBe("cba");
    expect(js(await run('(string-reverse "")'))).toBe("");
  });
});

describe("string-join — list of strings to one (default delimiter: single space)", () => {
  it("default and explicit delimiters", async () => {
    expect(js(await run('(string-join (list "a" "b" "c"))'))).toBe("a b c");
    expect(js(await run('(string-join (list "a" "b" "c") ", ")'))).toBe("a, b, c");
  });
  it("empty list folds to the empty string", async () => {
    expect(js(await run("(string-join '())"))).toBe("");
  });
  it("collapsing op: re-stamps the union of element lineage", async () => {
    const r = await run('(string-join (list name "x") "-")', { name: stamped("Alloy", 7) });
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([7]);
  });
});

describe("string-tokenize — maximal runs of TOKEN chars (inverse of trim's criterion)", () => {
  it("default: non-whitespace runs", async () => {
    expect(js(await run('(length (string-tokenize "  foo bar  baz "))'))).toBe(3);
    expect(js(await run('(car (string-tokenize "  foo bar"))'))).toBe("foo");
  });
  it("criterion selects token chars", async () => {
    expect(js(await run('(car (string-tokenize "12ab34" char-numeric?))'))).toBe("12");
    expect(js(await run('(length (string-tokenize "12ab34" char-numeric?))'))).toBe(2);
  });
  it("no tokens yields '()", async () => {
    expect(js(await run('(null? (string-tokenize "   "))'))).toBe(true);
  });
});

describe("string-split — SRFI-152 literal-delimiter split", () => {
  it("basic split", async () => {
    expect(js(await run('(length (string-split "a,b,c" ","))'))).toBe(3);
    expect(js(await run('(cadr (string-split "a,b,c" ","))'))).toBe("b");
  });
  it("absent delimiter yields the whole string as one field", async () => {
    expect(js(await run('(length (string-split "abc" ","))'))).toBe(1);
    expect(js(await run('(car (string-split "abc" ","))'))).toBe("abc");
  });
  it("empty subject yields '() (the SRFI-152 refinement over JS .split)", async () => {
    expect(js(await run("(null? (string-split \"\" \",\"))"))).toBe(true);
  });
  it("trailing delimiter keeps the empty trailing field (JS .split semantics)", async () => {
    expect(js(await run('(length (string-split "a," ","))'))).toBe(2);
  });
  it("pieces carry the source string's lineage (grounded list elements)", async () => {
    const r = await run('(car (string-split name ","))', { name: stamped("Alloy,exe", 7) });
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([7]);
    expect(js(r)).toBe("Alloy");
  });
});
