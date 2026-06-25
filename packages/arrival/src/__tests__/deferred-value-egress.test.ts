/**
 * Deferred-value EGRESS contract — the hermetic-ctx migration's hardest cluster.
 *
 * A deferred carrier captures its PRODUCING RUN, in a way ctx-on-the-value cannot undo:
 *   - ALazySeq.ops hold live lambda CLOSURES (fn/pred) over run-A's environment. refine()
 *     runs exactly those closures; no value-level ctx can rebind them to another run.
 *   - AHalfBaked.slots hold already-dispatched run-A promises; .records is MUTABLE, settled
 *     by a .then callback that fires on the microtask queue with NO run/ctx active.
 *
 * So `new AValue(ctx)` is necessary-but-not-sufficient for deferred values: a leaked carrier
 * refined in run B still executes run-A's closures / awaits run-A's promises regardless of
 * whose ctx the value holds. The only sound fix is FORCE-ON-EGRESS — materialize every
 * carrier at the exec/membrane boundary, BEFORE it can cross out of its run, deeply through
 * any structure that wraps it.
 *
 * This suite pins that contract. The GREEN tests characterize the hazard + today's boundary
 * (exec returns its top-level result WITHOUT forcing). The `it.todo` tests spec the
 * force-on-egress the migration installs. See project-arrival-hermetic-env-dissolution.
 */
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX, type RunContext } from "../values/primitives/RunContext.js";
import { AValue, EMPTY_PROVENANCE, pointProvenance } from "../values/primitives/AValue.js";
import { ALazySeq, is_lazy_seq } from "../values/primitives/ALazySeq.js";
import { AHalfBaked, is_half_baked } from "../values/primitives/AHalfBaked.js";
import { exec } from "../eval/generator-exec.js";

// A provenance-bearing element (mirrors lazy-seq.test.ts) so the carrier's provOf sees it
// exactly as it would a boxed AValue.
class ProvNum extends AValue {
  readonly kind = "number" as const;
  constructor(
    ctx: RunContext,
    readonly n: number,
    p: ReadonlySet<number>,
  ) {
    super(ctx, p);
  }
  toJs() {
    return this.n;
  }
  withProvenance(p: ReadonlySet<number>) {
    return new ProvNum(CONSTANT_CTX, this.n, p);
  }
}

const sortedIds = (p: ReadonlySet<number>): number[] => [...p].sort((a, b) => a - b);
const flushMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("deferred egress — the carrier captures its PRODUCING run (ctx can't undo it)", () => {
  it("ALazySeq.ops run the closures captured at construction; no ctx indirection can rebind them", async () => {
    // fn closes over a run-local sentinel. Whatever run later refines this carrier, refine
    // runs THIS closure over THIS sentinel — there is no value-level ctx that swaps it for
    // another run's logic. Hence force-BEFORE-escape, not ctx-on-the-value, is the fix.
    const runASentinel = Symbol("run-A");
    const observed: symbol[] = [];
    const fn = (x: number): number => {
      observed.push(runASentinel);
      return x * 2;
    };
    const seq = new ALazySeq(CONSTANT_CTX, [1, 2, 3]).map(fn, pointProvenance(1));

    const r = (await seq.refine({ kind: "iterate" })) as { items: number[] };

    expect(r.items).toEqual([2, 4, 6]);
    expect(observed).toEqual([runASentinel, runASentinel, runASentinel]);

    // The closure is fixed at construction: a second refine re-runs the SAME captured fn.
    await seq.refine({ kind: "iterate" });
    expect(observed.every((s) => s === runASentinel)).toBe(true);
  });

  it("AHalfBaked.records is MUTABLE cross-run state, settled by a microtask .then untethered to any run", async () => {
    let settle!: (items: number[]) => void;
    const slot = new Promise<number[]>((res) => {
      settle = res;
    });
    // A filter slot: cardinality [0,1] until the predicate's promise settles.
    const hb = AHalfBaked.collection([slot], () => [0, 1], pointProvenance(7));

    expect(hb.isFullySettled).toBe(false);
    expect(hb.interval()).toEqual({ lo: 0, hi: 1 });

    settle([42]); // the slot keeps its element
    await flushMicrotasks(); // let the carrier's internal .then mutate `records`

    // The interval narrowed via a callback that fired on the microtask queue with no run
    // active. Had this carrier escaped its producing run, that mutation would still fire
    // here — in whatever context the microtask happens to run. That is the leak.
    expect(hb.isFullySettled).toBe(true);
    expect(hb.interval()).toEqual({ lo: 1, hi: 1 });
  });
});

