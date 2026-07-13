// schema-to-ts — the harvest printer's verdict suite. Proves the zod-schema → TS
// type-STRING mapping is exact for: native identity primitives, the rosetta codec
// family, compounds (object/array/tuple/union), and the full `signatureOf` over a
// sampled native def, a rosetta def, and a multiple-values output.
import { describe, expect, it } from "vitest";
import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { printType, signatureOf, sTagToTsType } from "../schema-to-ts.js";

describe("printType — native identity primitives (scheme primitive → plain-TS image)", () => {
  // REBASELINE (fe2c848ee7, 2026-07-08): `z.pair` is now `cons(value, value)` — a real
  // codec named "cons", not a bare-instanceof "pair" — so it prints via the named-generic
  // pre-check as `Pair<unknown, unknown>`, the same as any other `cons(A, B)`.
  it("prints z.pair as Pair<unknown, unknown> (cons(value, value), not a standalone name)", () => {
    expect(printType(z.pair)).toBe("Pair<unknown, unknown>");
  });
  // INVARIANT: printType(z.string) prints "string".
  it("prints z.schemeString as string", () => {
    expect(printType(z.string)).toBe("string");
  });
  // INVARIANT: the numeric tower prints exact as "bigint" and inexact as "number" via the
  // name-keyed image, not the raw union.
  it("prints the numeric tower as exact=bigint / inexact=number", () => {
    // v2 makes these codecs/unions; the name-keyed image (bigint/inexact→number) prints them once,
    // not the raw union OUT schema (which would be `bigint | bigint` / `bigint | number`).
    expect(printType(z.bigint)).toBe("bigint");
    expect(printType(z.inexact)).toBe("number");
  });
  // INVARIANT: symbol/bytevector/nil/boolean/char each print their documented plain-TS
  // image. (vector's image is covered separately below, pending the dedup gap.)
  it("prints the rest of the scheme-identity primitives as their plain-TS image", () => {
    expect(printType(z.symbol)).toBe("string");
    expect(printType(z.bytevector)).toBe("Uint8Array");
    expect(printType(z.nil)).toBe("null");
    expect(printType(z.boolean)).toBe("boolean");
    expect(printType(z.char)).toBe("string");
  });
  // GAP (ledger/index.law.test.ts GAPS: "schema-to-ts vector union not deduped", gate:
  // "printer dedup follow-up"). vector(E) = union[array(E), array(E)] (two same-output codec
  // branches), and `vector` carries no name-image (its element varies), so it prints the
  // duplicated `unknown[] | unknown[]`. TS collapses it to `unknown[]` at the type level; the
  // IDEAL is a harvest union-member dedup that cleans the printed string to match. Flips green
  // when that dedup lands.
  it.fails("prints z.vector(z.value) deduped as 'unknown[]', not the duplicated union branches", () => {
    expect(printType(z.vector(z.value))).toBe("unknown[]");
  });
  // INVARIANT: z.value (representation-blind) prints as "unknown".
  it("prints the representation-blind value primitive as unknown", () => {
    expect(printType(z.value)).toBe("unknown");
  });
  // INVARIANT: z.lambda prints as a callable signature `(...args: unknown[]) => unknown`,
  // not degraded to unknown.
  it("prints z.lambda as a callable signature, not degraded to unknown", () => {
    expect(printType(z.lambda)).toBe("(...args: unknown[]) => unknown");
  });
  // INVARIANT: a union of primitives prints as "A | B" with the name-override applied per member.
  it("prints a union of primitives as 'A | B' (override fires per-member)", () => {
    // schemeNumber has no name-image → composed per-member; exact→bigint, inexact→number.
    expect(printType(z.schemeNumber)).toBe("bigint | number");
  });
  // REBASELINE (fe2c848ee7): pair no longer carries the "pair"→List-style name; the union
  // composes structurally, member-by-member, same as any other union of a non-list codec + nil.
  it("prints the list union z.pair | z.nil as Pair<unknown, unknown> | null", () => {
    expect(printType(z.union([z.pair, z.nil]))).toBe("Pair<unknown, unknown> | null");
  });
});

describe("printType — unregistered custom leaf hardens to unknown, never throws", () => {
  // Not in scheme-zod.ts's NAMES map → lookupName(schema) is undefined. Before the
  // hardening fix this deferred to zod-to-ts's unrepresentable:"throw" and blew up.
  const unregisteredLeaf = z.custom<{ notAVocabItem: true }>((v) => typeof v === "object");

  // INVARIANT: a bare unregistered custom leaf degrades to "unknown" rather than throwing.
  it("degrades a bare unregistered custom leaf to 'unknown'", () => {
    expect(printType(unregisteredLeaf)).toBe("unknown");
  });

  // INVARIANT: inside a union, only the unregistered member degrades to unknown — sibling
  // members print unaffected.
  it("degrades only the unregistered member inside a union, sibling members unaffected", () => {
    expect(printType(z.union([z.string, unregisteredLeaf]))).toBe("string | unknown");
  });
});

