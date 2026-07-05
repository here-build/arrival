// scheme-zod-unification.test.ts — RED→GREEN proof for two related fixes to
// scheme-zod.ts's vocabulary:
//
//   1. z.lambda — a new, canonical "callable scheme value" schema, replacing the dozen
//      ad-hoc `z.custom<(...args: unknown[]) => T>()` one-offs scattered across
//      map/filter/find/sort/curry/vector-map/string-map/etc (not migrated to it yet —
//      that's a deferred follow-up; this only proves z.lambda itself is correct).
//
//   2. schemeString/schemeChar/schemeBool were SEPARATELY re-declared identity schemas
//      (z.instanceof(AString) etc.) alongside the string/char/boolean CODECS, which
//      already contain the identical z.instanceof(...) as their own `.in` side (zod v4's
//      z.codec() is a ZodPipe exposing public .in/.out accessors — verified: codec.in IS
//      the exact schema object passed as the codec's first argument, not a copy). Turned
//      into DERIVED ALIASES (schemeString = string.in) so there is exactly ONE
//      declaration per concept, reused — not two independently-authored schemas that
//      happen to describe the same class. Zero consumer-file changes: every existing
//      z.schemeString/z.schemeChar/z.schemeBool call site keeps working unchanged,
//      because the alias IS (by reference) what those codecs already carry.
//
//   Also: the 4 number codecs (number/integer/bigint/numberOrBigint) each independently
//   re-spelled `z.union([z.instanceof(AExact), z.instanceof(AInexact)])` as their input
//   side, rather than reusing the already-declared `schemeNumber` export — de-duplicated
//   so all four share the identical schemeNumber object as their `.in`.
import { describe, expect, it } from "vitest";
import * as z from "../scheme-zod.js";
import { AString } from "../../values/primitives/AString.js";
import { ABool } from "../../values/primitives/ABool.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { AExact } from "../../values/primitives/AExact.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";

describe("z.lambda — the canonical callable-scheme-value schema", () => {
  it("exists and accepts a plain JS function", () => {
    const fn = (..._args: unknown[]): unknown => undefined;
    expect(z.lambda.safeParse(fn).success).toBe(true);
  });

  it("rejects a non-function scheme value (a real discriminating predicate, not a bare marker)", () => {
    expect(z.lambda.safeParse(new AString(CONSTANT_CTX, "not a function")).success).toBe(false);
    expect(z.lambda.safeParse(42).success).toBe(false);
    expect(z.lambda.safeParse(null).success).toBe(false);
  });

  it("decoded type is a callable — z.output<typeof lambda> assignable to (...args: unknown[]) => unknown", () => {
    const fn: (...args: unknown[]) => unknown = z.lambda.parse((a: unknown) => a);
    expect(typeof fn).toBe("function");
  });
});

describe("schemeString/schemeChar/schemeBool are now DERIVED from their codec's .in, not re-declared", () => {
  it("schemeString === string.in (same object — one declaration, reused)", () => {
    expect(z.schemeString).toBe(z.string.in);
  });

  it("schemeChar === char.in", () => {
    expect(z.schemeChar).toBe(z.char.in);
  });

  it("schemeBool === boolean.in", () => {
    expect(z.schemeBool).toBe(z.boolean.in);
  });

  it("behavior is unchanged for existing consumers: schemeString still accepts an AString instance", () => {
    expect(z.schemeString.safeParse(new AString(CONSTANT_CTX, "x")).success).toBe(true);
  });

  it("behavior is unchanged: schemeChar still accepts an ACharacter instance", () => {
    expect(z.schemeChar.safeParse(new ACharacter(CONSTANT_CTX, "a")).success).toBe(true);
  });

  it("behavior is unchanged: schemeBool still accepts an ABool instance", () => {
    expect(z.schemeBool.safeParse(new ABool(CONSTANT_CTX, true)).success).toBe(true);
  });
});

describe("the number codec family reuses ONE schemeNumber declaration, not 4 re-spelled unions", () => {
  it("number.in === schemeNumber", () => {
    expect(z.number.in).toBe(z.schemeNumber);
  });

  it("integer.in === schemeNumber", () => {
    expect(z.integer.in).toBe(z.schemeNumber);
  });

  it("bigint.in === schemeNumber", () => {
    expect(z.bigint.in).toBe(z.schemeNumber);
  });

  it("numberOrBigint.in === schemeNumber", () => {
    expect(z.numberOrBigint.in).toBe(z.schemeNumber);
  });

  it("behavior is unchanged: schemeNumber still accepts an AExact instance", () => {
    expect(z.schemeNumber.safeParse(new AExact(CONSTANT_CTX, 3n)).success).toBe(true);
  });
});
