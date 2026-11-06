/**
 * LATE POINT PROMOTION — the fold vs the streaming-host marking race.
 *
 * The membrane marks a rosetta invocation as a provenance point only when its host fn
 * SETTLES; streaming hosts (the studio's inference planes) mark earlier, at the provider
 * crossing — but either way there is an enter→mark window. A fold tick landing inside it
 * mirrors the invocation as a NON-point (and its children without provenance), and the
 * points pass walks only fresh invocations — so without `#promoteLatePoint` the leaf
 * stays invisible FOREVER, even after the call settles.
 *
 * The fixture reproduces the studio timeline exactly: an async rosetta that (1) parks
 * pre-crossing, (2) marks its invocation via `trace.markProvenancePoint` (what the
 * studio's `onCell` hook does), (3) parks again while "streaming", (4) resolves. The
 * fold ticks between every stage; the leaf must appear at stage 2 with state "running",
 * and the settled graph must deep-equal the from-scratch build.
 */
import { EnvCapability, execState, LexicalScope } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { traceToChain, traceToStatechart } from "../analysis.js";
import { EvalTrace, TraceRegionFold, traceToRegions, type Invocation, type Region } from "../index.js";

type Leaf = Extract<Region, { kind: "leaf" }>;

function leavesOf(roots: readonly Region[]): Leaf[] {
  const out: Leaf[] = [];
  const walk = (rs: readonly Region[]): void => {
    for (const r of rs) {
      if (r.kind === "leaf") out.push(r);
      else if (r.kind === "fanout") for (const it of r.iterations) walk(it);
    }
  };
  walk(roots);
  return out;
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((res) => (open = res));
  return { promise, open };
}

describe("TraceRegionFold — late point promotion (streaming-host marking race)", () => {
  it("a point marked after ingest still becomes a leaf, first as running, then at parity", async () => {
    const entered = gate();
    const preCrossing = gate();
    const marked = gate();
    const streaming = gate();
    const trace = new EvalTrace();

    const capability = EnvCapability.define("test/slow-infer", {
      symbols: (symbol, z) => ({
        "slow-infer": symbol.rosetta`slow-infer: parks pre-crossing, marks at the crossing, parks streaming`(
          { input: [z.string], output: [z.string] },
          async function (q) {
            // Host body is past membrane enter — invocation is on the log, still unmarked.
            entered.open();
            // The enter→crossing window (arg eval / tool resolution in the real plane).
            await preCrossing.promise;
            // The provider crossing — exactly the studio hook's marking.
            const inv = (this as { invocation?: { currentInvocation?: Invocation } })?.invocation?.currentInvocation;
            if (inv) trace.markProvenancePoint(inv);
            marked.open();
            // The model streams…
            await streaming.promise;
            return `SRC:${q}`;
          },
        ),
      }),
    });

    const scope = LexicalScope.fresh("late-point-test");
    const fold = new TraceRegionFold(trace);
    const run = execState(`(slow-infer "q")`, { scope, tap: trace, capabilities: [capability] });
    run.catch(() => {}); // surfaced via the awaited `run` below; never unhandled mid-test

    // Tick 1 — INSIDE the race window: the invocation entered, is running, unmarked.
    // First execState pays BASE_ROSTER vocabulary + prelude; a 0-timer is not a stage
    // barrier and on CI fires while bootstrap is still running (0 leaves looks like
    // "unmarked" and the next tick has nothing to promote).
    await entered.promise;
    fold.applyDelta();
    expect(trace.invocationLog.length).toBeGreaterThan(0);
    expect(trace.invocationLog.some((inv) => inv.isProvenancePoint)).toBe(false);
    expect(leavesOf(fold.current().roots).filter((l) => l.label === "slow-infer")).toHaveLength(0);

    // Crossing: the host marks the point while the call is still in flight.
    preCrossing.open();
    await marked.promise;
    fold.applyDelta();
    const midFlight = leavesOf(fold.current().roots).filter((l) => l.label === "slow-infer");
    expect(midFlight).toHaveLength(1);
    expect(midFlight[0]!.state).toBe("running"); // the streaming card, not just the settled one

    // The reply lands; the settled fold must deep-equal the from-scratch build.
    streaming.open();
    await run;
    fold.applyDelta();
    const folded = fold.current();
    const fresh = traceToRegions(trace);
    expect(folded.roots).toEqual(fresh.roots);
    expect(folded.edges).toEqual(fresh.edges);
    const settled = leavesOf(folded.roots).filter((l) => l.label === "slow-infer");
    expect(settled).toHaveLength(1);
    expect(settled[0]!.state).toBe("resolved");
    expect(settled[0]!.value).toBe("SRC:q");
  });

  it("retains childless point leaves in fanout args/bodies and wires bare-symbol provenance across regions, fold, statechart, and chain", async () => {
    const trace = new EvalTrace();
    const capability = EnvCapability.define("test/bare-symbol-fanout", {
      symbols: (symbol, z) => ({
        "list-items": symbol.rosetta`list-items: inline collection producer`(
          { input: [z.string], output: [z.list(z.string)] },
          (dir) => [`${dir}/a`, `${dir}/b`],
        ),
        "read-item": symbol.rosetta`read-item: leaf-only map body taking a bare symbol`(
          { input: [z.string], output: [z.string] },
          (path) => `content:${path}`,
        ),
        summarize: symbol.rosetta`summarize: consumer taking a bare symbol`(
          { input: [z.string], output: [z.string] },
          (merged) => `summary:${merged}`,
        ),
      }),
    });

    const program = `
      (define items (map (lambda (f) (read-item f)) (list-items "src")))
      (define merged (apply string-append items))
      (summarize merged)
    `;
    await execState(program, { scope: LexicalScope.fresh("bare-sym-test"), tap: trace, capabilities: [capability] });

    const regions = traceToRegions(trace);
    expect(TraceRegionFold.fromTrace(trace)).toEqual(regions);

    const leaves = leavesOf(regions.roots);
    const [listItems, readA, readB, summarize] = leaves;
    expect(leaves.map((l) => l.label)).toEqual(["list-items", "read-item", "read-item", "summarize"]);
    expect(regions.roots.map((r) => r.kind)).toEqual(["leaf", "fanout", "leaf", "output"]);
    expect(regions.edges).toEqual([
      { from: listItems!.id, to: readA!.id, kind: "data" },
      { from: listItems!.id, to: readB!.id, kind: "data" },
      { from: readA!.id, to: summarize!.id, kind: "data" },
      { from: readB!.id, to: summarize!.id, kind: "data" },
      { from: summarize!.id, to: -1, kind: "data" },
    ]);

    expect(traceToStatechart(trace).edges).toEqual([
      { from: listItems!.id, to: readA!.id, kind: "forward" },
      { from: listItems!.id, to: summarize!.id, kind: "forward" },
      { from: readA!.id, to: summarize!.id, kind: "forward" },
    ]);
    expect(traceToChain(trace).edges).toEqual([
      { from: listItems!.id, to: readA!.id },
      { from: listItems!.id, to: readB!.id },
      { from: listItems!.id, to: summarize!.id },
      { from: readA!.id, to: summarize!.id },
      { from: readB!.id, to: summarize!.id },
    ]);
  });
});
