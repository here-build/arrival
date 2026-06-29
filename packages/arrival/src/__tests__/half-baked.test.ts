import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
/**
 * HalfBaked — the lazy carrier core, in isolation (no evaluator wiring yet).
 *
 * Pins the three load-bearing behaviours the speculative-evaluation design
 * (docs/package-specific/arrival-scheme/speculative-evaluation-promise-functor-2026-06-05.md)
 * rests on:
 *   1. the cardinality interval NARROWS from both ends as slots settle;
 *   2. `decide` resolves EARLY — the instant the interval is decisive, with
 *      slots still pending (this is the `(>= (length (filter …)) 2)` collapse);
 *   3. `force`/`refine` fold to the data-true Pair, memoized (idempotent at
 *      multiple boundaries).
 */
import { describe, expect, it } from "vitest";

import { AHalfBaked, is_half_baked, type Interval } from "../values/primitives/AHalfBaked.js";
import { AExact } from "../values/primitives/AExact.js";
import { is_pair } from "../values/value-guards.js";
import { is_promise } from "../eval/guards.js";
import type { SchemeValue } from "../values/types.js";

/** A promise plus its resolver, so a test can settle slots one at a time. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * A HalfBaked slot resolves to the BOXED Scheme values it contributes (the
 * monadic-boxed contract: a count IS an AExact, never a raw JS number). Tests
 * model filter/map payloads as integer arrays; box each into the AExact the
 * slot type (`Promise<SchemeValue[]>`) requires.
 */
const box = (ns: number[]): SchemeValue[] => ns.map((n) => new AExact(CONSTANT_CTX, BigInt(n)));

/** filter slot bounds: 0..1 per slot until settled. */
const filterBounds = (): [number, number] => [0, 1];
/** map/list slot bounds: exactly 1 per slot. */
const mapBounds = (): [number, number] => [1, 1];

describe("HalfBaked — cardinality interval", () => {
  it("filter: interval is [0, N] up front, narrows from both ends as slots settle", async () => {
    const d = [deferred<SchemeValue[]>(), deferred<SchemeValue[]>(), deferred<SchemeValue[]>()];
    const hb = AHalfBaked.collection(CONSTANT_CTX,
      d.map((x) => x.promise),
      filterBounds,
    );

    expect(hb.interval()).toEqual<Interval>({ lo: 0, hi: 3 });

    d[0].resolve(box([7])); // kept → raises lo and keeps hi
    await tick();
    expect(hb.interval()).toEqual<Interval>({ lo: 1, hi: 3 });

    d[1].resolve([]); // dropped → lowers hi only
    await tick();
    expect(hb.interval()).toEqual<Interval>({ lo: 1, hi: 2 });

    d[2].resolve(box([9])); // kept → collapses to a point
    await tick();
    expect(hb.interval()).toEqual<Interval>({ lo: 2, hi: 2 });
    expect(hb.isFullySettled).toBe(true);
  });

  it("map/list: length is known exactly up front (interval is a point)", () => {
    const d = [deferred<SchemeValue[]>(), deferred<SchemeValue[]>()];
    const hb = AHalfBaked.collection(CONSTANT_CTX,
      d.map((x) => x.promise),
      mapBounds,
    );
    // Values unknown, COUNT is not: [2,2] before a single slot settles.
    expect(hb.interval()).toEqual<Interval>({ lo: 2, hi: 2 });
  });
});

