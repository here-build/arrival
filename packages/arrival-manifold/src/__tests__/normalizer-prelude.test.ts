// normalizer/prelude — pins for the scheme-facing prelude functions over the response-
// normalizer parsers (docs/response-normalizer.md §3.5, inferred zone). These functions
// are called here as plain JS — driving them through an actual scheme interpreter is the
// maintainer's binding-integration step, out of scope here. The design law under test is
// errors-as-doors: success returns the parsed value directly (never a {ok,...} record),
// and every refusal THROWS a recoverable Error whose message names why, so a caller can
// read the reason and pick another parser or give up — never silently mis-branch on a
// boolean it forgot to check.

import { describe, expect, it } from "vitest";

import {
  detectEnvelopeValue,
  detectParseValue,
  NORMALIZER_PRELUDE_DOC,
  NORMALIZER_PRELUDE_SYMBOLS,
  parseCsv,
  parseJson,
  parsePyLiteral,
  parseToon,
} from "../normalizer/prelude.js";

describe("parseJson", () => {
  it("returns the parsed value on a top-level object", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("throws a recoverable Error naming the scalar-yield reason on '123'", () => {
    expect(() => parseJson("123")).toThrow(Error);
    expect(() => parseJson("123")).toThrow(/scalar/);
  });

  it("prefixes the thrown message with the format name", () => {
    expect(() => parseJson("123")).toThrow(/^json: /);
  });
});

describe("parseCsv", () => {
  it("returns a vector of records for valid CSV", () => {
    const result = parseCsv("name,age,city\nAlice,30,NYC\nBob,25,LA\nCara,22,SF");
    expect(result).toEqual([
      { name: "Alice", age: "30", city: "NYC" },
      { name: "Bob", age: "25", city: "LA" },
      { name: "Cara", age: "22", city: "SF" },
    ]);
  });

  it("throws on the address-list counterexample (audit F5)", () => {
    const input = "123 Main St, Springfield\n456 Oak Ave, Shelbyville\n789 Elm Rd, Capital City";
    expect(() => parseCsv(input)).toThrow(Error);
    expect(() => parseCsv(input)).toThrow(/^csv: /);
  });
});

describe("parseToon", () => {
  it("decodes a well-formed TOON tabular field", () => {
    const input = "users[2]{id,name}:\n  1,Alice\n  2,Bob";
    expect(parseToon(input)).toEqual({
      users: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ],
    });
  });

  it("throws on a truncation mismatch — [3] declared, 2 rows present", () => {
    const input = "users[3]{id,name}:\n  1,Alice\n  2,Bob";
    expect(() => parseToon(input)).toThrow(Error);
    expect(() => parseToon(input)).toThrow(/declared length \[3\]/);
    expect(() => parseToon(input)).toThrow(/^toon: /);
  });
});

describe("parsePyLiteral", () => {
  it("parses a string-keyed dict literal with True/None into a JS value", () => {
    expect(parsePyLiteral("{'a': True}")).toEqual({ a: true });
  });

  it("throws on a top-level tuple (does not round-trip)", () => {
    expect(() => parsePyLiteral("(1,2)")).toThrow(Error);
    expect(() => parsePyLiteral("(1,2)")).toThrow(/tuple/i);
    expect(() => parsePyLiteral("(1,2)")).toThrow(/^py-literal: /);
  });
});

describe("detectParseValue", () => {
  it("prefers JSON over NDJSON on a JSON array whose elements each look like an NDJSON row", () => {
    expect(detectParseValue('[{"id":1},{"id":2},{"id":3}]')).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("throws on unrecognized prose, with a message listing the format-specific functions", () => {
    const input = "just some ordinary prose, nothing structured here";
    expect(() => detectParseValue(input)).toThrow(Error);
    expect(() => detectParseValue(input)).toThrow(/no recognized format/);
    expect(() => detectParseValue(input)).toThrow(/parse-json/);
    expect(() => detectParseValue(input)).toThrow(/parse-csv/);
    expect(() => detectParseValue(input)).toThrow(/parse-toon/);
    expect(() => detectParseValue(input)).toThrow(/parse-py-literal/);
  });
});

describe("detectEnvelopeValue", () => {
  it("returns the {raw, value, format, prefix} envelope on the opik prefix case", () => {
    const result = detectEnvelopeValue('[label: read]\n{"a":1}');
    // `format` added (server.ts A1/A2 fix, benchmark-defect-register.md): the envelope
    // shell now names WHICH recognizer matched the structural span, so a caller latching
    // an observed-signature annotation doesn't have to re-derive it from `.value`'s shape.
    expect(result).toEqual({ raw: '{"a":1}', value: { a: 1 }, format: "json", prefix: "[label: read]\n" });
  });

  it("throws on prose ending in a bare scalar (F4 — never envelope a scalar anchor)", () => {
    expect(() => detectEnvelopeValue("Current temperature: 23.5")).toThrow(Error);
  });
});

describe("every thrown error is a plain recoverable Error instance", () => {
  it.each([
    ["parse-json", () => parseJson("123")],
    ["parse-csv", () => parseCsv("123 Main St, Springfield\n456 Oak Ave, Shelbyville")],
    ["parse-toon", () => parseToon("users[3]{id,name}:\n  1,Alice\n  2,Bob")],
    ["parse-py-literal", () => parsePyLiteral("(1,2)")],
    ["detect-parse", () => detectParseValue("just some ordinary prose, nothing structured here")],
    ["detect-envelope", () => detectEnvelopeValue("Current temperature: 23.5")],
  ])("%s throws an instance of Error", (_name, thunk) => {
    let caught: unknown;
    try {
      thunk();
      throw new Error("expected a throw");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});

describe("NORMALIZER_PRELUDE_SYMBOLS", () => {
  it("names exactly the six spec'd scheme-facing symbols, each with a teaching description", () => {
    const names = NORMALIZER_PRELUDE_SYMBOLS.map((symbol) => symbol.name);
    expect(names).toEqual([
      "parse-json",
      "parse-csv",
      "parse-toon",
      "parse-py-literal",
      "detect-parse",
      "detect-envelope",
    ]);
    for (const symbol of NORMALIZER_PRELUDE_SYMBOLS) {
      expect(symbol.description.length).toBeGreaterThan(0);
      expect(typeof symbol.fn).toBe("function");
    }
  });

  it("each descriptor's fn is callable and matches the corresponding named export's behavior", () => {
    const byName = new Map(NORMALIZER_PRELUDE_SYMBOLS.map((symbol) => [symbol.name, symbol.fn]));
    expect(byName.get("parse-json")?.('{"a":1}')).toEqual({ a: 1 });
    expect(() => byName.get("parse-csv")?.("123 Main St, Springfield\n456 Oak Ave, Shelbyville")).toThrow(Error);
  });
});

describe("NORMALIZER_PRELUDE_DOC", () => {
  it("is a non-empty multi-line string teaching the parser family and the recoverable-refusal law", () => {
    expect(typeof NORMALIZER_PRELUDE_DOC).toBe("string");
    expect(NORMALIZER_PRELUDE_DOC.split("\n").length).toBeGreaterThanOrEqual(3);
    expect(NORMALIZER_PRELUDE_DOC.split("\n").length).toBeLessThanOrEqual(6);
    expect(NORMALIZER_PRELUDE_DOC).toMatch(/detect-parse/);
    expect(NORMALIZER_PRELUDE_DOC).toMatch(/recoverable/);
  });
});
