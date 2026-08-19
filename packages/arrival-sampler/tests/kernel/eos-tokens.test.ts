// eos-tokens.test.ts — the family-aware stop set + the single-special-token round-trip GUARD, model-free
// on a synthetic vocab. The guard is the load-bearing fix: a family terminator that the model's vocab
// doesn't define (it splits into content tokens) must be DROPPED, never added as a spurious early-stop id.
// (Pure `buildEosTokenSet` carries no native-addon import, so this rides the default __tests__ gate.)

import type { Token } from "node-llama-cpp";
import { describe, expect, it, vi } from "vitest";

import { buildEosTokenSet } from "../../src/runners/local/backends/llama/eos-tokens.js";

const tok = (n: number): Token => n as unknown as Token;

describe("buildEosTokenSet", () => {
  it("adds eos + eot + a terminator that resolves to exactly ONE special token", () => {
    const set = buildEosTokenSet(tok(1), tok(2), () => [tok(42)], "<|im_end|>");
    expect(set.size).toBe(3);
    for (const t of [tok(1), tok(2), tok(42)]) expect(set.has(t)).toBe(true);
  });

  it("DROPS a terminator that splits into multiple tokens, with a warn — never a spurious content id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const set = buildEosTokenSet(tok(1), tok(2), () => [tok(10), tok(20), tok(30)], "<|eot_id|>");
    expect(set.size).toBe(2); // only eos + eot
    expect(set.has(tok(10))).toBe(false); // the first split-token is NOT injected as an early stop
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("terminator null → just eos/eot (no resolution attempted)", () => {
    const set = buildEosTokenSet(tok(1), tok(2), () => [tok(99)], null);
    expect(set.size).toBe(2);
    expect(set.has(tok(99))).toBe(false);
  });

  it("filters nullish eos/eot", () => {
    const set = buildEosTokenSet(undefined, tok(2), () => [tok(5)], "<|im_end|>");
    expect(set.size).toBe(2);
    for (const t of [tok(2), tok(5)]) expect(set.has(t)).toBe(true);
  });
});