describe("printType — rosetta codecs (decoded JS side, io:output)", () => {
  // INVARIANT: string/boolean/char codecs print their decoded JS type.
  it("prints the string codec as 'string'", () => {
    expect(printType(z.string)).toBe("string");
  });
  it("prints the boolean / char codecs as their decoded JS type", () => {
    expect(printType(z.boolean)).toBe("boolean");
    expect(printType(z.char)).toBe("string");
  });
  // INVARIANT: the number-codec family (number/integer/bigint) prints by its declared JS type.
  it("prints the number-codec family by its declared JS type", () => {
    expect(printType(z.number)).toBe("number");
    expect(printType(z.integer)).toBe("number");
    expect(printType(z.bigint)).toBe("bigint");
  });
});

describe("printType — compounds", () => {
  // INVARIANT: z.object prints as a single-line member list with no dangling semicolon.
  it("prints z.object as a single-line member list (no dangling semicolon)", () => {
    expect(printType(z.object({ k: z.string, n: z.number }))).toBe("{ k: string; n: number }");
  });
  // INVARIANT: z.array prints as variadic "T[]" with the element decoded.
  it("prints z.array as variadic 'T[]' (codec element decoded)", () => {
    expect(printType(z.array(z.number))).toBe("number[]");
  });
  // REBASELINE (fe2c848ee7): see the top-of-describe note on z.pair → Pair<unknown, unknown>.
  // INVARIANT: z.array of an identity primitive prints "T[]" using the primitive's image.
  it("prints z.array of an identity primitive as 'T[]'", () => {
    expect(printType(z.array(z.pair))).toBe("Pair<unknown, unknown>[]");
  });
  // INVARIANT: a tuple prints as "[A, B]".
  it("prints a tuple as '[A, B]'", () => {
    expect(printType(z.tuple([z.string, z.number]))).toBe("[string, number]");
  });
  // INVARIANT: a tuple mixing a codec member and an identity-primitive member prints both correctly.
  it("prints a tuple mixing codec + identity members", () => {
    expect(printType(z.tuple([z.pair, z.string]))).toBe("[Pair<unknown, unknown>, string]");
  });
  // INVARIANT: a union prints as "A | B".
  it("prints a union as 'A | B'", () => {
    expect(printType(z.union([z.string, z.number]))).toBe("string | number");
  });
});

describe("sTagToTsType — the s/* schema-DSL tag → TS type-string bridge", () => {
  // `tagToJsonSchema`'s object case sets `additionalProperties: false` — zod's
  // reconstruction (`z.fromJSONSchema`) renders that as an explicit index
  // signature banning extra keys, so every object in these expectations carries
  // a trailing `[x: string]: never` member (real, correct TS — not noise).
  // INVARIANT: an object tag's scalar fields print with a trailing `[x: string]: never`
  // index signature (from additionalProperties:false) — documented above.
  it("prints an object tag's scalar fields", () => {
    expect(sTagToTsType(["object", ["title", "string"], ["count", "number"]])).toBe(
      "{ title: string; count: number; [x: string]: never }",
    );
  });
  // INVARIANT: a field description prints as a JSDoc comment.
  it("a field description prints as a JSDoc comment (zod-to-ts's own convention)", () => {
    expect(sTagToTsType(["object", ["summary", "string", "a one-line summary"]])).toBe(
      "{ /** a one-line summary */ summary: string; [x: string]: never }",
    );
  });
  // INVARIANT: a nested array field prints correctly.
  it("prints a nested array field", () => {
    expect(sTagToTsType(["object", ["tags", ["array", "string"]]])).toBe(
      "{ tags: string[]; [x: string]: never }",
    );
  });
  // INVARIANT: a nested object field prints correctly, itself carrying the never-index signature.
  it("prints a nested object field", () => {
    expect(sTagToTsType(["object", ["author", ["object", ["name", "string"]]]])).toBe(
      "{ author: { name: string; [x: string]: never }; [x: string]: never }",
    );
  });
  // INVARIANT: an optional field's `/optional` suffix marks it TS-optional (`?:` with `| undefined`).
  it("an optional field's /optional suffix drops it from `required` — TS marks it `?` (zod's own `?: T | undefined`)", () => {
    expect(sTagToTsType(["object", ["title", "string"], ["nickname", "string/optional"]])).toBe(
      "{ title: string; nickname?: string | undefined; [x: string]: never }",
    );
  });
  // INVARIANT: a malformed/unrepresentable tag degrades to "unknown" rather than throwing.
  it("a malformed/unrepresentable tag degrades to unknown, never throws", () => {
    expect(sTagToTsType(["object", ["bad"]])).toBe("unknown");
    expect(sTagToTsType(null)).not.toBeUndefined();
  });
});

