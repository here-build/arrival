/**
 * LAW W1 — the seq-op terms (`map`/`filter`/`reduce`, both APair and AVector) thread the
 * invocation's REAL RunContext into their callback, not CONSTANT_CTX
 * (docs/working-proposals/arrival-constant-ctx-audit-2026-07-11.md §2.5, the wave-0
 * confessions: APair.ts ×3 + AVector.ts ×3 carried an explicit `runCtx ?? CONSTANT_CTX`
 * literal pending this wave, §4 Wave 1).
 *
 * Before this wave, `runCtx` on all six terms was OPTIONAL — a caller-side omission
 * silently fell back to CONSTANT_CTX (`heapMeter: undefined`, `strict: false`, no abort
 * signal, invisible to cache/effects), even though every real production dispatcher
 * (`env/r7rs/lists.ts`'s single-list `map`, `env/srfi/srfi-1.ts`'s `filter`,
 * `common/symbols/tagless.ts`'s `reduce` dispatch, `env/srfi/srfi-95.ts`'s `sort`) already
 * threads a live, defined `this.runCtx` (required since Wave 0's `CallCtx`/`applyCallback`
 * fix — verified by reading each dispatcher's own wrapper, not assumed). `runCtx` is now a
 * REQUIRED param on all these terms (AValue.ts's protocol declaration, mirrored on
 * APair/AVector/AJSArray) — the `?? CONSTANT_CTX` fallback is deleted, not just unreached.
 *
 * ── Why this test constructs values directly instead of going through `exec()` ──
 * `map`/`filter` invoke their callback with exactly ONE argument (the element) — unlike
 * `for-each`/`member`/`assoc` (callback-runctx-threading.law.test.ts's subjects, which
 * always pass TWO), there is no natural single-argument, strict-mode-sensitive Scheme
 * builtin to use as an indirect probe (the one direct `this.runCtx.strict` reader,
 * `env/r7rs/numeric.ts`'s `looseCompare`, needs ≥2 operands to reach that check without an
 * unrelated arity/type throw). Testing through `exec()` would also route callback-minted
 * values' ctx through arithmetic's operand-derived stamping (`schemeMul` mints under the
 * FIRST OPERAND's `.ctx`, not `this.runCtx`) — confounding this fix with the (separate,
 * out-of-cluster) `env/r7rs/lists.ts` `cons`/`list` ctx-dropping bug.
 *
 * Instead: construct an APair/AVector directly under a REAL `makeRunContext` (distinguishable
 * from CONSTANT_CTX by `heapMeter` — CONSTANT_CTX's is always `undefined`), pass a plain JS
 * `function` (never an arrow — arrows structurally can't read `this`, the exact "arrow-fn
 * trap" the audit's §0 names) as the callback, and record the `this.runCtx` it observes
 * when `applyCallback`'s raw-function arm invokes it via `Reflect.apply(fn,
 * makeCallCtx(runCtx), args)`. This pins the EXACT call this wave changed, unconfounded by
 * any other cluster's ctx-honesty state.
 */
import { describe, expect, it } from "vitest";
import { APair } from "../../values/primitives/APair.js";
import { AVector } from "../../values/primitives/AVector.js";
import { nil } from "../../values/primitives/ANil.js";
import { AExact } from "../../values/primitives/AExact.js";
import { makeRunContext, CONSTANT_CTX, type RunContext } from "../../values/primitives/RunContext.js";

/** A live, real run's ctx — `heapMeter` is DEFINED (`{ used, max }`), unlike CONSTANT_CTX's
 *  permanent `undefined`. Distinguishing the two is the whole law. */
const liveCtx: RunContext = makeRunContext({ heapBudget: 1_000_000 });

/** Records the `this.runCtx` a raw-function callback observes. A `function` declaration —
 *  never an arrow — so `this` is actually reachable (the audit's §0 arrow-fn trap). */