describe("deferred egress — un-forced escape is structurally detectable", () => {
  it("ALazySeq.toJs() is the plan shape, never a materialized array", () => {
    const seq = new ALazySeq(CONSTANT_CTX, [1, 2, 3]).map((x: number) => x, pointProvenance(1));
    expect(seq.toJs()).toEqual({ __lazySeq__: true, sourceLength: 3, ops: ["map"] });
  });

  it("AHalfBaked.toJs() is the interval, never the collapsed value", () => {
    const hb = AHalfBaked.collection([Promise.resolve([1])], () => [1, 1]);
    expect(hb.toJs()).toMatchObject({ __halfBaked__: "collection" });
  });
});

describe("deferred egress — the force mechanism force-on-egress will call", () => {
  it("ALazySeq.refine({iterate}) materializes the full plan + the whole cone", async () => {
    const seq = new ALazySeq(CONSTANT_CTX, 
      [new ProvNum(CONSTANT_CTX, 1, pointProvenance(100)), new ProvNum(CONSTANT_CTX, 2, pointProvenance(101))],
      [],
      pointProvenance(1),
    ).map((x: ProvNum) => new ProvNum(CONSTANT_CTX, x.n * 2, EMPTY_PROVENANCE), pointProvenance(2));

    const r = (await seq.refine({ kind: "iterate" })) as {
      items: ProvNum[];
      provenance: ReadonlySet<number>;
    };

    expect(r.items.map((p) => p.n)).toEqual([2, 4]);
    // iterate's cone is everything: grouping(1) + op(2) + both inspected elements(100,101).
    expect(sortedIds(r.provenance)).toEqual([1, 2, 100, 101]);
  });

  it("AHalfBaked.force() is idempotent — forcing at two boundaries folds once", async () => {
    const hb = AHalfBaked.collection([Promise.resolve([1]), Promise.resolve([2])], () => [1, 1]);
    const a = hb.force();
    const b = hb.force();
    expect(a).toBe(b); // same memoized promise — the fold runs once
    await a;
  });
});

describe("deferred egress — the exec/membrane boundary", () => {
  it("CHARACTERIZATION: eager (map …) is materialized before egress — the contract already holds", async () => {
    // The eager wiring forces ALazySeq before the top-level boundary: a bare map/filter
    // comes back as an APair, not a live carrier. So the leak is NOT rampant.
    const [result] = await exec("(map (lambda (x) (* x 2)) (list 1 2 3))");
    expect(is_lazy_seq(result) || is_half_baked(result)).toBe(false);
  });

  it("CHARACTERIZATION: under speculate:true, a top-level result ESCAPES exec as a LIVE AHalfBaked", async () => {
    // The real, reproducible leak. exec does `results.push(result); return results` with no
    // force-on-egress, so the speculative carrier — run-A promises + MUTABLE records settled
    // by a microtask .then — crosses the boundary live. Under the ctx migration it also drags
    // run-A's ctx. force-on-egress must force it BEFORE exec returns; the todos below pin that.
    const [result] = await exec("(filter (lambda (x) (> x 0)) (list 1 -2 3))", { speculate: true });
    expect(is_half_baked(result)).toBe(true);
  });

  // ── force-on-egress: the contract the hermetic-ctx migration installs ──────────────
  it.todo("exec materializes a top-level deferred result before return — even under speculate:true");
  it.todo("force-on-egress is DEEP — a carrier nested in a returned pair/vector is materialized");
  it.todo("a carrier forced at egress carries the PRODUCING run's ctx on its materialized elements");
  it.todo("after force-at-egress, a carrier with another run's captured closures is never refined in a later run");
});