describe("HalfBaked — early decision (the (>= … 2) collapse)", () => {
  it("decide resolves the instant lo >= k, with slots still pending", async () => {
    const d = [deferred<SchemeValue[]>(), deferred<SchemeValue[]>(), deferred<SchemeValue[]>(), deferred<SchemeValue[]>()];
    const list = AHalfBaked.collection(CONSTANT_CTX,
      d.map((x) => x.promise),
      filterBounds,
    );
    const len = list.toCardinalityNumber();

    let decidedAt = -1;
    const decision = len.decide<boolean>((iv) => (iv.lo >= 2 ? true : iv.hi < 2 ? false : undefined));
    void decision.then(() => (decidedAt = settledCount));

    let settledCount = 0;
    d[0].resolve(box([1]));
    settledCount = 1;
    await tick();
    d[1].resolve(box([1]));
    settledCount = 2; // <- the second kept element: lo reaches 2, decision fires
    await tick();

    await expect(decision).resolves.toBe(true);
    // Decided at the 2nd settle — slots 2 and 3 are STILL pending.
    expect(decidedAt).toBe(2);
    expect(list.isFullySettled).toBe(false);
  });

  it("decide resolves false early when hi drops below k (all-dropped)", async () => {
    const d = [deferred<SchemeValue[]>(), deferred<SchemeValue[]>(), deferred<SchemeValue[]>()];
    const list = AHalfBaked.collection(CONSTANT_CTX,
      d.map((x) => x.promise),
      filterBounds,
    );
    const len = list.toCardinalityNumber();
    const decision = len.decide<boolean>((iv) => (iv.lo >= 2 ? true : iv.hi < 2 ? false : undefined));

    d[0].resolve([]); // hi 3→2
    d[1].resolve([]); // hi 2→1  → 1 < 2 → false, slot 2 still pending
    await tick();
    await expect(decision).resolves.toBe(false);
    expect(list.isFullySettled).toBe(false);
  });

  it("a correct verdict always resolves once the fan fully settles (no early signal)", async () => {
    const d = [deferred<SchemeValue[]>(), deferred<SchemeValue[]>()];
    const list = AHalfBaked.collection(CONSTANT_CTX,
      d.map((x) => x.promise),
      filterBounds,
    );
    const len = list.toCardinalityNumber();
    const decision = len.decide<boolean>((iv) => (iv.lo === iv.hi ? iv.lo >= 1 : undefined));
    d[0].resolve([]);
    d[1].resolve(box([5]));
    await expect(decision).resolves.toBe(true);
  });
});

describe("HalfBaked — force / refine fold", () => {
  it("collection force folds slot payloads (flattened) into a Pair", async () => {
    const list = AHalfBaked.collection(CONSTANT_CTX,
      [Promise.resolve(box([10])), Promise.resolve([]), Promise.resolve(box([30]))],
      filterBounds,
    );
    const pair = await list.force();
    // Pair → array round-trip: dropped slot contributes nothing. The slots carry
    // boxed AExact integers, so narrow each element and read its numeric value.
    const nums = is_pair(pair) ? [...pair].map((v) => (v instanceof AExact ? v.valueOf() : v)) : [];
    expect(nums).toEqual([10, 30]);
  });

  it("number force folds to the settled count", async () => {
    const list = AHalfBaked.collection(CONSTANT_CTX, [Promise.resolve(box([1])), Promise.resolve([]), Promise.resolve(box([3]))], filterBounds);
    const len = list.toCardinalityNumber();
    // A count IS a Scheme integer: number-domain force boxes the cardinality as
    // AExact (the contract-honest SchemeValue), not a raw JS number.
    expect(await len.force()).toEqual(new AExact(CONSTANT_CTX, 2n));
  });

  it("force is memoized — same promise instance at repeated boundaries", () => {
    const list = AHalfBaked.collection(CONSTANT_CTX, [Promise.resolve(box([1]))], filterBounds);
    expect(list.force()).toBe(list.force());
    expect(list.refine()).toBe(list.force());
  });
});

describe("HalfBaked — invisibility contract", () => {
  it("is_half_baked recognizes it; is_promise does NOT (so evaluateArgs passes it through)", () => {
    const hb = AHalfBaked.collection(CONSTANT_CTX, [Promise.resolve(box([1]))], filterBounds);
    expect(is_half_baked(hb)).toBe(true);
    // The whole point: a HalfBaked is not a thenable, so the arg-await in
    // evaluateArgs (`if (is_promise(arg)) arg = yield arg`) skips it.
    expect(is_promise(hb)).toBe(false);
    expect("then" in (hb as object)).toBe(false);
  });
});
