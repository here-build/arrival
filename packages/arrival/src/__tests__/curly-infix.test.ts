// SRFI-105 curly-infix `{ … }` — reader integration (read direction), OPT-IN.
//
// Since the collection-literal rework (docs/working-proposals/arrival-curly-vector-literals.md)
// `{…}` reads as a DICT literal and `[…]` as a VECTOR literal by default; SRFI-105
// curly-infix survives behind `ParserOptions.curlyInfix` (mutually exclusive on the `{}`
// delimiter — `[…]` is a vector literal in BOTH modes). This file covers the opt-in flag
// surface verbatim (the pre-rework behavior) plus the flag gate itself; the DEFAULT-mode
// literal grammar is pinned by the language-portable corpus (spec/corpus/ + its runner,
// spec-corpus.test.ts).
//
// Drives `new Lexer` / `new Parser` directly (no exec/stdlib), mirroring lexer.test.ts
// and parser.test.ts. Assertions round-trip through `toString()`: `{a + b}` reads to the
// datum `(+ a b)`, so a normal list serialization proves the transform happened at read
// time — no render change is involved.
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { eof } from "../values/primitives/EOF.js";
import { Lexer } from "../reader/Lexer.js";
import { EOF } from "../values/primitives/EOF.js";
import { Parser } from "../reader/Parser.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AVector } from "../values/primitives/AVector.js";
import { canonicalizeCurly, FIXITY } from "../reader/curly-infix.js";
import { isDictLiteralNode } from "../values/dict-literal.js";
import type { SchemeValue } from "../values/types.js";

function lex(input: string): string[] {
  const lexer = new Lexer(input);
  const out: string[] = [];
  while (true) {
    const token = lexer.peek();
    if (token === eof) break;
    out.push(token as string);
    lexer.skip();
  }
  return out;
}

async function readAll(src: string, curlyInfix = true): Promise<SchemeValue[]> {
  const parser = new Parser({ curlyInfix });
  parser.parse(src);
  const out: SchemeValue[] = [];
  while (true) {
    const obj = await parser.read_object();
    if (obj instanceof EOF) break;
    out.push(obj as SchemeValue);
  }
  return out;
}

// Reads ONE datum under the curly-infix flag (the legacy surface this file covers).
async function readOne(src: string): Promise<string> {
  const [datum] = await readAll(src);
  return String((datum as { toString(): string }).toString());
}

describe("curly-infix — lexer tokenization", () => {
  it("splits braces as standalone tokens", () => {
    expect(lex("{a + b}")).toEqual(["{", "a", "+", "b", "}"]);
  });
  it("tokenizes empty braces", () => {
    expect(lex("{}")).toEqual(["{", "}"]);
  });
  it("keeps a hyphenated symbol whole (only whitespace-bounded operators split)", () => {
    expect(lex("{n-1 + n-2}")).toEqual(["{", "n-1", "+", "n-2", "}"]);
  });
  it("nests braces", () => {
    expect(lex("{a * {b + c}}")).toEqual(["{", "a", "*", "{", "b", "+", "c", "}", "}"]);
  });
  it("splits a trailing brace off a symbol", () => {
    expect(lex("a}")).toEqual(["a", "}"]);
  });
  it("square brackets tokenize standalone", () => {
    expect(lex("[a b]")).toEqual(["[", "a", "b", "]"]);
  });
  it("comma is a delimiter (R7RS): it splits off an adjacent atom", () => {
    expect(lex("[1, 2]")).toEqual(["[", "1", ",", "2", "]"]);
    expect(lex("{:a 1, :b 2}")).toEqual(["{", ":a", "1", ",", ":b", "2", "}"]);
  });
  it("`,@` stays one token; `#\\,` stays one character literal", () => {
    expect(lex(",@x")).toEqual([",@", "x"]);
    expect(lex("#\\, x")).toEqual(["#\\,", "x"]);
  });
});

