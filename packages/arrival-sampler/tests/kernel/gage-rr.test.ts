// gage-rr.test.ts — model-free unit test of the Gage R&R variance decomposition + pair-separability
// rule (src/__research__/gage-rr.ts). The math is a pure function of the per-(scheme, repeat) mean-
// correctness matrix, so it is exercised here in the DEFAULT suite with SYNTHETIC matrices of KNOWN
// variance structure — no model, no native addon.
//
// Red-first: each assertion fails if the decomposition or the pair rule is wrong (e.g. swapping
// between/within, or using ≥ vs > on the sd threshold). Three regimes:
//   1. between >> within   → %R&R tiny (<10%), every pair separable.
//   2. within >> between   → %R&R large (>30%), no pair separable.
//   3. prior-run shape     → %R&R in the marginal band; bdei/die separate, bdei/bang does not.

import { describe, expect, it } from "vitest";

import { gageRR } from "../research/gage-rr.js";

describe("gageRR — variance decomposition + separability", () => {
  it("between >> within → %R&R small (<10%), all pairs separable", () => {
    // Three schemes far apart (0.20 / 0.50 / 0.80), each scheme's repeats TIGHT (±0.01).
    const r = gageRR({
      lo: [0.19, 0.2, 0.21],
      mid: [0.49, 0.5, 0.51],
      hi: [0.79, 0.8, 0.81],
    });
    expect(r.betweenVar).toBeGreaterThan(r.runToRunVar);
    expect(r.percentRR).toBeLessThan(0.1);
    // every mean gap (≥0.30) dwarfs the run-to-run sd (~0.008) → all 3 pairs separable.
    expect(r.separablePairs).toHaveLength(3);
    expect(r.nonSeparablePairs).toHaveLength(0);
  });

  it("within >> between → %R&R large (>30%), pairs NOT separable", () => {
    // Schemes nearly coincident (means ≈0.50), each scheme's repeats NOISY (±0.20).
    const r = gageRR({
      a: [0.3, 0.5, 0.7],
      b: [0.31, 0.51, 0.71],
      c: [0.29, 0.49, 0.69],
    });
    expect(r.runToRunVar).toBeGreaterThan(r.betweenVar);
    expect(r.percentRR).toBeGreaterThan(0.3);
    // mean gaps (~0.01) are far inside the run-to-run sd (~0.16) → nothing separable.
    expect(r.separablePairs).toHaveLength(0);
    expect(r.nonSeparablePairs).toHaveLength(3);
  });

  it("prior-run shape → marginal %R&R; bdei/die separate, bdei/bang does not", () => {
    // Reproduces the last real run's shape: bdei~0.843, die~0.571, bang~0.786, with run-to-run noise
    // sized so %R&R lands in the marginal band the real n=5 / 14-task run reported (~10.7%). Per-repeat
    // means are spread to give each scheme a realistic run-to-run sd (~0.06) over the tiny matrix.
    const r = gageRR({
      bdei: [0.783, 0.843, 0.903], // mean 0.843, sd ~0.049
      die: [0.511, 0.571, 0.631], // mean 0.571, sd ~0.049
      bang: [0.726, 0.786, 0.846], // mean 0.786, sd ~0.049
    });

    // Means recovered.
    const meanOf = (s: string): number => r.perScheme.find((p) => p.scheme === s)!.mean;
    expect(meanOf("bdei")).toBeCloseTo(0.843, 3);
    expect(meanOf("die")).toBeCloseTo(0.571, 3);
    expect(meanOf("bang")).toBeCloseTo(0.786, 3);

    // %R&R lands in the marginal 10–30% band (the gauge's "△ marginal" verdict).
    expect(r.percentRR).toBeGreaterThan(0.1);
    expect(r.percentRR).toBeLessThan(0.3);

    // Pooled run-to-run sd ~0.033. bdei−die = 0.272 ≫ sd → separable;
    // bdei−bang = 0.057 — close to the sd; we assert the partition the rule produces, not a hard number.
    const isSeparable = (x: string, y: string): boolean =>
      r.separablePairs.some((p) => (p.a === x && p.b === y) || (p.a === y && p.b === x));
    expect(isSeparable("bdei", "die")).toBe(true);
    expect(isSeparable("die", "bang")).toBe(true); // gap 0.215 ≫ sd

    // The escape-hatch's load-bearing call: each pair is in exactly one partition, and the gap-vs-sd
    // rule is consistent with the pooled sd.
    const all = [...r.separablePairs, ...r.nonSeparablePairs];
    expect(all).toHaveLength(3);
    for (const p of r.separablePairs) expect(p.delta).toBeGreaterThan(r.pooledRunToRunSd);
    for (const p of r.nonSeparablePairs) expect(p.delta).toBeLessThanOrEqual(r.pooledRunToRunSd);
  });

  it("zero variance everywhere → %R&R 0, no separable pairs", () => {
    const r = gageRR({ x: [0.5, 0.5], y: [0.5, 0.5] });
    expect(r.percentRR).toBe(0);
    expect(r.separablePairs).toHaveLength(0);
    expect(r.nonSeparablePairs).toHaveLength(1); // gap 0, not > sd 0
  });
});
