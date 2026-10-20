// Reader regressions: #!fold-case scope, datum labels inside vector/dict literals,
// unterminated lists, and bytevector literal element validation.
import { describe, expect, it } from "vitest";
import { parse } from "../parse.js";
import { exec } from "../../index.js";
import { Unterminated, ParseError } from "../../errors.js";
import { AString } from "../../values/primitives/AString.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AVector } from "../../values/primitives/AVector.js";
import { ABytevector } from "../../values/primitives/ABytevector.js";
import { tokenize } from "../tokenize.js";

describe("#!fold-case folds identifiers only", () => {
  it("leaves string contents alone", async () => {
    const [s] = await parse('#!fold-case "Hello"');
    expect(s).toBeInstanceOf(AString);
    expect(String(s.valueOf())).toBe("Hello");
  });

  it("folds identifiers but not |bar| symbols", async () => {
    const [a, b] = await parse("#!fold-case FooBar |Foo|");
    expect(a).toBeInstanceOf(ASymbol);
    expect(String(a)).toBe("foobar");
    expect(String(b)).toBe("Foo");
  });

  it("folds character NAMES but not single-char literals", async () => {
    const [name, single] = await parse(String.raw`#!fold-case #\SPACE #\A`);
    expect(name).toBeInstanceOf(ACharacter);
    expect(String(name.valueOf())).toBe(" ");
    expect(String(single.valueOf())).toBe("A");
  });

  it("#!no-fold-case switches it back off", async () => {
    const [a, b] = await parse("#!fold-case ABC #!no-fold-case ABC");
    expect([String(a), String(b)]).toEqual(["abc", "ABC"]);
  });
});

describe("datum labels inside vector, [] and {} literals", () => {
  const programs: ReadonlyArray<readonly [string, unknown]> = [
    ["'#(#0=(a) #0#)", [["a"], ["a"]]],
    ["'[#0=(a) #0#]", [["a"], ["a"]]],
    ["'(#0=(a) #(#0#))", [["a"], [["a"]]]],
    ["'{:k #0=(a) :j #0#}", { k: ["a"], j: ["a"] }],
    ["'(#0=(a) #((#0#)))", [["a"], [[["a"]]]]],
  ];
  for (const [program, expected] of programs) {
    it(`${program} reads to plain data`, async () => {
      const [result] = await exec(program);
      // eslint-disable-next-line unicorn/prefer-structured-clone -- deliberate JSON round-trip: asserts the result survives JSON serialisation as plain data (structuredClone would keep non-JSON values)
      expect(JSON.parse(JSON.stringify(result))).toEqual(expected);
    });
  }

  it("a cycle through a vector literal resolves to the vector itself", async () => {
    const [vec] = await parse("#0=#(a #0#)");
    expect((vec as AVector).__vector__[1]).toBe(vec);
  });

  it("a cycle through a dict literal is a door, not a leaked placeholder", async () => {
    await expect(parse("#0={:a #0#}")).rejects.toMatchObject({ code: "E-DATUM-LABEL-CYCLE" });
  });
});

describe("unterminated list", () => {
  for (const src of ["(a b", "(a (b c)", "#(1 2", "#u8(1 2"]) {
    it(`${src} throws Unterminated with a location`, async () => {
      const err = await parse(src).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(err).toBeInstanceOf(Unterminated);
      expect((err as Unterminated).code).toBe("E-UNTERMINATED");
      expect((err as Unterminated).location).toBeDefined();
    });
  }

  it("stray close paren still throws ParseError", async () => {
    await expect(parse("a)")).rejects.toBeInstanceOf(ParseError);
  });
});

describe("bytevector literals", () => {
  it("accepts exact integers 0..255", async () => {
    const [bv] = await parse("#u8(0 1 255)");
    expect(bv).toBeInstanceOf(ABytevector);
    expect([...(bv as ABytevector).valueOf()]).toEqual([0, 1, 255]);
  });

  for (const src of ["#u8(1 2 256)", "#u8(a)", "#u8(1 -1)", "#u8(1.0)", "#u8(1/2)", '#u8("x")']) {
    it(`${src} is a ParseError door`, async () => {
      await expect(parse(src)).rejects.toMatchObject({ name: "ParseError", code: "E-BYTEVECTOR-ELEMENT" });
    });
  }
});

