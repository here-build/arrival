/**
 * Bridge Tests - Verify LIPS ↔ New Types conversion
 *
 * The `wrappedOps[...]` direct-call numeric tests + the integration scenarios that
 * lived here tested the numeric core's OLD home (the `wrappedOps` object). That core
 * has been carved into the `scheme/numeric` pack (env/r7rs/numeric.ts), and the same
 * behaviors are witnessed at the scheme surface by `numbers.spec` / `r7rs-numbers`
 * (exactness contagion, comparison, bitwise, rounding, the tower predicates). What
 * stays here is what bridge.ts still owns: `coerceNumeric` (the tower coercion,
 * re-exported from op-helpers) and `wrapOperator` (the Operator↔Scheme wrapper, live
 * until the membrane teardown).
 */

import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { coerceNumeric, wrapOperator } from "../bridge";
import { add, mul, sqrt, sub } from "../operators";

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

describe("wrapOperator", () => {
  it("wraps add operator", () => {
    const wrappedAdd = wrapOperator(add);

    // Should work with primitive numbers
    const result = wrappedAdd(1, 2, 3);
    expect(result).toBeInstanceOf(AExact);
    expect((result as AExact).num).toBe(6n);
  });

  it("wraps sub operator", () => {
    const wrappedSub = wrapOperator(sub);

    // Unary negation
    const neg = wrappedSub(5);
    expect(neg).toBeInstanceOf(AExact);
    expect((neg as AExact).num).toBe(-5n);

    // Binary subtraction
    const diff = wrappedSub(10, 3);
    expect(diff).toBeInstanceOf(AExact);
    expect((diff as AExact).num).toBe(7n);
  });

  it("wraps mul operator", () => {
    const wrappedMul = wrapOperator(mul);

    const result = wrappedMul(2, 3, 4);
    expect(result).toBeInstanceOf(AExact);
    expect((result as AExact).num).toBe(24n);
  });

  it("wraps sqrt operator", () => {
    const wrappedSqrt = wrapOperator(sqrt);

    const result = wrappedSqrt(4);
    // sqrt(4) = 2, which is a safe integer, so ExactNumber
    expect((result as AExact).num).toBe(2n);
  });

  it("handles mixed exact/inexact", () => {
    const wrappedAdd = wrapOperator(add);

    const result = wrappedAdd(1, 2.5);
    expect(result).toBeInstanceOf(AInexact);
    expect((result as AInexact).real).toBe(3.5);
  });

  it("handles objects with valueOf", () => {
    const wrappedAdd = wrapOperator(add);

    // Object that returns 0.333... via valueOf
    const third = { valueOf: () => 1 / 3 };

    // 1/3 + 0.5 = 0.833... (inexact)
    const result = wrappedAdd(third, 0.5);
    expect(result).toBeInstanceOf(AInexact);
    expect((result as AInexact).real).toBeCloseTo(0.833, 2);
  });
});
