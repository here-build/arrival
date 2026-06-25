/**
 * THE THESIS, by example: the demand cone IS the provenance cone, and lazy
 * evaluation is what makes correct-minimal provenance fall out for free.
 *
 * SCOPE: these test the carrier in ISOLATION (sync fns, hand-assigned op ids) —
 * the unit-level proof. The carrier is now WIRED into the live builtins (Step 2 of
 * the flip): the same thesis through the real async map/filter/length lives in
 * lineage-assumptions.test.ts (A18/A8-live). `refine` is async to match the
 * interpreter, so these await it; a sync JS fn awaits through transparently. The
 * strongest evidence below is the CALL-COUNT assertions (behavioral); the cone
 * equalities are locked observations of this carrier, not an independent
 * minimality proof.
 *
 * Each test instruments `f`/`g`/`pred` with a call counter and gives each source
 * element + each op a distinct provenance id, so we can assert TWO things at once
 * from a single `refine`:
 *   (1) work done   — how many times fn actually ran (the memory/compute saving);
 *   (2) the cone     — exactly which ids the result's provenance carries (the
 *                      correctness claim: it's the minimal dependency set).
 * They come from the same walk, which is the whole point.
 */
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX, type RunContext } from "../values/primitives/RunContext.js";
import { AValue, EMPTY_PROVENANCE, pointProvenance } from "../values/primitives/AValue.js";
import { ALazySeq } from "../values/primitives/ALazySeq.js";

// A minimal provenance-bearing element: a number that carries a provenance set,
// so the carrier's `provOf` sees it exactly as it would a boxed AValue.
class ProvNum extends AValue {
  readonly kind = "number" as const;
  constructor(ctx: RunContext, readonly n: number, p: ReadonlySet<number>) {
    super(ctx, p);
  }
  toJs() {
    return this.n;
  }
  withProvenance(p: ReadonlySet<number>) {
    return new ProvNum(CONSTANT_CTX, this.n, p);
  }
}

/** Source of `count` elements, element i tagged with provenance id `base + i`. */
function provSource(count: number, base: number): ProvNum[] {
  return Array.from({ length: count }, (_, i) => new ProvNum(CONSTANT_CTX, i, pointProvenance(base + i)));
}

const ids = (p: ReadonlySet<number>): number[] => [...p].sort((a, b) => a - b);

describe("LazySeq — demand cone == provenance cone", () => {
  it("(length (map f xs)) runs f ZERO times and f is OUTSIDE the cone", async () => {
    let fCalls = 0;
    const f = (x: ProvNum) => {
      fCalls++;
      return new ProvNum(CONSTANT_CTX, x.n * 2, EMPTY_PROVENANCE);
    };

    const xs = new ALazySeq(CONSTANT_CTX, provSource(5, 100), [], pointProvenance(1)); // grouping id 1
    const mapped = xs.map(f, pointProvenance(2)); // op id 2 (f's introduction)

    const r = (await mapped.refine({ kind: "length", callId: 999 })) as { count: number; provenance: ReadonlySet<number> };

    // (1) work: map preserves length → length never touches a value.
    expect(fCalls).toBe(0);
    // (2) cone: just the grouping fact (1) and the length call (999). NOT f's
    // op id (2), NOT any element id (100..104) — the count depends on none of them.
    expect(r.count).toBe(5);
    expect(ids(r.provenance)).toEqual([1, 999]);
  });

  it("(length (filter pred xs)) DOES run pred and pulls pred + inspected elements into the cone", async () => {
    let predCalls = 0;
    const pred = (x: ProvNum) => {
      predCalls++;
      return x.n % 2 === 0;
    };

    const xs = new ALazySeq(CONSTANT_CTX, provSource(5, 100), [], pointProvenance(1)); // grouping id 1
    const filtered = xs.filter(pred, pointProvenance(3)); // op id 3

    const r = (await filtered.refine({ kind: "length", callId: 999 })) as { count: number; provenance: ReadonlySet<number> };

    // length depends on which elements pass → pred runs on every element.
    expect(predCalls).toBe(5);
    expect(r.count).toBe(3); // 0,2,4 of {0,1,2,3,4}
    // cone: grouping (1) ∪ pred op (3) ∪ every inspected element (100..104) ∪ call (999).
    expect(ids(r.provenance)).toEqual([1, 3, 100, 101, 102, 103, 104, 999]);
  });

  it("(length (map g (filter pred (map f xs)))): f & pred run (filter needs them), g does NOT, g is OUTSIDE the cone", async () => {
    let fCalls = 0;
    let gCalls = 0;
    let predCalls = 0;
    const f = (x: ProvNum) => {
      fCalls++;
      return new ProvNum(CONSTANT_CTX, x.n + 1, EMPTY_PROVENANCE);
    };
    const pred = (x: ProvNum) => {
      predCalls++;
      return x.n > 2;
    };
    const g = (x: ProvNum) => {
      gCalls++;
      return new ProvNum(CONSTANT_CTX, x.n * 10, EMPTY_PROVENANCE);
    };

    const xs = new ALazySeq(CONSTANT_CTX, provSource(5, 100), [], pointProvenance(1));
    const plan = xs
      .map(f, pointProvenance(2)) // before the filter → MUST run
      .filter(pred, pointProvenance(3)) // last length-changing op
      .map(g, pointProvenance(4)); // after the filter → length-preserving → SKIPPED

    const r = (await plan.refine({ kind: "length", callId: 999 })) as { count: number; provenance: ReadonlySet<number> };

    // f runs (the filter observes f's output); pred runs; g never runs.
    expect(fCalls).toBe(5);
    expect(predCalls).toBe(5);
    expect(gCalls).toBe(0);
    // xs = 0..4 → +1 → 1..5 → keep >2 → {3,4,5} → count 3.
    expect(r.count).toBe(3);
    // cone: grouping(1) ∪ f(2) ∪ pred(3) ∪ inspected elements(100..104) ∪ call(999).
    // g's op id (4) is ABSENT — the count provably does not depend on g.
    expect(ids(r.provenance)).toEqual([1, 2, 3, 100, 101, 102, 103, 104, 999]);
  });

  it("refine('iterate') is the eager egress: the WHOLE plan runs and materializes", async () => {
    let fCalls = 0;
    const f = (x: ProvNum) => {
      fCalls++;
      return new ProvNum(CONSTANT_CTX, x.n * 2, EMPTY_PROVENANCE);
    };
    const xs = new ALazySeq(CONSTANT_CTX, provSource(3, 100), [], pointProvenance(1));
    const r = (await xs.map(f, pointProvenance(2)).refine({ kind: "iterate" })) as {
      items: ProvNum[];
      provenance: ReadonlySet<number>;
    };

    expect(fCalls).toBe(3); // egress forces every element
    expect(r.items.map((p) => p.n)).toEqual([0, 2, 4]);
  });

  it("pipe runs nothing: building a plan never calls fn", () => {
    let calls = 0;
    const xs = new ALazySeq(CONSTANT_CTX, provSource(1000, 0), [], EMPTY_PROVENANCE);
    xs.map(() => (calls++, 0))
      .filter(() => (calls++, true))
      .map(() => (calls++, 0));
    expect(calls).toBe(0); // no refine ⇒ no work, regardless of source size
  });
});