describe("curly-infix — SRFI-105 base classifier (flag on)", () => {
  it("empty → ()", async () => {
    expect(await readOne("{}")).toBe("()");
  });
  it("single element escapes", async () => {
    expect(await readOne("{x}")).toBe("x");
  });
  it("two elements → prefix/unary", async () => {
    expect(await readOne("{- x}")).toBe("(- x)");
  });
  it("binary → prefix", async () => {
    expect(await readOne("{a + b}")).toBe("(+ a b)");
  });
  it("same-operator run → n-ary", async () => {
    expect(await readOne("{a + b + c}")).toBe("(+ a b c)");
    expect(await readOne("{a + b + c + d}")).toBe("(+ a b c d)");
  });
  it("nested curly on the right", async () => {
    expect(await readOne("{a * {b + c}}")).toBe("(* a (+ b c))");
  });
  it("nested curly on the left", async () => {
    expect(await readOne("{{a + b} - c}")).toBe("(- (+ a b) c)");
  });
  it("hyphenated operands stay whole", async () => {
    expect(await readOne("{n-1 + n-2}")).toBe("(+ n-1 n-2)");
  });
});

describe("curly-infix — arithmetic precedence (our formal divergence, flag on)", () => {
  it("multiplicative binds tighter than additive", async () => {
    expect(await readOne("{4 + 5 * 6}")).toBe("(+ 4 (* 5 6))");
    expect(await readOne("{a * b + c}")).toBe("(+ (* a b) c)");
    expect(await readOne("{a + b * c}")).toBe("(+ a (* b c))");
  });
  it("same-level mixed operators fold left-associatively", async () => {
    expect(await readOne("{a + b - c}")).toBe("(- (+ a b) c)");
  });
  it("additive run stays n-ary while multiplicative collapses to one operand", async () => {
    expect(await readOne("{a + b * c + d}")).toBe("(+ a (* b c) d)");
    expect(await readOne("{a * b * c + d}")).toBe("(+ (* a b c) d)");
  });
  it("named arithmetic operators are licensed", async () => {
    expect(await readOne("{10 modulo 3 + 1}")).toBe("(+ (modulo 10 3) 1)");
  });
});

describe("curly-infix — any single operator folds (SRFI-105, flag on)", () => {
  it("a lone boolean/comparison operator is a plain binary", async () => {
    expect(await readOne("{a && b}")).toBe("(&& a b)");
    expect(await readOne("{a < b}")).toBe("(< a b)");
  });
  it("a same-operator run folds n-ary regardless of which operator", async () => {
    expect(await readOne("{a && b && c}")).toBe("(&& a b c)");
    expect(await readOne("{a < b < c}")).toBe("(< a b c)");
  });
  it("any symbol in operator position is the operator", async () => {
    expect(await readOne("{a b c}")).toBe("(b a c)");
  });
});

describe("curly-infix — errors-as-door for MIXED operators (never emits $nfx$, flag on)", () => {
  // NOTE: `||` is R7RS pipe-symbol syntax (`|sym|`), so we use `&&`/`and`/`<` here.
  // The `||`→`or` (and `&&`→`and`, `==`→`equal?`) glyph map is a separate, deferred sweet feature.
  it("doors on mixed boolean/comparison operators", async () => {
    await expect(readOne("{a && b and c}")).rejects.toThrow("ambiguous operator mix");
    await expect(readOne("{a < b && c}")).rejects.toThrow("ambiguous operator mix");
  });
  it("doors on arithmetic mixed with an unlicensed operator, with a teaching hint", async () => {
    await expect(readOne("{a + b < c}")).rejects.toThrow("ambiguous operator mix");
    await expect(readOne("{a + b < c}")).rejects.toThrow("{{a + b} < c}");
  });
  it("doors on malformed parity / trailing operator", async () => {
    await expect(readOne("{a + b +}")).rejects.toThrow("malformed infix");
    await expect(readOne("{+ a + b}")).rejects.toThrow("malformed infix");
  });
  it("doors on a non-operator wedged into an operator slot", async () => {
    await expect(readOne("{a + b 5 c}")).rejects.toThrow("malformed infix");
  });
});

describe("curly-infix — quote distribution (flag on)", () => {
  it("quote wraps the resolved datum", async () => {
    expect(await readOne("'{a + b}")).toBe("(quote (+ a b))");
    expect(await readOne("'{a + b + c}")).toBe("(quote (+ a b c))");
  });
  it("quasiquote/unquote compose", async () => {
    expect(await readOne("`{,a + ,b}")).toBe("(quasiquote (+ (unquote a) (unquote b)))");
  });
});

