/**
 * `equal?` on pairs walks the cdr spine by iteration — a long list must not overflow the
 * stack (it used to cost ~3 frames per element), and cyclic spines must still terminate.
 */
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { __tieKnot, APair } from "../APair.js";
import { AExact } from "../AExact.js";
import { structuralEqual } from "../../structural-equal.js";

const list = (ns: number[]) =>
  APair.fromArray(
    CONSTANT_CTX,
    ns.map((n) => new AExact(n)),
    false,
  ) as APair<any, any>;
const iota = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("pair equals — spine iteration", () => {
  it("100k-element lists compare without overflowing the stack", () => {
    expect(structuralEqual(list(iota(100_000)), list(iota(100_000)))).toBe(true);
  });

  it("a difference at the far end of a long list is found", () => {
    const b = iota(100_000);
    b[99_999] = -1;
    expect(structuralEqual(list(iota(100_000)), list(b))).toBe(false);
  });

  it("different lengths are unequal", () => {
    expect(structuralEqual(list(iota(50_000)), list(iota(50_001)))).toBe(false);
  });

  it("cyclic lists terminate (co-inductively equal, even with different periods)", () => {
    const a = list([1, 2]);
    __tieKnot(a.cdr as APair<any, any>, "cdr", a);
    const b = list([1, 2, 1, 2]);
    let tail: APair<any, any> = b;
    while (tail.cdr instanceof APair) tail = tail.cdr;
    __tieKnot(tail, "cdr", b);
    expect(structuralEqual(a, b)).toBe(true);
    const c = list([1, 3]);
    __tieKnot(c.cdr as APair<any, any>, "cdr", c);
    expect(structuralEqual(a, c)).toBe(false);
  });
});
