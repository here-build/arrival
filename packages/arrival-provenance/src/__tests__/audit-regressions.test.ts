/**
 * Regression suite for provenance analysis failure points (Cluster 2):
 *   2.1 `regionsAt` retains single-call tail-position lambda predicates in `filter` (`c.children.length === 0`)
 *   2.2 `filterDecision` resolves origins and collection elements from compound inline args, bare symbols, and vectors
 *   2.3 `filterDecision` avoids region ID collision when the predicate itself is a provenance point
 *   2.4 & 2.5 `wireBranchDecision` / `resolveRaw` / `livePointsUnder` handle bracketed `[name val]` bindings,
 *       symbol aliases, multi-hop `let*` plucks, `define`-bound symbols, and inline points in `if` tests
 *   2.6 `TraceRegionFold` maintains parity with `traceToRegions` across same-delta point+branch arrivals and `trace.clear()`
 *   2.7 `carrierFieldEdges` attributes fields for inline-source plucks `(:name (infer ...))` and `let`-bound plucks `(let ((n (:name x))) (infer n))`
 */
import { EnvCapability, execState } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { carrierFieldEdges } from "../analysis.js";
import { EvalTrace, TraceRegionFold, traceToRegions, type Region } from "../index.js";

function makeCap() {
  return EnvCapability.define("test/audit-provenance", {
    symbols: (symbol, z) => ({
      infer: symbol.rosetta`infer: returns a record with keep, score, and name`(
        { input: [z.string], output: [z.dynamic], provenance: "source" },
        function (tag: string) {
          const keep = tag.startsWith("keep");
          return { keep, score: keep ? 0.9 : 0.1, name: `name:${tag}` };
        },
      ),
      "infer-list": symbol.rosetta`infer-list: returns a single-element list of records`(
        { input: [z.string], output: [z.dynamic], provenance: "source" },
        function (tag: string) {
          return [{ name: `item:${tag}`, verdict: tag }];
        },
      ),
      "check-item": symbol.rosetta`check-item: provenance-point predicate`(
        { input: [z.dynamic], output: [z.boolean], provenance: "source" },
        function (x: unknown) {
          const raw =
            typeof (x as { valueOf?: () => unknown })?.valueOf === "function"
              ? (x as { valueOf: () => unknown }).valueOf()
              : x;
          if (typeof raw === "object" && raw !== null && "keep" in raw) {
            return Boolean((raw as { keep: unknown }).keep);
          }
          return String(raw) === "keep";
        },
      ),
    }),
  });
}

function collectIds(rs: readonly Region[]): number[] {
  const out: number[] = [];
  for (const r of rs) {
    out.push(r.id);
    if (r.kind === "fanout") {
      for (const it of r.iterations) out.push(...collectIds(it));
    }
  }
  return out;
}

function decisionsOf(rs: readonly Region[]): Extract<Region, { kind: "decision" }>[] {
  const out: Extract<Region, { kind: "decision" }>[] = [];
  for (const r of rs) {
    if (r.kind === "decision") out.push(r);
    else if (r.kind === "fanout") {
      for (const it of r.iterations) out.push(...decisionsOf(it));
    }
  }
  return out;
}