describe("signatureOf — the args-vector → function-signature composer", () => {
  // INVARIANT: an author-asserted `type` override on the contract takes precedence over the
  // zod-schema-derived signature (decoupled from the runtime membrane) (pins implementation,
  // not behavior).
  it("honors an author-asserted `type` override on the contract — the zod schema stays the MEMBRANE description (runtime decode/validate), `type` is a separate, decoupled TYPE-LEVEL narrowing for the harvest (mirrors legacy RosettaSpec.type/RosettaFunction.type)", () => {
    const def = symbol.native`typed-override: proof`(
      { input: [z.value], output: [z.value], type: "(ip: SchemeIP) => SchemeIP" },
      (a) => a,
    );
    expect(signatureOf(def)).toBe("(ip: SchemeIP) => SchemeIP");
  });

  // INVARIANT: `?` type predicates harvest as TS type-guards (arrow form for declare const).
  it("honors a type-guard `type` on a native type predicate (x is T)", () => {
    const def = symbol.native`string?: proof`(
      { input: [z.value], output: [z.boolean], type: "(x: unknown) => x is string" },
      () => true,
    );
    expect(signatureOf(def)).toBe("(x: unknown) => x is string");
  });

  it("honors a type-guard `type` on a taglessGuard type predicate", () => {
    const def = {
      ...symbol.taglessGuard`vector?: proof`,
      type: "(x: unknown) => x is readonly unknown[]",
    };
    expect(signatureOf(def)).toBe("(x: unknown) => x is readonly unknown[]");
  });

  // INVARIANT: a native def composes as scheme-value args with a synchronous (non-Promise) return.
  it("composes a native def: scheme-value args, sync return, single-value output", () => {
    const def = symbol.native`cons: build a pair`(
      { input: [z.pair, z.pair], output: [z.pair] },
      (a) => a,
    );
    expect(signatureOf(def)).toBe(
      "(a: Pair<unknown, unknown>, b: Pair<unknown, unknown>) => Pair<unknown, unknown>",
    );
  });

  // INVARIANT: a rosetta def composes as decoded-JS args with an async (Promise-wrapped) return.
  it("composes a rosetta def: decoded JS args, async (Promise) return", () => {
    const def = symbol.rosetta`pad: left-pad a string to a width`(
      { input: [z.string, z.number], output: [z.string] },
      (s) => s,
    );
    expect(signatureOf(def)).toBe("(a: string, b: number) => Promise<string>");
  });

  // INVARIANT: a multi-value rosetta output composes as a tuple inside Promise.
  it("composes a multiple-values rosetta output as a tuple inside Promise", () => {
    const def = symbol.rosetta`divmod: quotient and remainder`(
      { input: [z.number], output: [z.number, z.number] },
      (n) => [n, n] as [number, number],
    );
    expect(signatureOf(def)).toBe("(a: number) => Promise<[number, number]>");
  });

  // INVARIANT: a multi-value native output composes as a bare (sync) tuple.
  it("composes a multiple-values NATIVE output as a bare tuple (sync)", () => {
    const def = symbol.native`split: car and cdr`(
      { input: [z.pair], output: [z.pair, z.pair] },
      (p) => [p, p] as [typeof p, typeof p],
    );
    expect(signatureOf(def)).toBe(
      "(a: Pair<unknown, unknown>) => [Pair<unknown, unknown>, Pair<unknown, unknown>]",
    );
  });

  // INVARIANT: a variadic z.array input composes as a rest parameter.
  it("composes a variadic (z.array) input as a rest parameter", () => {
    const def = symbol.rosetta`sum: add all numbers`(
      { input: z.array(z.number), output: [z.number] },
      (...ns: number[]) => ns.reduce((a, b) => a + b, 0),
    );
    expect(signatureOf(def)).toBe("(...args: number[]) => Promise<number>");
  });

  // INVARIANT: a 0-arg contract composes as "()".
  it("composes a 0-arg contract as '()'", () => {
    const def = symbol.rosetta`now: current epoch millis`(
      { input: [], output: [z.number] },
      () => Date.now(),
    );
    expect(signatureOf(def)).toBe("() => Promise<number>");
  });

  // INVARIANT: a notImplemented/door def renders its signature as "never" (not callable).
  it("renders an omitted-verb door as 'never' (not callable)", () => {
    const def = symbol.notImplemented`eval: arbitrary evaluation is a door`;
    expect(signatureOf(def)).toBe("never");
  });

  // INVARIANT: a kwargs (inputRest object) input composes as a single plain-object parameter
  // with optional fields marked `?:`.
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
