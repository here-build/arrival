/**
 * Bridge Tests - `coerceNumeric` (the SchemeExact/SchemeInexact tower coercion).
 *
 * The Operator/Codec numeric stack this file used to also test (`wrapOperator`, the
 * operator instances, the `wrappedOps[...]` entries) has been carved into the
 * `scheme/numeric` pack (env/r7rs/numeric.ts) and the old machinery deleted; that
 * behavior is witnessed at the scheme surface by numbers.spec / r7rs-numbers.
 * `coerceNumeric` survives (re-exported from bridge.ts, real home op-helpers.ts).
 */

import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { coerceNumeric } from "../bridge.js";

describe("coerceNumeric", () => {
  describe("primitive types", () => {
    it("converts bigint to ExactNumber", () => {
      const result = coerceNumeric(42n);
      expect(result).toBeInstanceOf(AExact);
      expect((result as AExact).num).toBe(42n);
    });

    it("converts safe integer to ExactNumber", () => {
      const result = coerceNumeric(42);
      expect(result).toBeInstanceOf(AExact);
      expect((result as AExact).num).toBe(42n);
    });

    it("converts float to InexactNumber", () => {
      const result = coerceNumeric(3.14);
      expect(result).toBeInstanceOf(AInexact);
      expect((result as AInexact).real).toBe(3.14);
    });
  });

  describe("passthrough", () => {
    it("passes through ExactNumber", () => {
      const exact = new AExact(CONSTANT_CTX, 42n);
      expect(coerceNumeric(exact)).toBe(exact);
    });

    it("passes through InexactNumber", () => {
      const inexact = new AInexact(CONSTANT_CTX, 3.14);
      expect(coerceNumeric(inexact)).toBe(inexact);
    });
  });

  describe("objects with valueOf", () => {
    it("converts object with bigint valueOf", () => {
      const obj = { valueOf: () => 12345678901234567890n };
      const result = coerceNumeric(obj);
      expect(result).toBeInstanceOf(AExact);
      expect((result as AExact).num).toBe(12345678901234567890n);
    });

    it("converts object with number valueOf to exact for safe integers", () => {
      const obj = { valueOf: () => 42 };
      const result = coerceNumeric(obj);
      expect(result).toBeInstanceOf(AExact);
      expect((result as AExact).num).toBe(42n);
    });

    it("converts object with number valueOf to inexact for floats", () => {
      const obj = { valueOf: () => 3.14 };
      const result = coerceNumeric(obj);
      expect(result).toBeInstanceOf(AInexact);
      expect((result as AInexact).real).toBe(3.14);
    });
  });

  it("throws on unconvertible value", () => {
    expect(() => coerceNumeric("not a number")).toThrow("Cannot convert");
    expect(() => coerceNumeric(null)).toThrow("Cannot convert");
    expect(() => coerceNumeric(undefined)).toThrow("Cannot convert");
  });
});
