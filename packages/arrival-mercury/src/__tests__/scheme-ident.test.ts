import { describe, expect, it } from "vitest";
import {
  decodeSchemeIdent,
  encodeSchemeIdent,
  SCHEME_IDENT_CHAR_TOKENS,
  SCHEME_IDENT_RESERVED,
  schemeIdentIsBareTs,
} from "../type-emit/scheme-ident.js";

const ROUNDTRIP: string[] = [
  "car",
  "map",
  "string->number",
  "number->string",
  "null?",
  "string?",
  "list-ref",
  "string-append",
  "chat/completion",
  "config/audience",
  "values-of",
  "set-car!",
  "vector-set!",
  "*",
  "+",
  "-",
  "/",
  "=",
  "<",
  ">",
  "<=",
  ">=",
  "<?",
  "string=?",
  "escape-regex",
  "maybe-ref/default",
  "maybe->list",
  "import",
  "const",
  "class",
  "null",
  "string", // legal TS value binding — must stay bare
  "number",
  "symbol",
  "$x",
  "foo$bar",
  "a$b$c",
  "*globals*",
  "reaction*",
  "@",
  "@?",
  "foo.bar",
  "a:b",
  "100",
  "1st",
  "",
  "你好", // unicode → $u…$
  "a%b&c^d~e",
];

describe("encodeSchemeIdent / decodeSchemeIdent", () => {
  it("round-trips the corpus", () => {
    for (const s of ROUNDTRIP) {
      const enc = encodeSchemeIdent(s);
      expect(decodeSchemeIdent(enc), `roundtrip ${JSON.stringify(s)} → ${enc}`).toBe(s);
    }
  });

  it("encodes documented examples", () => {
    expect(encodeSchemeIdent("string->number")).toBe("string$dash$$greater$number");
    expect(encodeSchemeIdent("null?")).toBe("null$qmark$");
    expect(encodeSchemeIdent("list-ref")).toBe("list$dash$ref");
    expect(encodeSchemeIdent("chat/completion")).toBe("chat$slash$completion");
    expect(encodeSchemeIdent("import")).toBe("$import$");
    expect(encodeSchemeIdent("$x")).toBe("$dollar$x");
    expect(encodeSchemeIdent("+")).toBe("$plus$");
    expect(encodeSchemeIdent("car")).toBe("car");
    expect(encodeSchemeIdent("<=")).toBe("$less$$eq$");
    expect(encodeSchemeIdent(">=")).toBe("$greater$$eq$");
  });

  it("always yields a legal TS IdentifierName shape", () => {
    const ident = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
    for (const s of ROUNDTRIP) {
      const enc = encodeSchemeIdent(s);
      expect(enc, s).toMatch(ident);
      // Must not be a bare reserved word
      expect(SCHEME_IDENT_RESERVED.has(enc) && schemeIdentIsBareTs(enc)).toBe(false);
    }
  });

  it("wraps every reserved whole-name", () => {
    for (const kw of SCHEME_IDENT_RESERVED) {
      expect(encodeSchemeIdent(kw)).toBe(`$${kw}$`);
      expect(decodeSchemeIdent(`$${kw}$`)).toBe(kw);
    }
  });

  it("char token registry is bijective", () => {
    const tokens = Object.values(SCHEME_IDENT_CHAR_TOKENS);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const [ch, tok] of Object.entries(SCHEME_IDENT_CHAR_TOKENS)) {
      expect(encodeSchemeIdent(ch)).toBe(`$${tok}$`);
      expect(decodeSchemeIdent(`$${tok}$`)).toBe(ch);
    }
  });

  it("does not treat predicate as reserved whole-name", () => {
    // `null` is reserved; `null?` is not — only the `?` is tokenized
    expect(encodeSchemeIdent("null?")).toBe("null$qmark$");
    expect(encodeSchemeIdent("null?")).not.toBe("$null$qmark$");
  });

  it("schemeIdentIsBareTs matches encode identity", () => {
    expect(schemeIdentIsBareTs("car")).toBe(true);
    expect(schemeIdentIsBareTs("import")).toBe(false);
    expect(schemeIdentIsBareTs("null?")).toBe(false);
    expect(schemeIdentIsBareTs("list-ref")).toBe(false);
  });

  it("rejects malformed encodings", () => {
    expect(() => decodeSchemeIdent("foo$")).toThrow(/unclosed/);
    expect(() => decodeSchemeIdent("foo$$bar")).toThrow(/empty/);
    expect(() => decodeSchemeIdent("foo$notatoken$")).toThrow(/unknown token/);
  });
});
