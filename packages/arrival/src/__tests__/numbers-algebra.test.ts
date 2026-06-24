// Reference cell for the algebras-in-entities migration: Setoid on the number
// types. Proves the A2 law-checker end-to-end AND fixes the live
// `(equal? 1 1.0) → #t` bug (structuralEqual consults fantasy-land/equals first,
// so the exact/inexact instances now answer correctly).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AExact, AInexact } from "../values/numbers.js";
import { structuralEqual } from "../values/structural-equal.js";
import { setoidLaws } from "./algebra-laws.js";

const FL = "fantasy-land/equals";

// Exact rationals over a small domain (collisions exercise symmetry/transitivity).
const exactArb = fc
  .tuple(fc.bigInt({ min: -50n, max: 50n }), fc.bigInt({ min: 1n, max: 50n }))
  .map(([num, denom]) => new AExact(num, denom));

// Inexact reals incl. NaN / ±0 / ±Infinity — the cases that bite reflexivity.
const inexactArb = fc
  .double({ noDefaultInfinity: false, noNaN: false })
  .map((real) => new AInexact(real));

setoidLaws("SchemeExact", { arb: exactArb, equalClone: (a) => new AExact(a.num, a.denom) });
setoidLaws("SchemeInexact", { arb: inexactArb, equalClone: (a) => new AInexact(a.real) });

describe("number Setoid — exactness boundary (the (equal? 1 1.0) fix)", () => {
  it("exact 1 is NOT fantasy-land/equals inexact 1.0 (both directions)", () => {
    const one = new AExact(1n);
    const oneFloat = new AInexact(1);
    expect((one as never)[FL](oneFloat)).toBe(false);
    expect((oneFloat as never)[FL](one)).toBe(false);
  });

  it("structuralEqual honors the exactness boundary (the bug)", () => {
    // Before: structuralEqual collapsed via valueOf → #t. Now its FL/equals
    // consult-hook catches the number instances first → correct #f.
    expect(structuralEqual(new AExact(1n), new AInexact(1))).toBe(false);
    expect(structuralEqual(new AExact(1n), new AExact(1n))).toBe(true);
    expect(structuralEqual(new AInexact(1), new AInexact(1))).toBe(true);
  });

  it("NaN reflexivity holds (Object.is, not ===)", () => {
    const nan = new AInexact(NaN);
    expect((nan as never)[FL](new AInexact(NaN))).toBe(true);
  });
});
