/**
 * LAW W1 — an SRFI-13 criterion predicate observes the invocation's REAL RunContext,
 * not CONSTANT_CTX (the CONSTANT_CTX audit §2.4, srfi-13.ts:71 — the audit's own
 * "worst in cluster" finding: `criterionFlags`
 * passed CONSTANT_CTX as `applyCallback`'s runCtx argument ITSELF, so every
 * user-supplied SRFI-13 predicate (trim/index/count/tokenize) ran unmetered, off
 * cache/effects/abort, regardless of what the invoking run actually configured).
 *
 * `criterionFlags` now takes `runCtx` as a required parameter, threaded from every
 * caller's `this.runCtx` (trimImpl/sliceImpl converted from arrows to
 * `function(this: CallCtx, …)` so dispatch delivers it; string-index/string-count/
 * string-tokenize thread their own `this.runCtx`).
 *
 * Mirrors seq-op-runctx-threading.law.test.ts's method: construct a REAL
 * `makeRunContext` (distinguishable from CONSTANT_CTX by `heapMeter` — CONSTANT_CTX's
 * is always `undefined`), bind it via the sanctioned `testCallCtx` test door
 * (CallCtx.ts), and record the `this.runCtx` a plain-`function` probe (never an arrow
 * — the audit's §0 "arrow-fn trap") observes when SRFI-13's `applyCallback` seam
 * invokes it.
 */
import { describe, expect, it } from "vitest";
import srfi13 from "../../env/srfi/srfi-13.js";
import { testCallCtx } from "../../common/symbol.js";
import { makeRunContext, CONSTANT_CTX, type RunContext } from "../../values/primitives/RunContext.js";
import { AString } from "../../values/primitives/AString.js";
import type { EnvCapability } from "../../common/capability.js";

/** Same extraction idiom as identity.law.test.ts's `opsOf`: pull the raw impl fn off
 *  a `symbol.native`/`symbol.rosetta` entry in the capability's inlined `symbols`. */
const opsOf = (cap: EnvCapability): Record<string, (...a: any[]) => any> =>
  Object.fromEntries(
    Object.entries(cap.spec.symbols as Record<string, { impl?: unknown; value?: unknown }>)
      .map(([k, v]) => [k, v.impl ?? v.value] as const)
      .filter((entry): entry is [string, (...a: any[]) => any] => typeof entry[1] === "function"),
  );
const SRFI13_OPS = opsOf(srfi13);

/** A live, real run's ctx — `heapMeter` is DEFINED, unlike CONSTANT_CTX's permanent
 *  `undefined`. Distinguishing the two is the whole law. */
const liveCtx: RunContext = makeRunContext({ heapBudget: 1_000_000 });

/** Records the `this.runCtx` a raw-function criterion predicate observes. A `function`
 *  declaration — never an arrow — so `this` is actually reachable. */
function makeProbe(): { fn: (this: { runCtx: RunContext }, ...args: unknown[]) => boolean; observed: RunContext[] } {
  const observed: RunContext[] = [];
  return {
    observed,
    fn: function (this: { runCtx: RunContext }, ...args: unknown[]): boolean {
      observed.push(this.runCtx);
      return false; // never matches — every char flows through the predicate once
    },
  };
}

describe("W1 srfi-13 criterion ctx threading — a user predicate observes the invocation's real ctx, not CONSTANT_CTX", () => {
  it("string-index: the criterion predicate observes liveCtx for every character probed", async () => {
    const stringIndex = SRFI13_OPS["string-index"];
    const str = new AString(liveCtx, "abc");
    const probe = makeProbe();
    await stringIndex.call(testCallCtx({ runCtx: liveCtx }), str, probe.fn);
    expect(probe.observed).toHaveLength(3);
    for (const ctx of probe.observed) {
      expect(ctx.heapMeter).toBeDefined();
      expect(ctx).toBe(liveCtx);
      expect(ctx).not.toBe(CONSTANT_CTX);
    }
  });

  it("string-count: the criterion predicate observes liveCtx for every character probed", async () => {
    const stringCount = SRFI13_OPS["string-count"];
    const str = new AString(liveCtx, "ab");
    const probe = makeProbe();
    await stringCount.call(testCallCtx({ runCtx: liveCtx }), str, probe.fn);
    expect(probe.observed).toHaveLength(2);
    for (const ctx of probe.observed) {
      expect(ctx.heapMeter).toBeDefined();
      expect(ctx).toBe(liveCtx);
    }
  });

  it("string-trim: the criterion predicate observes liveCtx (not the default-whitespace path)", async () => {
    const stringTrim = SRFI13_OPS["string-trim"];
    const str = new AString(liveCtx, "a");
    const probe = makeProbe();
    await stringTrim.call(testCallCtx({ runCtx: liveCtx }), str, probe.fn);
    expect(probe.observed.length).toBeGreaterThan(0);
    for (const ctx of probe.observed) {
      expect(ctx).toBe(liveCtx);
    }
  });
});
