// preload.test.ts — the PURE preload budget + selection math, MODEL-FREE (no fs, no GPU). Asserts the RAM
// budget formula (`min(0.8·RAM, RAM−4GiB)`, clamped ≥ 0), greedy smallest-first selection, the resident-slot
// count, and the 4-GiB-free floor binding on a small machine vs the 80% cap binding on a large one.

import { describe, it, expect } from "vitest";

import { preloadBudgetBytes, selectPreloadSet } from "../../src/runners/server/preload.js";

const GIB = 1024 ** 3;

describe("preloadBudgetBytes — usable model budget", () => {
  it("the 80% cap binds on a large machine (128 GiB → 102.4 GiB)", () => {
    expect(preloadBudgetBytes(128 * GIB)).toBe(0.8 * 128 * GIB); // min(102.4, 124) = 102.4
  });

  it("the 4-GiB-free floor binds on a small machine (8 GiB → 4 GiB)", () => {
    expect(preloadBudgetBytes(8 * GIB)).toBe(8 * GIB - 4 * GIB); // min(6.4, 4) = 4
  });

  it("clamps to 0 when the machine has ≤ 4 GiB (never negative)", () => {
    expect(preloadBudgetBytes(2 * GIB)).toBe(0); // min(1.6, -2) = -2 → clamp 0
    expect(preloadBudgetBytes(0)).toBe(0);
  });
});

describe("selectPreloadSet — greedy smallest-first fit", () => {
  it("fits as many models as the budget allows on a 128 GiB box (budget 102.4 GiB)", () => {
    const models = [
      { id: "big", sizeBytes: 60 * GIB },
      { id: "small", sizeBytes: 10 * GIB },
      { id: "mid", sizeBytes: 30 * GIB },
      { id: "med", sizeBytes: 20 * GIB },
    ];
    // smallest-first cumulative: 10, 30, 60, then +60 = 120 > 102.4 → "big" skipped.
    const { ids, maxResident } = selectPreloadSet(models, 128 * GIB);
    expect(ids).toEqual(["small", "med", "mid"]);
    expect(maxResident).toBe(3);
  });

  it("honours the 4-GiB floor on an 8 GiB box (budget 4 GiB ⇒ only one 3 GiB model fits)", () => {
    const models = [
      { id: "a", sizeBytes: 3 * GIB },
      { id: "b", sizeBytes: 3 * GIB },
    ];
    const { ids, maxResident } = selectPreloadSet(models, 8 * GIB);
    expect(ids).toEqual(["a"]); // 3 fits, 3+3=6 > 4 → b skipped
    expect(maxResident).toBe(1);
  });

  it("selects nothing when no model fits the budget", () => {
    const models = [{ id: "huge", sizeBytes: 200 * GIB }];
    expect(selectPreloadSet(models, 128 * GIB)).toEqual({ ids: [], maxResident: 0 });
  });

  it("selects nothing from an empty roster", () => {
    expect(selectPreloadSet([], 128 * GIB)).toEqual({ ids: [], maxResident: 0 });
  });

  it("fits the whole roster when it comfortably fits", () => {
    const models = [
      { id: "a", sizeBytes: 1 * GIB },
      { id: "b", sizeBytes: 2 * GIB },
      { id: "c", sizeBytes: 3 * GIB },
    ];
    const { ids, maxResident } = selectPreloadSet(models, 128 * GIB);
    expect(new Set(ids)).toEqual(new Set(["a", "b", "c"]));
    expect(maxResident).toBe(3);
  });
});
