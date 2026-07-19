import { describe, expect, it } from "vitest";

import { printScheme, schemeToSugarcoat, parseSexprs } from "../sugarcoat-render.js";
import { readSugarcoatExpr, readSugarcoat } from "../sugarcoat-read.js";

const read = (sugarcoat: string): string => printScheme(readSugarcoatExpr(sugarcoat));
const readAll = (sugarcoat: string): string => readSugarcoat(sugarcoat).map((f) => printScheme(f)).join("\n");

// @head{text} → (head <part>…); headless → str; @dedent{…} dissolves to (str <dedented>).
describe("read: at-expressions → (head part…)", () => {
  const cases: Array<[string, string]> = [
    // headless defaults to str
    ["@{hello}", '(str "hello")'],
    ["@{a @x b}", '(str "a " x " b")'],
    // explicit head, general reader
    ["@string-append{a @x b}", '(string-append "a " x " b")'],
    // quotes are literal — no \" escaping in source
    ['@{Say "@x" loud}', '(str "Say \\"" x "\\" loud")'],
    // @(datum) graft — a full parenthesized form
    ["@{role: @(field lead \"role\")}", '(str "role: " (field lead "role"))'],
    // nested @head{…}
    ["@{outer @inner{deep} end}", '(str "outer " (inner "deep") " end")'],
    // bare interp stops at `.` so the period stays literal prose
    ["@{@config/product.}", '(str config/product ".")'],
    // @|sym| explicit boundary — the `s` would otherwise glue onto the interp
    ["@{go @|x|s now}", '(str "go " x "s now")'],
    // balanced literal braces stay verbatim
    ["@{use {curly} raw}", '(str "use {curly} raw")'],
    // lone @ with no valid interp is literal
    ["@{a @ b}", '(str "a @ b")'],
  ];
  for (const [sugarcoat, scheme] of cases) it(`${sugarcoat} → ${scheme}`, () => expect(read(sugarcoat)).toBe(scheme));
});

describe("read: @dedent dissolves to str with indentation stripped", () => {
  // inline first line + indented continuations (the common shape)
  it("strips common indent off continuation lines, keeps first inline line", () => {
    const src = "@dedent{Pitch it.\n      Line two.\n      Line three.}";
    expect(read(src)).toBe('(str "Pitch it.\\nLine two.\\nLine three.")');
  });
  it("interpolations survive the dedent", () => {
    const src = "@dedent{Hi @name.\n    You are @(role x).}";
    expect(read(src)).toBe('(str "Hi " name ".\\nYou are " (role x) ".")');
  });
});

describe("read: backwards-compat — bare @ stays a symbol", () => {
  it("(@ f key) accessor is untouched", () => expect(read("(@ f key)")).toBe("(@ f key)"));
  it("@foo with no brace is a plain symbol", () => expect(read("@foo")).toBe("@foo"));
});

describe("read: multi-line at-body through the I-expression coalescer", () => {
  it("an indented @dedent under a head coalesces and reads", () => {
    const src = "call\n  @dedent{first\n    second}";
    expect(readAll(src)).toBe('(call (str "first\\nsecond"))');
  });
});

const render = (scheme: string): string => schemeToSugarcoat(scheme).trim();

describe("render: (str …) → single-line at-expression", () => {
  const cases: Array<[string, string]> = [
    ['(str "a " x " b")', "@{a @x b}"],
    ['(string-append "a " x " b")', "@string-append{a @x b}"],
    ['(str "Say \\"" x "\\" loud")', '@{Say "@x" loud}'],
    ['(str "role: " (field lead "role"))', '@{role: @(field lead "role")}'],
  ];
  for (const [scheme, sugarcoat] of cases) it(`${scheme} → ${sugarcoat}`, () => expect(render(scheme)).toBe(sugarcoat));

  // preference / soundness — these stay classic
  const classic: string[] = [
    "(str x y)", // no prose literal
    '(str "a" "b")', // adjacent literals coalesce → not representable
    '(str "hello")', // single bare word, no space/quote
  ];
  for (const s of classic) it(`${s} stays classic`, () => expect(render(s)).toBe(s));
});

describe("read∘render = id (the moat) for single-line at-expressions", () => {
  const canon = (s: string): string => printScheme(parseSexprs(s)[0]);
  const roundtrip = (s: string): string => printScheme(readSugarcoatExpr(render(s)));
  for (const s of [
    '(str "a " x " b")',
    '(string-append "Pitch \\"" product "\\" now")',
    '(str "role: " (field lead "role"))',
  ])
    it(`round-trips ${s}`, () => expect(roundtrip(s)).toBe(canon(s)));
});

describe("render: multi-line (str …) → @dedent{…} (the pretty projection)", () => {
  it("newline-bearing str renders as an indented @dedent block", () => {
    const scheme = '(str "Pitch\\nThis one\\nOne sentence")';
    expect(render(scheme)).toBe("@dedent{Pitch\n  This one\n  One sentence}");
  });
  it("interpolations ride along the dedent block (guarded when a symbol-char follows)", () => {
    const scheme = '(str "Hi " name "!\\nBye " x)';
    expect(render(scheme)).toBe("@dedent{Hi @|name|!\n  Bye @x}");
  });
  it("a value with intrinsic indent falls back to verbatim @{…} (dedent would eat it)", () => {
    const scheme = '(str "head\\n    indented body")';
    expect(render(scheme)).toBe("@{head\n    indented body}");
  });
});

describe("read∘render = id (the moat) for multi-line at-expressions", () => {
  const canon = (s: string): string => printScheme(parseSexprs(s)[0]);
  const roundtrip = (s: string): string => printScheme(readSugarcoatExpr(render(s)));
  for (const s of [
    '(str "Pitch\\nThis one\\nOne sentence")',
    '(str "Hi " name "!\\nBye " x)',
    '(str "head\\n    indented body")', // vmin>0 verbatim path
    // V's example, canonical
    '(str "Pitch \\"" product "\\" to " audience ".\\nThis one is a " (field lead "role") ".\\nMake it land.")',
  ])
    it(`round-trips ${s}`, () => expect(roundtrip(s)).toBe(canon(s)));
});