describe("Cluster 2 — arrival-provenance region, fold, and carrier-fields regressions", () => {
  it("2.1 & 2.2: filterDecision emits a decision marker for single-call lambda predicates over inline list and bare symbol", async () => {
    const cap = makeCap();

    // Case A: inline `(list (infer "keep-1") (infer "drop-1"))` (compound arg with children)
    // and single-call lambda `(lambda (x) (:keep x))` (tail call => 0 children on appl inv).
    const traceInline = new EvalTrace();
    traceInline.withAutoBindings();
    await execState(`(filter (lambda (x) (:keep x)) (list (infer "keep-1") (infer "drop-1")))`, {
      tap: traceInline,
      eagerStamps: true,
      capabilities: [cap],
    });
    const regionsInline = traceToRegions(traceInline);
    const decInline = decisionsOf(regionsInline.roots).find((d) => d.label === "filter");
    expect(decInline).toBeDefined();
    expect(decInline?.condition).toBe("kept 1 of 2");
    expect(decInline?.verdicts).toHaveLength(2);
    expect(TraceRegionFold.fromTrace(traceInline)).toEqual(regionsInline);

    // Case B: bare symbol collection `xs` bound by `let`
    const traceSym = new EvalTrace();
    traceSym.withAutoBindings();
    await execState(
      `(let ((xs (list (infer "keep-1") (infer "drop-1"))))
         (filter (lambda (x) (:keep x)) xs))`,
      { tap: traceSym, eagerStamps: true, capabilities: [cap] },
    );
    const regionsSym = traceToRegions(traceSym);
    const decSym = decisionsOf(regionsSym.roots).find((d) => d.label === "filter");
    expect(decSym).toBeDefined();
    expect(decSym?.condition).toBe("kept 1 of 2");
    expect(decSym?.verdicts).toHaveLength(2);
    expect(TraceRegionFold.fromTrace(traceSym)).toEqual(regionsSym);
  });

  it("2.3: filterDecision avoids region ID collision when every predicate application is a provenance point", async () => {
    const cap = makeCap();
    const trace = new EvalTrace();
    trace.withAutoBindings();
    await execState(`(filter (lambda (x) (check-item x)) (list (infer "keep-1") (infer "drop-1")))`, {
      tap: trace,
      eagerStamps: true,
      capabilities: [cap],
    });
    const graph = traceToRegions(trace);
    const allIds = collectIds(graph.roots);
    expect(new Set(allIds).size).toBe(allIds.length);
    const dec = decisionsOf(graph.roots).find((d) => d.label === "filter");
    expect(dec).toBeDefined();
    expect(TraceRegionFold.fromTrace(trace)).toEqual(graph);
  });

  it("2.4 & 2.5: branch decisions wire across bracketed let, symbol aliases, multi-hop let* plucks, define bindings, and inline point tests", async () => {
    const cap = makeCap();
    const cases = [
      // Bracketed let + multi-hop let* pluck + symbol alias
      `(map (lambda (tag)
              (let* ([raw (infer tag)]
                     [sc (:score raw)]
                     [alias sc])
                (if (> alias 0.5) (infer "then") (infer "else"))))
            (list "keep-1" "drop-1"))`,
      // Top-level define binding referenced in a live branch
      `(begin
         (define shared (infer "keep-1"))
         (map (lambda (thresh)
                (if (> (:score shared) thresh) (infer "high") (infer "low")))
              (list 0.5 0.99)))`,
      // Inline provenance-point call inside the `if` test expression
      `(map (lambda (tag)
              (if (check-item tag) (infer "kept") (infer "dropped")))
            (list "keep" "drop"))`,
    ];

    for (const code of cases) {
      const trace = new EvalTrace();
      trace.withAutoBindings();
      await execState(code, { tap: trace, eagerStamps: true, capabilities: [cap] });
      const graph = traceToRegions(trace);
      const ifDecisions = decisionsOf(graph.roots).filter((d) => d.label === "if");
      expect(ifDecisions.length).toBeGreaterThanOrEqual(1);
      expect(TraceRegionFold.fromTrace(trace)).toEqual(graph);
    }
  });

  it("2.6: TraceRegionFold resets cleanly when trace.clear() is called between runs", async () => {
    const cap = makeCap();
    const trace = new EvalTrace();
    const fold = new TraceRegionFold(trace);

    await execState(`(infer "keep-1")`, { tap: trace, eagerStamps: true, capabilities: [cap] });
    fold.applyDelta();
    expect(fold.current()).toEqual(traceToRegions(trace));

    trace.clear();
    await execState(`(let ((a (infer "keep-2"))) (infer (:name a)))`, {
      tap: trace,
      eagerStamps: true,
      capabilities: [cap],
    });
    fold.applyDelta();
    expect(fold.current()).toEqual(traceToRegions(trace));
  });

  it("2.7: carrierFieldEdges attributes both inline-source plucks and let-bound plucks passed as bare symbols", async () => {
    const cap = makeCap();

    // 2.7.1: Inline source inside pluck `(:name (car (infer-list "u")))`
    const traceInline = new EvalTrace();
    traceInline.withAutoBindings();
    await execState(`(infer (:name (car (infer-list "u"))))`, {
      tap: traceInline,
      eagerStamps: true,
      capabilities: [cap],
    });
    const edgesInline = carrierFieldEdges(traceInline);
    expect([...edgesInline.values()].map((s) => [...s])).toEqual([["name"]]);

    // 2.7.2: Let-bound pluck passed as bare symbol `(let ((n (:name x))) (infer n))`
    const traceLet = new EvalTrace();
    traceLet.withAutoBindings();
    await execState(
      `(let* ((x (infer "keep-1"))
              (n (:name x)))
         (infer n))`,
      { tap: traceLet, eagerStamps: true, capabilities: [cap] },
    );
    const edgesLet = carrierFieldEdges(traceLet);
    expect([...edgesLet.values()].map((s) => [...s])).toEqual([["name"]]);
  });
});
