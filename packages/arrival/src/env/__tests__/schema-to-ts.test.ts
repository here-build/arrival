// schema-to-ts — the harvest printer's verdict suite. Proves the zod-schema → TS
// type-STRING mapping is exact for: native identity primitives, the rosetta codec
// family, compounds (object/array/tuple/union), and the full `signatureOf` over a
// sampled native def, a rosetta def, and a multiple-values output.
import { describe, expect, it } from "vitest";
import * as z from "../scheme-zod.js";
import { symbol } from "../symbol.js";
import { printType, signatureOf } from "../schema-to-ts.js";

describe("printType — native identity primitives (z.instanceof → class name)", () => {
  it("prints z.pair as its class name", () => {
    expect(printType(z.pair)).toBe("APair");
  });
  it("prints z.schemeString as its class name", () => {
    expect(printType(z.schemeString)).toBe("AString");
  });
  it("prints each numeric-tower identity term", () => {
    expect(printType(z.schemeExact)).toBe("AExact");
    expect(printType(z.schemeInexact)).toBe("AInexact");
  });
  it("prints the rest of the scheme-identity primitives", () => {
    expect(printType(z.symbol)).toBe("ASymbol");
    expect(printType(z.svector)).toBe("AVector");
    expect(printType(z.sbytevector)).toBe("ABytevector");
    expect(printType(z.nil)).toBe("ANil");
    expect(printType(z.schemeBool)).toBe("ABool");
    expect(printType(z.schemeChar)).toBe("ACharacter");
  });
  it("prints a union of identity primitives as 'A | B' (override fires per-member)", () => {
    expect(printType(z.schemeNumber)).toBe("AExact | AInexact");
  });
});

describe("printType — rosetta codecs (decoded JS side, io:output)", () => {
  it("prints the string codec as 'string'", () => {
    expect(printType(z.string)).toBe("string");
  });
  it("prints the boolean / char codecs as their decoded JS type", () => {
    expect(printType(z.boolean)).toBe("boolean");
    expect(printType(z.char)).toBe("string");
  });
  it("prints the number-codec family by its declared JS type", () => {
    expect(printType(z.number)).toBe("number");
    expect(printType(z.integer)).toBe("number");
    expect(printType(z.bigint)).toBe("bigint");
  });
});

describe("printType — compounds", () => {
  it("prints z.object as a single-line member list (no dangling semicolon)", () => {
    expect(printType(z.object({ k: z.string, n: z.number }))).toBe("{ k: string; n: number }");
  });
  it("prints z.array as variadic 'T[]' (codec element decoded)", () => {
    expect(printType(z.array(z.number))).toBe("number[]");
  });
  it("prints z.array of an identity primitive as 'T[]'", () => {
    expect(printType(z.array(z.pair))).toBe("APair[]");
  });
  it("prints a tuple as '[A, B]'", () => {
    expect(printType(z.tuple([z.string, z.number]))).toBe("[string, number]");
  });
  it("prints a tuple mixing codec + identity members", () => {
    expect(printType(z.tuple([z.pair, z.schemeString]))).toBe("[APair, AString]");
  });
  it("prints a union as 'A | B'", () => {
    expect(printType(z.union([z.string, z.number]))).toBe("string | number");
  });
});

describe("signatureOf — the args-vector → function-signature composer", () => {
  it("composes a native def: scheme-value args, sync return, single-value output", () => {
    const def = symbol.native`cons: build a pair`(
      { input: [z.pair, z.pair], output: [z.pair] },
      (a) => a,
    );
    expect(signatureOf(def)).toBe("(a: APair, b: APair) => APair");
  });

  it("composes a rosetta def: decoded JS args, async (Promise) return", () => {
    const def = symbol.rosetta`pad: left-pad a string to a width`(
      { input: [z.string, z.number], output: [z.string] },
      (s) => s,
    );
    expect(signatureOf(def)).toBe("(a: string, b: number) => Promise<string>");
  });

  it("composes a multiple-values rosetta output as a tuple inside Promise", () => {
    const def = symbol.rosetta`divmod: quotient and remainder`(
      { input: [z.number], output: [z.number, z.number] },
      (n) => [n, n] as [number, number],
    );
    expect(signatureOf(def)).toBe("(a: number) => Promise<[number, number]>");
  });

  it("composes a multiple-values NATIVE output as a bare tuple (sync)", () => {
    const def = symbol.native`split: car and cdr`(
      { input: [z.pair], output: [z.pair, z.pair] },
      (p) => [p, p] as [typeof p, typeof p],
    );
    expect(signatureOf(def)).toBe("(a: APair) => [APair, APair]");
  });

  it("composes a variadic (z.array) input as a rest parameter", () => {
    const def = symbol.rosetta`sum: add all numbers`(
      { input: z.array(z.number), output: [z.number] },
      (...ns: number[]) => ns.reduce((a, b) => a + b, 0),
    );
    expect(signatureOf(def)).toBe("(...args: number[]) => Promise<number>");
  });

  it("composes a 0-arg contract as '()'", () => {
    const def = symbol.rosetta`now: current epoch millis`(
      { input: [], output: [z.number] },
      () => Date.now(),
    );
    expect(signatureOf(def)).toBe("() => Promise<number>");
  });

  it("renders an omitted-verb door as 'never' (not callable)", () => {
    const def = symbol.notImplemented`eval: arbitrary evaluation is a door`;
    expect(signatureOf(def)).toBe("never");
  });
});
