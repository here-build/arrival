// Caveat-sweep finding (2026-06-11, confirmed env-independent): inexact arithmetic
// over REAL operands ran the COMPLEX formula, so inf/0 in a cross-term (inf*0,
// 0/0) produced a spurious NaN imaginary part, and the complex toString branch
// (numbers.ts:407-413) is NaN/Infinity-blind → prints garbage "NaNNaNi" instead
// of the R7RS +inf.0 / -inf.0 / +nan.0.
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { AInexact } from "../AInexact.js";

const inx = (real: number) => new AInexact(real);

describe("SchemeInexact real div/mul by zero — R7RS infinities (was 'NaNNaNi')", () => {
  it.each([
    { name: "1.0 / 0.0 → +inf.0", a: 1, b: 0, op: "div" as const, expected: "+inf.0" },
    { name: "-1.0 / 0.0 → -inf.0", a: -1, b: 0, op: "div" as const, expected: "-inf.0" },
    { name: "0.0 / 0.0 → +nan.0", a: 0, b: 0, op: "div" as const, expected: "+nan.0" },
    {
      name: "+inf.0 * 0.0 → +nan.0 (cross-term inf*0 must not leak into imag)",
      a: Infinity,
      b: 0,
      op: "mul" as const,
      expected: "+nan.0" },
    { name: "real div stays real (2.0 / 4.0 → 0.5)", a: 2, b: 4, op: "div" as const, expected: "0.5" },
  ])("$name", ({ a, b, op, expected }) => {
    expect(inx(a)[op](inx(b)).toString()).toBe(expected);
  });

  // (Complex toString tests removed — arrival is reals-only, no imaginary axis.)
  // The original "must also survive a GENUINE complex with a
  // NaN/Infinity component (not collapse to "NaN...").

});
