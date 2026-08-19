// sampling.test.ts — verdicts about temperature sampling + pass^k. Pure, no model.

import { describe, expect, it } from "vitest";

import { mulberry32 } from "../../src/rng.js";
import { passAtK, tempSample } from "../../src/sampling.js";

describe("tempSample", () => {
  it("τ=0 is argmax", () => {
    expect(tempSample([0.1, 0.7, 0.2], 0, mulberry32(1))).toBe(1);
    expect(tempSample([0.5, 0.2, 0.3], 0, mulberry32(1))).toBe(0);
  });

  it("single candidate always returns 0", () => {
    expect(tempSample([0.9], 1, mulberry32(5))).toBe(0);
  });

  it("low τ concentrates on the top candidate", () => {
    const rng = mulberry32(7);
    let top = 0;
    for (let i = 0; i < 1000; i++) if (tempSample([0.1, 0.8, 0.1], 0.2, rng) === 1) top++;
    expect(top).toBeGreaterThan(950); // overwhelmingly the mode
  });

  it("high τ approaches uniform (all candidates drawn a fair share)", () => {
    const rng = mulberry32(9);
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) counts[tempSample([0.5, 0.3, 0.2], 100, rng)]++;
    // Near-uniform: every bucket within a loose band of 1000.
    for (const c of counts) expect(c).toBeGreaterThan(750);
  });

  it("is reproducible given a seed", () => {
    const draw = () => {
      const rng = mulberry32(123);
      return Array.from({ length: 10 }, () => tempSample([0.4, 0.35, 0.25], 0.8, rng));
    };
    expect(draw()).toEqual(draw());
  });

  it("degenerate all-zero probs falls back to index 0 (argmax of ties)", () => {
    expect(tempSample([0, 0, 0], 1, mulberry32(2))).toBe(0);
  });
});

describe("passAtK", () => {
  it("pass^1 is the success rate", () => {
    expect(passAtK(6, 10, 1)).toBeCloseTo(0.6, 6);
  });
  it("all trials succeed → pass^k = 1 for any k", () => {
    expect(passAtK(8, 8, 4)).toBe(1);
  });
  it("k beyond successes → 0 (can't draw k all-successes)", () => {
    expect(passAtK(3, 10, 4)).toBe(0);
  });
  it("reliability falls as k grows (right-on-average but flaky)", () => {
    // 6/8 successes: pass^1=0.75 but pass^4 is much lower.
    expect(passAtK(6, 8, 1)).toBeCloseTo(0.75, 6);
    expect(passAtK(6, 8, 4)).toBeLessThan(0.25);
  });
  it("throws when k > n", () => {
    expect(() => passAtK(3, 3, 4)).toThrow();
  });
});
