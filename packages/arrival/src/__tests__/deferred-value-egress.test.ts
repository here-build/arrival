/**
 * Deferred-value EGRESS contract — the hermetic-ctx migration's hardest cluster.
 *
 * A deferred carrier captures its PRODUCING RUN, in a way ctx-on-the-value cannot undo:
 * AHalfBaked.slots hold already-dispatched run-A promises; .records is MUTABLE, settled by a
 * .then callback that fires on the microtask queue with NO run/ctx active.
 *
 * So `new AValue(ctx)` is necessary-but-not-sufficient for deferred values: a leaked carrier
 * refined in run B still awaits run-A's promises regardless of whose ctx the value holds. The
 * only sound fix is FORCE-ON-EGRESS — materialize every carrier at the exec/membrane boundary,
 * BEFORE it can cross out of its run, deeply through any structure that wraps it.
 *
 * This suite pins that contract. The GREEN tests characterize the hazard + today's boundary
 * (exec returns its top-level result WITHOUT forcing). The `it.todo` tests spec the
 * force-on-egress the migration installs. See project-arrival-hermetic-env-dissolution.
 */
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { pointProvenance } from "../values/primitives/AValue.js";
import { AExact } from "../values/primitives/AExact.js";
import { AHalfBaked, is_half_baked } from "../values/primitives/AHalfBaked.js";
import { exec } from "../eval/generator-exec.js";
import type { SchemeValue } from "../values/types.js";

const flushMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("deferred egress — the carrier captures its PRODUCING run (ctx can't undo it)", () => {
  it("AHalfBaked.records is MUTABLE cross-run state, settled by a microtask .then untethered to any run", async () => {
    let settle!: (items: SchemeValue[]) => void;
    const slot = new Promise<SchemeValue[]>((res) => {
      settle = res;
    });
    // A filter slot: cardinality [0,1] until the predicate's promise settles.
    const hb = AHalfBaked.collection(CONSTANT_CTX, [slot], () => [0, 1], pointProvenance(7));

    expect(hb.isFullySettled).toBe(false);
    expect(hb.interval()).toEqual({ lo: 0, hi: 1 });

    settle([new AExact(CONSTANT_CTX, 42n)]); // the slot keeps its element
    await flushMicrotasks(); // let the carrier's internal .then mutate `records`

    // The interval narrowed via a callback that fired on the microtask queue with no run
    // active. Had this carrier escaped its producing run, that mutation would still fire
    // here — in whatever context the microtask happens to run. That is the leak.
    expect(hb.isFullySettled).toBe(true);
    expect(hb.interval()).toEqual({ lo: 1, hi: 1 });
  });
});

describe("deferred egress — un-forced escape is structurally detectable", () => {
  it('AHalfBaked["arrival/toJS"]() is the interval, never the collapsed value', () => {
    const hb = AHalfBaked.collection(CONSTANT_CTX, [Promise.resolve([new AExact(CONSTANT_CTX, 1n)])], () => [1, 1]);
    expect(hb["arrival/toJS"]()).toMatchObject({ __halfBaked__: "collection" });
  });
});

describe("deferred egress — the force mechanism force-on-egress will call", () => {
  it("AHalfBaked.force() is idempotent — forcing at two boundaries folds once", async () => {
    const hb = AHalfBaked.collection(
      CONSTANT_CTX,
      [Promise.resolve([new AExact(CONSTANT_CTX, 1n)]), Promise.resolve([new AExact(CONSTANT_CTX, 2n)])],
      () => [1, 1],
    );
    const a = hb.force();
    const b = hb.force();
    expect(a).toBe(b); // same memoized promise — the fold runs once
    await a;
  });
});

describe("deferred egress — the exec/membrane boundary", () => {
  it("CHARACTERIZATION: eager (map …) is materialized before egress — the contract already holds", async () => {
    // The eager wiring materializes a bare map/filter before the top-level boundary: it
    // comes back as an APair, not a live carrier. So the leak is NOT rampant.
    const [result] = await exec("(map (lambda (x) (* x 2)) (list 1 2 3))");
    expect(is_half_baked(result)).toBe(false);
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
