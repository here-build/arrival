/**
 * Regression suite for execution-graph failure points (Cluster 4):
 *   4.1 `#outputLength` reads `retainedValue` when the fan host's `inv.value` was pruned by an outer parent,
 *       and `listLength` / `elementsFrom` handle `AVector` (`vector-map`) as well as `APair` lists
 *   4.2 `walkTry` and `dataflow` walk all body forms before `(catch ...)` / `(finally ...)`
 *   4.3 `walkQuasi`, `partsOf`, and `surfaceOf` traverse `{...}` dict literals and dotted-tail unquotes `` `(a . ,(ask "x")) ``
 *   4.4 `do` loops whose designated steps live only in `results` join without unreached steps,
 *       and `do`/`while` loops with a bare-symbol test open a separate body per iteration
 */
import { disposeRunContext, execState, LexicalScope, parse } from "@here.build/arrival";
import { beforeAll, describe, expect, it } from "vitest";

import { buildPlan } from "../build-plan.js";
import { createExecutionCapture } from "../capture.js";
import { attachDataflow } from "../dataflow.js";
import type { Plan, Vocabulary } from "../plan.js";
import { ProgressProjector } from "../progress.js";
import { retainedSpans, toRenderGraph } from "../render-graph.js";
import type { RenderFrame } from "../types.js";
import { Gate, ioCapability, run } from "./program-harness.js";

const PRELUDE = `(define (ask p) (io p))
(define (fetch u) (io (string-append "f:" u)))
`;
const SYMBOLS = ["ask", "fetch"];

let vocabulary: Vocabulary;
beforeAll(async () => {
  const st = await execState("(begin)", {
    scope: LexicalScope.fresh("v"),
    capabilities: [ioCapability(new Gate())],
    config: {},
  });
  vocabulary = new Map(st.runCtx.vocabulary!);
  await disposeRunContext(st.runCtx);
});

async function planOf(body: string, designated = SYMBOLS): Promise<{ src: string; plan: Plan }> {
  const src = PRELUDE + body;
  const forms = await parse(src);
  const symbols = new Set(designated);
  return { src, plan: await attachDataflow(buildPlan({ forms, symbols, vocabulary }), { forms, symbols, vocabulary }) };
}

async function completed(body: string, designated = SYMBOLS) {
  const { src, plan } = await planOf(body, designated);
  const capture = createExecutionCapture(designated);
  capture.retainSpans(retainedSpans(plan));
  const { error } = await run(src, capture);
  const p = new ProgressProjector(plan, capture).update(error ? "rejected" : "resolved");
  return { plan, p, g: toRenderGraph(plan, p) };
}

describe("Cluster 4 — arrival-execution-graph regressions", () => {
  it("4.1: nested bare-callback map and vector-map retain their application count after outer form pruning", async () => {
    // Nested inside `(let ...)` so the `map` / `vector-map` invocation's own `inv.value` is pruned on parent exit;
    // `#outputLength` must read `capture.retainedValue(inv)` and handle both lists and vectors.
    const { g: listGraph } = await completed(`(let ((xs (map io (list "a" "b" "c")))) (ask (car xs)))`, ["io", "ask"]);
    const mapFrame = listGraph.nodes.find((n): n is RenderFrame => n.kind === "frame" && n.frame === "par");
    expect(mapFrame).toBeDefined();
    expect(mapFrame?.progress).toEqual({ resolved: 3, running: 0, rejected: 0, pending: 0, total: 3 });

    const { g: vecGraph } = await completed(`(let ((xs (vector-map io (vector "a" "b")))) (ask (vector-ref xs 0)))`, [
      "io",
      "ask",
    ]);
    const vecMapFrame = vecGraph.nodes.find((n): n is RenderFrame => n.kind === "frame" && n.frame === "par");
    expect(vecMapFrame).toBeDefined();
    expect(vecMapFrame?.progress).toEqual({ resolved: 2, running: 0, rejected: 0, pending: 0, total: 2 });
  });

  it("4.2: walkTry and attachDataflow support multiple body forms before catch/finally", async () => {
    const { plan } = await planOf(
      `(try
         (ask "first")
         (fetch "second")
         (catch (e) (ask "recovered"))
         (finally (fetch "cleanup")))`,
    );
    expect(plan.dataflow).toEqual({ status: "complete", missing: 0 });
    const tryFrame = plan.root.children[0];
    expect(tryFrame?.kind).toBe("frame");
    if (tryFrame?.kind === "frame") {
      const stepSymbols = tryFrame.children.filter((c) => c.kind === "step").map((c) => c.symbol);
      expect(stepSymbols).toEqual(["ask", "fetch", "fetch"]);
    }
  });

  it("4.3: quasiquote walks unquotes inside dict literals and dotted pair tails with complete dataflow", async () => {
    const { plan } = await planOf('`{:k ,(ask "dict-val") :pair (head . ,(fetch "tail-val")) :vec [,(ask "vec-val")]}');
    expect(plan.root.children.map((c) => c.kind === "step" && c.symbol)).toEqual(["ask", "fetch", "ask"]);
    expect(plan.dataflow).toEqual({ status: "complete", missing: 0 });
  });

  it("4.4: do loop with steps only in results joins cleanly, and do loop with bare-symbol test tracks iterations", async () => {
    // Part A: `do` loop where designated step `(fetch acc)` lives only in the exit results clause
    const { plan: resultOnlyPlan } = await planOf(
      `(do ((i 0 (+ i 1)) (acc (ask "seed") (string-append acc "!")))
           ((= i 2) (fetch acc)))`,
    );
    expect(resultOnlyPlan.dataflow).toEqual({ status: "complete", missing: 0 });

    // Part B: `do` loop whose test is a bare symbol `done` (runs 2 iterations before `done` becomes #t)
    const { p: bareTestProgress, g: bareTestGraph } = await completed(
      `(do ((i 0 (+ i 1)) (done #f (>= i 1)))
           (done "finished")
         (ask (number->string i)))`,
    );
    const loopFrame = bareTestGraph.nodes.find((n): n is RenderFrame => n.kind === "frame" && n.frame === "loop");
    expect(loopFrame).toBeDefined();
    expect(loopFrame?.instances).toHaveLength(2);
    expect(bareTestProgress.counters.unplacedInvocations).toBe(0);
  });
});
