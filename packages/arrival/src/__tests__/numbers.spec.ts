import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AExact, AInexact, parseNumber, rosettaNumbers, schemeNumbers } from "../values/numbers";

describe("ExactNumber", () => {
  it("creates integers", () => {
    const n = new AExact(CONSTANT_CTX, 42n);
    expect(n.num).toBe(42n);
    expect(n.denom).toBe(1n);
    expect(n.isInteger).toBe(true);
    expect(n.isExact).toBe(true);
    expect(n.toString()).toBe("42");
  });

  it("creates and normalizes rationals", () => {
    const n = new AExact(CONSTANT_CTX, 6n, 4n);
    expect(n.num).toBe(3n);
    expect(n.denom).toBe(2n);
    expect(n.isInteger).toBe(false);
    expect(n.toString()).toBe("3/2");
  });

  it("handles negative rationals", () => {
    const n = new AExact(CONSTANT_CTX, -6n, 4n);
    expect(n.num).toBe(-3n);
    expect(n.denom).toBe(2n);

    const n2 = new AExact(CONSTANT_CTX, 6n, -4n);
    expect(n2.num).toBe(-3n);
    expect(n2.denom).toBe(2n);
  });

  it("performs exact arithmetic", () => {
    const a = new AExact(CONSTANT_CTX, 1n, 2n);
    const b = new AExact(CONSTANT_CTX, 1n, 3n);

    expect(a.add(b).toString()).toBe("5/6");
    expect(a.sub(b).toString()).toBe("1/6");
    expect(a.mul(b).toString()).toBe("1/6");
    expect(a.div(b).toString()).toBe("3/2");
  });

  it("has tower predicates", () => {
    const n = new AExact(CONSTANT_CTX, 3n, 4n);
    expect(n.isInteger).toBe(false);
    expect(n.isRational).toBe(true);
    expect(n.isReal).toBe(true);
    expect(n.isComplex).toBe(true);
  });

  it("rounds to even on ties", () => {
    expect(new AExact(CONSTANT_CTX, 5n, 2n).round().toString()).toBe("2"); // 2.5 → 2
    expect(new AExact(CONSTANT_CTX, 7n, 2n).round().toString()).toBe("4"); // 3.5 → 4
    expect(new AExact(CONSTANT_CTX, -5n, 2n).round().toString()).toBe("-2"); // -2.5 → -2
  });
});

describe("InexactNumber", () => {
  it("creates reals", () => {
    const n = new AInexact(CONSTANT_CTX, 3.14);
    expect(n.real).toBe(3.14);
    expect(n.isReal).toBe(true);
    expect(n.isExact).toBe(false);
  });

  // Complex construction / arithmetic removed: arrival is reals-only (complex tower
  // omitted, R7RS § 6.2.3). SchemeInexact has no imaginary axis.

  it("has tower predicates", () => {
    const real = new AInexact(CONSTANT_CTX, 3.0);
    expect(real.isInteger).toBe(true);
    expect(real.isRational).toBe(true); // R7RS: finite reals are rational
    expect(real.isReal).toBe(true);
    expect(real.isComplex).toBe(true); // real ⊂ complex — predicate stays total
  });

  it("rounds to even on ties", () => {
    expect(new AInexact(CONSTANT_CTX, 2.5).round().real).toBe(2);
    expect(new AInexact(CONSTANT_CTX, 3.5).round().real).toBe(4);
    expect(new AInexact(CONSTANT_CTX, 4.5).round().real).toBe(4);
  });

  it("handles special values", () => {
    expect(new AInexact(CONSTANT_CTX, Infinity).toString()).toBe("+inf.0");
    expect(new AInexact(CONSTANT_CTX, -Infinity).toString()).toBe("-inf.0");
    expect(new AInexact(CONSTANT_CTX, NaN).toString()).toBe("+nan.0");
  });
});

describe("NumberRegistry - Scheme mode", () => {
  const reg = schemeNumbers;

  it("keeps exact rationals", () => {
    const a = new AExact(CONSTANT_CTX, 1n);
    const b = new AExact(CONSTANT_CTX, 2n);
    const result = reg.div(a, b);
    expect(result).toBeInstanceOf(AExact);
    expect(result.toString()).toBe("1/2");
  });

  it("doors on sqrt of negative (complex not supported)", () => {
    const n = new AInexact(CONSTANT_CTX, -4);
    expect(() => reg.sqrt(n)).toThrow("complex");
  });

  it("coerces exact + inexact → inexact", () => {
    const exact = new AExact(CONSTANT_CTX, 1n, 2n);
    const inexact = new AInexact(CONSTANT_CTX, 0.5);
    const result = reg.add(exact, inexact);
    expect(result).toBeInstanceOf(AInexact);
    expect((result as AInexact).real).toBe(1);
  });
});

describe("NumberRegistry - Rosetta mode", () => {
  const reg = rosettaNumbers;

  it("demotes rationals to inexact", () => {
    const a = new AExact(CONSTANT_CTX, 1n);
    const b = new AExact(CONSTANT_CTX, 2n);
    const result = reg.div(a, b);
    expect(result).toBeInstanceOf(AInexact);
    expect((result as AInexact).real).toBe(0.5);
  });

  it("throws on sqrt of negative", () => {
    const n = new AInexact(CONSTANT_CTX, -4);
    expect(() => reg.sqrt(n)).toThrow("complex");
  });

  it("throws on complex creation", () => {
    expect(() => reg.fromComplex(3, 4)).toThrow("complex");
  });
});

describe("parseNumber", () => {
  it("parses integers", () => {
    const n = parseNumber("42");
    expect(n).toBeInstanceOf(AExact);
    expect(n.toString()).toBe("42");
  });

  it("parses rationals", () => {
    const n = parseNumber("3/4");
    expect(n).toBeInstanceOf(AExact);
    expect(n.toString()).toBe("3/4");
  });

  it("parses floats", () => {
    const n = parseNumber("3.14");
    expect(n).toBeInstanceOf(AInexact);
    expect((n as AInexact).real).toBeCloseTo(3.14);
  });

  it("parses special values", () => {
    expect(parseNumber("+inf.0").toString()).toBe("+inf.0");
    expect(parseNumber("-inf.0").toString()).toBe("-inf.0");
    expect(parseNumber("+nan.0").isNaN).toBe(true);
  });

  it("handles exactness prefixes", () => {
    const inexact = parseNumber("#i42");
    expect(inexact).toBeInstanceOf(AInexact);
    expect(inexact.toString()).toBe("42.0");

    const exact = parseNumber("#e3.0");
    expect(exact).toBeInstanceOf(AExact);
    expect(exact.isInteger).toBe(true);
  });

  it("handles radix prefixes", () => {
    expect(parseNumber("#xff").toString()).toBe("255");
    expect(parseNumber("#b1010").toString()).toBe("10");
    expect(parseNumber("#o77").toString()).toBe("63");
  });
});
