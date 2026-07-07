// schema-to-ts — the harvest printer's verdict suite. Proves the zod-schema → TS
// type-STRING mapping is exact for: native identity primitives, the rosetta codec
// family, compounds (object/array/tuple/union), and the full `signatureOf` over a
// sampled native def, a rosetta def, and a multiple-values output.
import { describe, expect, it } from "vitest";
import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { printType, signatureOf, sTagToTsType } from "../schema-to-ts.js";

describe("printType — native identity primitives (scheme primitive → plain-TS image)", () => {
  it("prints z.pair as Cons<unknown> (so z.pair | z.nil = List<unknown>)", () => {
    expect(printType(z.pair)).toBe("Cons<unknown>");
  });
  it("prints z.schemeString as string", () => {
    expect(printType(z.string)).toBe("string");
  });
  it("prints the numeric tower as exact=bigint / inexact=number", () => {
    expect(printType(z.bigint)).toBe("bigint");
    expect(printType(z.inexact)).toBe("number");
  });
  it("prints the rest of the scheme-identity primitives as their plain-TS image", () => {
    expect(printType(z.symbol)).toBe("string");
    expect(printType(z.svector)).toBe("readonly unknown[]");
    expect(printType(z.sbytevector)).toBe("Uint8Array");
    expect(printType(z.nil)).toBe("null");
    expect(printType(z.boolean)).toBe("boolean");
    expect(printType(z.char)).toBe("string");
  });
  it("prints the representation-blind value primitive as unknown", () => {
    expect(printType(z.value)).toBe("unknown");
  });
  it("prints z.lambda as a callable signature, not degraded to unknown", () => {
    expect(printType(z.lambda)).toBe("(...args: unknown[]) => unknown");
  });
  it("prints a union of primitives as 'A | B' (override fires per-member)", () => {
    expect(printType(z.schemeNumber)).toBe("bigint | number");
  });
  it("prints the list union z.pair | z.nil as Cons<unknown> | null = List<unknown>", () => {
    expect(printType(z.union([z.pair, z.nil]))).toBe("Cons<unknown> | null");
  });
});

describe("printType — unregistered custom leaf hardens to unknown, never throws", () => {
  // Not in scheme-zod.ts's NAMES map → lookupName(schema) is undefined. Before the
  // hardening fix this deferred to zod-to-ts's unrepresentable:"throw" and blew up.
  const unregisteredLeaf = z.custom<{ notAVocabItem: true }>((v) => typeof v === "object");

  it("degrades a bare unregistered custom leaf to 'unknown'", () => {
    expect(printType(unregisteredLeaf)).toBe("unknown");
  });

  it("degrades only the unregistered member inside a union, sibling members unaffected", () => {
    expect(printType(z.union([z.string, unregisteredLeaf]))).toBe("string | unknown");
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
    expect(printType(z.array(z.pair))).toBe("Cons<unknown>[]");
  });
  it("prints a tuple as '[A, B]'", () => {
    expect(printType(z.tuple([z.string, z.number]))).toBe("[string, number]");
  });
  it("prints a tuple mixing codec + identity members", () => {
    expect(printType(z.tuple([z.pair, z.string]))).toBe("[Cons<unknown>, string]");
  });
  it("prints a union as 'A | B'", () => {
    expect(printType(z.union([z.string, z.number]))).toBe("string | number");
  });
});

describe("sTagToTsType — the s/* schema-DSL tag → TS type-string bridge", () => {
  // `tagToJsonSchema`'s object case sets `additionalProperties: false` — zod's
  // reconstruction (`z.fromJSONSchema`) renders that as an explicit index
  // signature banning extra keys, so every object in these expectations carries
  // a trailing `[x: string]: never` member (real, correct TS — not noise).
  it("prints an object tag's scalar fields", () => {
    expect(sTagToTsType(["object", ["title", "string"], ["count", "number"]])).toBe(
      "{ title: string; count: number; [x: string]: never }",
    );
  });
  it("a field description prints as a JSDoc comment (zod-to-ts's own convention)", () => {
    expect(sTagToTsType(["object", ["summary", "string", "a one-line summary"]])).toBe(
      "{ /** a one-line summary */ summary: string; [x: string]: never }",
    );
  });
  it("prints a nested array field", () => {
    expect(sTagToTsType(["object", ["tags", ["array", "string"]]])).toBe(
      "{ tags: string[]; [x: string]: never }",
    );
  });
  it("prints a nested object field", () => {
    expect(sTagToTsType(["object", ["author", ["object", ["name", "string"]]]])).toBe(
      "{ author: { name: string; [x: string]: never }; [x: string]: never }",
    );
  });
  it("an optional field's /optional suffix drops it from `required` — TS marks it `?` (zod's own `?: T | undefined`)", () => {
    expect(sTagToTsType(["object", ["title", "string"], ["nickname", "string/optional"]])).toBe(
      "{ title: string; nickname?: string | undefined; [x: string]: never }",
    );
  });
  it("a malformed/unrepresentable tag degrades to unknown, never throws", () => {
    expect(sTagToTsType(["object", ["bad"]])).toBe("unknown");
    expect(sTagToTsType(null)).not.toBeUndefined();
  });
});

describe("signatureOf — the args-vector → function-signature composer", () => {
  it("honors an author-asserted `type` override on the contract — the zod schema stays the MEMBRANE description (runtime decode/validate), `type` is a separate, decoupled TYPE-LEVEL narrowing for the harvest (mirrors legacy RosettaSpec.type/RosettaFunction.type)", () => {
    const def = symbol.native`typed-override: proof`(
      { input: [z.value], output: [z.value], type: "(ip: SchemeIP) => SchemeIP" },
      (a) => a,
    );
    expect(signatureOf(def)).toBe("(ip: SchemeIP) => SchemeIP");
  });

  it("composes a native def: scheme-value args, sync return, single-value output", () => {
    const def = symbol.native`cons: build a pair`(
      { input: [z.pair, z.pair], output: [z.pair] },
      (a) => a,
    );
    expect(signatureOf(def)).toBe("(a: Cons<unknown>, b: Cons<unknown>) => Cons<unknown>");
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
    expect(signatureOf(def)).toBe("(a: Cons<unknown>) => [Cons<unknown>, Cons<unknown>]");
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

  it("composes a kwargs (object) input as a plain object param (the model fills it as :key value)", () => {
    const def = symbol.rosetta`create_user: make a user`(
      { input: [], inputRest: { name: z.string, mode: z.enum(["fast", "scenic"]).optional() }, output: [z.string] },
      () => "",
    );
    expect(signatureOf(def)).toBe(
      '(a: { name: string; mode?: ("fast" | "scenic") | undefined }) => Promise<string>',
    );
  });
});