describe("tokenize", () => {
  it("yields meta tokens, whitespace included", () => {
    expect(tokenize("(a b)", true).map((t) => t.token)).toEqual(["(", "a", " ", "b", ")"]);
  });
});

// Found by the grammar-ebnf property (seed -69648676 path "154", counterexample "||`"): a closing bar
// composes with the adjacent non-delimiter characters into ONE symbol (`:|24|`, `a|b|c`), so `||`` is
// the symbol named backtick, not an empty symbol plus a swallowed quasiquote. The eBNF grammar was
// the side that was wrong; these rows pin the reader's composition and the dangling-prefix errors.
describe("bar-symbol composition vs dangling quote prefixes", () => {
  const names: [string, string][] = [
    ["||`", "`"],
    ["|x|`", "x`"],
    ["|x|`y", "x`y"],
    ['|x|"', 'x"'],
    ["|x|;", "x;"],
    ["a|x|", "ax"],
    ["|a b|c", "a bc"],
  ];
  it.each(names)("%s reads as one symbol named %j", async (src, name) => {
    const forms = await parse(src);
    expect(forms).toHaveLength(1);
    expect(forms[0]).toBeInstanceOf(ASymbol);
    expect(String(forms[0])).toBe(name);
  });

  const prefixes = ["`", "'", ",", ",@", "#'", "#,"];
  const heads = ["", "a ", "|x| ", "|| ", '"x" ', "(a)", "()", "|x|", "||"];
  // `||`` / `|x|`` are composed symbols (rows above), not dangling prefixes.
  const composed = new Set(["||`", "|x|`"]);
  const dangling = heads
    .flatMap((h) => prefixes.map((p) => h + p))
    .filter((src) => !composed.has(src))
    .map((src) => [src] as [string]);
  it.each(dangling)("dangling prefix %j at EOF raises the taught Unterminated error", async (src) => {
    await expect(parse(src)).rejects.toBeInstanceOf(Unterminated);
    await expect(parse(src)).rejects.toThrow(/Expecting expression, eof found/);
  });

  it.each([
    ["`", "E-UNTERMINATED"],
    ["|| '", "E-UNTERMINATED"],
    ["||'", "E-UNTERMINATED"],
    ["|x|,@", "E-UNTERMINATED"],
  ])("%j has code %s", async (src, code) => {
    await expect(parse(src)).rejects.toMatchObject({ code });
  });

  // Siblings the 100k-run sweep surfaced.
  it.each(["#;;\n", "#; ;\n", "a #;;\n", "#;#|c|#"])("dangling datum comment %j is Unterminated", async (src) => {
    await expect(parse(src)).rejects.toBeInstanceOf(Unterminated);
  });

  it("a datum comment followed by a comment then a datum still skips that datum", async () => {
    expect(await parse("#;;x\n1")).toHaveLength(0);
    expect(await parse("1 #;;x\n2")).toHaveLength(1);
  });

  it.each(["#1(1#", "#1 foo 2#"])("non-label %j after # + digit is an invalid token, not a symbol", async (src) => {
    await expect(parse(src)).rejects.toMatchObject({ code: "E-LEXER-INVALID-TOKEN" });
  });

  it(String.raw`##\a is not the character #\a (anchored multi-codepoint char match)`, async () => {
    const [form] = await parse(String.raw`##\a`);
    expect(form).toBeInstanceOf(ASymbol);
    await expect(parse(String.raw`##\|`)).rejects.toMatchObject({ code: "E-SYMBOL-BAR-UNTERMINATED" });
  });

  it("[:`] keeps `:`` as one keyword-ish symbol", async () => {
    const [vec] = await parse("[:`]");
    expect(vec).toBeInstanceOf(AVector);
  });
});
