// Caveat-sweep finding (2026-06-11, confirmed env-independent): inexact arithmetic
// over REAL operands ran the COMPLEX formula, so inf/0 in a cross-term (inf*0,
// 0/0) produced a spurious NaN imaginary part, and the complex toString branch
// (numbers.ts:407-413) is NaN/Infinity-blind → prints garbage "NaNNaNi" instead
// of the R7RS +inf.0 / -inf.0 / +nan.0.
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AInexact } from "../values/numbers.js";

const inx = (real: number) => new AInexact(CONSTANT_CTX, real);

describe("SchemeInexact real div/mul by zero — R7RS infinities (was 'NaNNaNi')", () => {
  it("1.0 / 0.0 → +inf.0", () => {
    expect(inx(1).div(inx(0)).toString()).toBe("+inf.0");
  });
  it("-1.0 / 0.0 → -inf.0", () => {
    expect(inx(-1).div(inx(0)).toString()).toBe("-inf.0");
  });
  it("0.0 / 0.0 → +nan.0", () => {
    expect(inx(0).div(inx(0)).toString()).toBe("+nan.0");
  });
  it("+inf.0 * 0.0 → +nan.0 (cross-term inf*0 must not leak into imag)", () => {
    expect(inx(Infinity).mul(inx(0)).toString()).toBe("+nan.0");
  });
  it("real div stays real (2.0 / 4.0 → 0.5)", () => {
    expect(inx(2).div(inx(4)).toString()).toBe("0.5");
  });

  // (Complex toString tests removed — arrival is reals-only, no imaginary axis.)
  // The original "must also survive a GENUINE complex with a
  // NaN/Infinity component (not collapse to "NaN...").

});
