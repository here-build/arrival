// ab-stats.test.ts — verdicts about the A/B significance gate. Pure math, no model.
//
// The load-bearing property is the A/A case: two identical (or noise-only) arms must come back
// INCONCLUSIVE. A gate that "finds" a winner between identical arms manufactures false discoveries and
// would corrupt every downstream naming-scheme comparison. The other tests pin the gate's calibration:
// a real, large difference IS detected; a tiny difference swamped by noise is NOT.

import { describe, expect, it } from "vitest";

import { abVerdict, bcaInterval, normalCdf, normalInv, permutationP } from "../research/ab-stats.js";
import { mulberry32 } from "../../src/rng.js";

/** Bernoulli vector from a seeded PRNG — synthetic per-task correctness at a given success rate. */
function bernoulli(n: number, prate: number, seed: number): number[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => (rng() < prate ? 1 : 0));
}

describe("normal helpers", () => {
  it("CDF and inverse round-trip", () => {
    for (const z of [-2, -1, -0.3, 0, 0.7, 1.5, 2.3]) {
      expect(normalInv(normalCdf(z))).toBeCloseTo(z, 2);
    }
  });
  it("CDF anchors", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 4);
    expect(normalCdf(1.644_853_6)).toBeCloseTo(0.95, 3);
  });
});

describe("A/A — identical arms must be inconclusive", () => {
  it("bit-identical deterministic arms (every delta 0) → inconclusive, p=1, CI=[0,0]", () => {
    const scores = bernoulli(20, 0.7, 11);
    const v = abVerdict(scores, [...scores]);
    expect(v.meanDelta).toBe(0);
    expect(v.ci.lower).toBe(0);
    expect(v.ci.upper).toBe(0);
    expect(v.p).toBe(1);
    expect(v.winner).toBe("inconclusive");
    expect(v.significant).toBe(false);
  });

  it("two independent draws from the SAME rate → inconclusive (no false winner)", () => {
    // Same underlying success rate, different seeds = pure noise between arms. The gate must not fire.
    const a = bernoulli(30, 0.6, 1);
    const b = bernoulli(30, 0.6, 2);
    const v = abVerdict(a, b, { seed: 42 });
    expect(v.significant).toBe(false);
  });
});

describe("A/B — real differences are detected, tiny ones are not", () => {
  it("large, consistent per-task improvement → B wins with CI lower bound > 0 and p < 0.05", () => {
    // B beats A on most tasks by a clear margin: A ~0.3 success, B ~0.85 success on the same tasks.
    const n = 40;
    const a = bernoulli(n, 0.3, 7);
    // Construct B paired: wherever A failed, B succeeds 80% of the time; where A passed, B keeps it.
    const rng = mulberry32(99);
    const b = a.map((ai) => (ai === 1 ? 1 : rng() < 0.8 ? 1 : 0));
    const v = abVerdict(a, b, { seed: 7 });
    expect(v.meanDelta).toBeGreaterThan(0.3);
    expect(v.ci.lower).toBeGreaterThan(0);
    expect(v.p).toBeLessThan(0.05);
    expect(v.winner).toBe("B");
  });

  it("a one-task flip in 14 tasks is NOT enough to claim significance", () => {
    // 14 tasks, B differs from A on exactly one task. The honest verdict at this n is inconclusive.
    const a = Array.from({ length: 14 }, () => 1);
    const b = [...a];
    b[3] = 0; // B is actually slightly WORSE on one task
    const v = abVerdict(a, b, { seed: 3 });
    expect(v.winner).toBe("inconclusive");
  });
});

describe("BCa interval brackets the point estimate", () => {
  it("lower <= point <= upper, and a positive-shifted sample has a positive point", () => {
    const deltas = bernoulli(50, 0.5, 5).map((x) => x + 0.4); // all shifted positive
    const ci = bcaInterval(deltas, { resamples: 4000 });
    expect(ci.lower).toBeLessThanOrEqual(ci.point);
    expect(ci.point).toBeLessThanOrEqual(ci.upper);
    expect(ci.point).toBeGreaterThan(0);
  });
});

describe("permutation p-value bounds", () => {
  it("zero-variance deltas → p = 1", () => {
    expect(permutationP([0, 0, 0, 0])).toBe(1);
  });
  it("strongly one-sided deltas → small p", () => {
    expect(
      permutationP(
        Array.from({ length: 30 }, () => 1),
        { iters: 5000 },
      ),
    ).toBeLessThan(0.05);
  });
});