describe("curly-infix — non-regression (flag on)", () => {
  it("square brackets read as a vector literal even in infix mode (flag scopes `{}` only)", async () => {
    const [datum] = await readAll("[a b]");
    expect(datum).toBeInstanceOf(AVector);
    expect((datum as AVector).evalElements).toBe(true);
    expect((datum as AVector).__vector__.map(String)).toEqual(["a", "b"]);
  });
  it("parenthesized forms unchanged", async () => {
    expect(await readOne("(+ 1 2)")).toBe("(+ 1 2)");
  });
  it("curly nested inside a normal list", async () => {
    expect(await readOne("(a {b + c} d)")).toBe("(a (+ b c) d)");
  });
  it("a vector literal is a valid infix OPERAND", async () => {
    const [datum] = await readAll("{[a b] ++ c}");
    // (++ [a b] c) — the vector rides the infix transform as an ordinary operand
    expect(String((datum as { toString(): string }).toString())).toContain("++");
  });
  it("reads multiple top-level curly forms", async () => {
    const out = await readAll("{a + b} {c * d}");
    expect(out.map((d) => String(d))).toEqual(["(+ a b)", "(* c d)"]);
  });
});

describe("curly-infix — structural errors (flag on)", () => {
  it("unterminated brace", async () => {
    await expect(readOne("{a + b")).rejects.toThrow("unterminated curly-infix");
  });
  it("stray closing brace", async () => {
    await expect(readOne("}")).rejects.toThrow("unexpected '}'");
  });
  it("dotted pair is rejected inside curly", async () => {
    await expect(readOne("{a . z}")).rejects.toThrow("'.' not allowed in curly-infix");
  });
  it("deep nesting trips the stack-depth guard", async () => {
    await expect(readOne("{".repeat(3000))).rejects.toThrow("nesting depth exceeded");
  });
  it("a `(` closed by `}` is a mismatch", async () => {
    await expect(readOne("(a}")).rejects.toThrow("mismatched bracket: expected ')' but found '}'");
  });
  it("a `{` closed by `)` is a mismatch", async () => {
    await expect(readOne("{a + b)")).rejects.toThrow("mismatched bracket: expected '}' but found ')'");
  });
  it("a stray `)` is rejected", async () => {
    await expect(readOne(")")).rejects.toThrow("unexpected ')'");
  });
});

describe("the flag gate — default (flag OFF) is the dict/vector literal grammar", () => {
  it("default `{}` is a dict literal node, not curly-infix", async () => {
    const [datum] = await readAll("{:a 1}", false);
    expect(isDictLiteralNode(datum)).toBe(true);
  });
  it("default `{a + b}` doors as a malformed dict literal (bad bare-symbol key), not infix", async () => {
    // Key validation runs BEFORE the arity check (the suffix-keyword flip's Σ-mirror ordering):
    // the bare `a` at key position is the FIRST problem the incremental judge sees.
    await expect(readAll("{a + b}", false)).rejects.toThrow(/key must be a :keyword/);
  });
  it("flag ON keeps `{:a 1}` as INFIX input — `:a` in operator position", async () => {
    // {x op y} with op = `1`? No: 3 elements, operator slot holds `1` — same-operator
    // classifier folds `(1 :a ... )`? No — `1` is not a symbol, so it doors.
    await expect(readOne("{:a 1 :b}")).rejects.toThrow("malformed infix");
  });
  it("`[…]` is a vector literal in both modes", async () => {
    for (const flag of [true, false]) {
      const [datum] = await readAll("[1 2]", flag);
      expect(datum).toBeInstanceOf(AVector);
      expect((datum as AVector).evalElements).toBe(true);
      expect((datum as AVector).frozen).toBe(true);
    }
  });
});

describe("curly-infix — pure module is independently testable", () => {
  it("FIXITY licenses exactly the arithmetic operators", () => {
    expect(Object.keys(FIXITY).sort()).toEqual(
      ["*", "+", "-", "/", "modulo", "quotient", "remainder"].sort(),
    );
    expect(FIXITY["*"].prec).toBeGreaterThan(FIXITY["+"].prec);
  });
  it("canonicalizeCurly escapes a single element", () => {
    const sym = new ASymbol(CONSTANT_CTX, "x");
    expect(canonicalizeCurly([sym])).toBe(sym);
  });
});
