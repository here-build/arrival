import { describe, expect, it } from "vitest";

import { schemeToSugarcoat, printScheme, parseSexprs } from "../sugarcoat-render.js";
import { readSugarcoatExpr, readSugarcoat } from "../sugarcoat-read.js";

const render = (scheme: string, opts = {}): string => schemeToSugarcoat(scheme, opts).trim();
const read1 = (sugarcoat: string): string => printScheme(readSugarcoatExpr(sugarcoat));
const canon = (scheme: string): string => printScheme(parseSexprs(scheme)[0]);
const roundtrip = (scheme: string, opts = {}): string => printScheme(readSugarcoatExpr(render(scheme, opts)));
// Multi-line I-expression output (broken if/begin/cond) must round-trip through the
// whole-program reader (indentation grouping), not the single-expression reader.
const roundtripAll = (scheme: string, opts = {}): string =>
  readSugarcoat(render(scheme, opts)).map((f) => printScheme(f)).join("\n");

// ── 1. lone-unary → method dot, gated on `?`-predicates / `->`-conversions / allow ──
// The §5 gate flipped: a lone unary now surfaces as `x.f` when the head reads well
// postfix (a predicate, a conversion, or a curated well-known op). `not`/generic
// verbs stay prefix. Round-trip is the moat — the reader folds any `x.f` back.
describe("lone-unary → method dot (gated)", () => {
  const flips: Array<[string, string]> = [
    ["(list? x)", "x.list?"],
    ["(length x)", "x.length"],
    ["(null? xs)", "xs.null?"],
    ["(err? result)", "result.err?"],
    ["(number->string view)", "view.number->string"], // `->` conversion family
    ["(reverse xs)", "xs.reverse"], // curated allow
    ["(string-upcase s)", "s.string-upcase"],
  ];
  for (const [scheme, sugarcoat] of flips)
    it(`${scheme} → ${sugarcoat}`, () => expect(render(scheme)).toBe(sugarcoat));

  const stayPrefix: string[] = [
    "(not p)", // `not` reads worse postfix — kept prefix
    "(display x)", // generic verb, not in allow set
    "(foo x)", // unknown unary
    "(map car xs)", // `car` passed as a VALUE, not a receiver step
  ];
  for (const s of stayPrefix) it(`${s} stays prefix`, () => expect(render(s)).toBe(s));

  // V's exact example: ok? collapses to the method-chain reading
  it("ok? predicate body collapses (V's example)", () => {
    expect(render("(and (list? x) (= (length x) 2) (eq? (car x) 'ok))")).toBe("{x.list? && x.length = 2 && x[0] eq? 'ok}");
  });

  for (const [scheme] of flips) it(`round-trips ${scheme}`, () => expect(roundtrip(scheme)).toBe(canon(scheme)));
});

// ── 2. `if` always breaks: condition on the head line, arms on their own lines ──
describe("if always breaks (condition on head line, arms below)", () => {
  it("small if breaks", () => expect(render("(if a b c)")).toBe("if a\n  b\n  c"));
  it("two-arm if breaks", () => expect(render("(if a b)")).toBe("if a\n  b"));
  it("keeps a short condition on the head line", () => {
    expect(render("(if (null? xs) 0 (fold-left f x y))")).toBe("if xs.null?\n  0\n  (fold-left f x y)");
  });
  for (const s of ["(if a b c)", "(if (null? xs) 0 (fold-left f x y))"])
    it(`round-trips ${s}`, () => expect(roundtripAll(s)).toBe(canon(s)));
});

// ── 3. `begin` always breaks: every step on its own line, none pulled onto head ──
describe("begin always breaks (steps each on a line, none on the head)", () => {
  it("steps break", () => expect(render("(begin a b c)")).toBe("begin\n  a\n  b\n  c"));
  it("no first-step pull onto the begin line", () => {
    expect(render("(begin (foo) (bar))")).toBe("begin\n  (foo)\n  (bar)");
  });
  for (const s of ["(begin a b c)", "(begin (foo) (bar))"])
    it(`round-trips ${s}`, () => expect(roundtripAll(s)).toBe(canon(s)));
});