function makeProbe(): { fn: (this: { runCtx: RunContext }, ...args: unknown[]) => unknown; observed: RunContext[] } {
  const observed: RunContext[] = [];
  return {
    observed,
    fn: function (this: { runCtx: RunContext }, ...args: unknown[]): unknown {
      observed.push(this.runCtx);
      return args[0];
    },
  };
}

const one = new AExact(liveCtx, 1);
const two = new AExact(liveCtx, 2);

describe("W1 seq-op ctx threading — APair map/filter/reduce thread the invocation's real ctx into their callback", () => {
  it("map: callback observes the passed liveCtx, not CONSTANT_CTX", async () => {
    const list = new APair(liveCtx, one, new APair(liveCtx, two, nil));
    const probe = makeProbe();
    await list["arrival/tagless-final/map"](probe.fn, liveCtx);
    expect(probe.observed).toHaveLength(2);
    for (const ctx of probe.observed) {
      expect(ctx.heapMeter).toBeDefined();
      expect(ctx).toBe(liveCtx);
      expect(ctx).not.toBe(CONSTANT_CTX);
    }
  });

  it("filter: callback observes the passed liveCtx, not CONSTANT_CTX", async () => {
    const list = new APair(liveCtx, one, new APair(liveCtx, two, nil));
    const probe = makeProbe();
    await list["arrival/tagless-final/filter"](probe.fn, liveCtx);
    expect(probe.observed).toHaveLength(2);
    for (const ctx of probe.observed) {
      expect(ctx.heapMeter).toBeDefined();
      expect(ctx).toBe(liveCtx);
    }
  });

  it("reduce: callback observes the passed liveCtx, not CONSTANT_CTX", async () => {
    const list = new APair(liveCtx, one, new APair(liveCtx, two, nil));
    const probe = makeProbe();
    await list["arrival/tagless-final/reduce"](probe.fn, 0, liveCtx);
    expect(probe.observed).toHaveLength(2);
    for (const ctx of probe.observed) {
      expect(ctx.heapMeter).toBeDefined();
      expect(ctx).toBe(liveCtx);
    }
  });
});

describe("W1 seq-op ctx threading — AVector map/filter/reduce thread the invocation's real ctx into their callback", () => {
  // Loose mode (no `strict`): AVector's map/filter/reduce strict-gate BEFORE reaching the
  // callback ("R7RS map/filter/reduce operate on lists; a vector is not a list") — the
  // confession this test regresses against is only reachable in loose mode. `liveCtx` above
  // is already loose (`makeRunContext`'s `strict` defaults to `false`).
  it("map: callback observes the passed liveCtx, not CONSTANT_CTX", async () => {
    const vec = new AVector(liveCtx, [one, two]);
    const probe = makeProbe();
    await vec["arrival/tagless-final/map"](probe.fn, liveCtx);
    expect(probe.observed).toHaveLength(2);
    for (const ctx of probe.observed) {
      expect(ctx.heapMeter).toBeDefined();
      expect(ctx).toBe(liveCtx);
    }
  });

  it("filter: callback observes the passed liveCtx, not CONSTANT_CTX", async () => {
    const vec = new AVector(liveCtx, [one, two]);
    const probe = makeProbe();
    await vec["arrival/tagless-final/filter"](probe.fn, liveCtx);
    expect(probe.observed).toHaveLength(2);
    for (const ctx of probe.observed) {
      expect(ctx.heapMeter).toBeDefined();
      expect(ctx).toBe(liveCtx);
    }
  });

  it("reduce: callback observes the passed liveCtx, not CONSTANT_CTX", async () => {
    const vec = new AVector(liveCtx, [one, two]);
    const probe = makeProbe();
    await vec["arrival/tagless-final/reduce"](probe.fn, 0, liveCtx);
    expect(probe.observed).toHaveLength(2);
    for (const ctx of probe.observed) {
      expect(ctx.heapMeter).toBeDefined();
      expect(ctx).toBe(liveCtx);
    }
  });
});