// ── 4. cond `=>` clause: the arrow stays connected, never hanging alone ──
describe("cond => clause keeps the arrow connected", () => {
  it("inline when it fits: `test => recv`", () => {
    expect(render("(cond ((foo x) => (bar)) (else (baz)))")).toBe("cond\n  (foo x) => (bar)\n  else\n    (baz)");
  });
  it("wide recv: `test =>` trailing, recv on the next line (never a lone =>)", () => {
    const out = render("(cond ((foo x) => (a-really-quite-long-receiver-call p q r s)) (else (baz)))", { width: 30 });
    expect(out).toContain("(foo x) =>");
    expect(out).not.toMatch(/^\s*=>\s*$/m); // no line that is only `=>`
  });
  for (const s of ["(cond ((foo x) => (bar)) (else (baz)))"])
    it(`round-trips ${s}`, () => expect(readSugarcoat(render(s)).map((f) => printScheme(f)).join("\n")).toBe(canon(s)));
});

// ── 5. `'()` → `nil` surface glyph (sound: reader folds nil back), shadow-guarded ──
describe("'() renders as nil (shadow-aware)", () => {
  it("bare empty-quote → nil", () => expect(render("'()")).toBe("nil"));
  it("empty-quote in position → nil", () => expect(render("(set! x '())")).toBe("(set! x nil)"));
  it("reader folds nil back to '()", () => expect(read1("nil")).toBe("(quote ())"));
  it("round-trips through the glyph", () => expect(roundtrip("(set! x '())")).toBe(canon("(set! x '())")));
  it("shadowed by (define nil <non-empty>) → stays '()", () => {
    const out = schemeToSugarcoat("(define nil 5)\n(set! x '())");
    expect(out).toContain("(set! x '())");
    expect(out).not.toContain("nil)");
  });
  it("explicit (define nil '()) still allows the glyph", () => {
    expect(schemeToSugarcoat("(define nil '())\n(set! x '())")).toContain("(set! x nil)");
  });
});

// ── 6. string-append → @string-append{…} at-expression (SOUND, default) ──
// The graft `@(…)` interpolates any call-form (rendered classic-prefix), so a
// separator-only template with call holes now surfaces — and round-trips.
describe("string-append → @string-append{…} (sound, round-trips)", () => {
  const matchstate =
    '(string-append "MATCHSTATE:" (number->string view) ":" (number->string (state-hand-id state)) ":" (state-betting-string state) ":" (matchstate-holes-string state view) (matchstate-board-string state))';
  it("renders as a single @string-append at-expression", () => {
    expect(render(matchstate)).toBe(
      "@string-append{MATCHSTATE:@(number->string view):@(number->string (state-hand-id state)):@(state-betting-string state):@(matchstate-holes-string state view)@(matchstate-board-string state)}",
    );
  });
  it("round-trips to the exact string-append", () => expect(roundtrip(matchstate)).toBe(canon(matchstate)));
  // colon-separated, no spaces, one call hole
  it("a separator template with a call hole surfaces", () => {
    expect(render('(string-append "a:" (f x) ":b")')).toBe("@string-append{a:@(f x):b}");
  });
});

// ── 7. str-tolerant NORMALIZATION (opt-in): collapse to @{…}, drop redundant coercions ──
// str coerces every arg (repr), so `(number->string x)` inside it is plumbing. This
// is a one-way normalization (reads back as `str`, NOT `string-append`) — hence opt-in.
describe("strTolerant: normalize string-append → str, strip coercions (opt-in)", () => {
  const matchstate =
    '(string-append "MATCHSTATE:" (number->string view) ":" (number->string (state-hand-id state)) ":" (state-betting-string state))';
  it("collapses to @{…} and drops number->string", () => {
    // `@|view|` — the guard-bars are load-bearing: the next literal starts with `:`
    // (an interp-class char), so a bare `@view:` would read the colon into the symbol.
    expect(render(matchstate, { strTolerant: true })).toBe(
      "@{MATCHSTATE:@|view|:@(state-hand-id state):@(state-betting-string state)}",
    );
  });
  it("normalized form reads back as str (not string-append)", () => {
    const back = readSugarcoat(render(matchstate, { strTolerant: true })).map(printScheme).join("\n");
    expect(back).toContain("(str");
    expect(back).toContain("view"); // the number->string wrapper is gone
    expect(back).not.toContain("number->string");
  });
  it("default (no flag) leaves string-append + coercions intact", () => {
    expect(render(matchstate)).toContain("@string-append{");
    expect(render(matchstate)).toContain("number->string");
  });
});
