import { disposeRunContext, execState, LexicalScope, parse } from "@here.build/arrival";
import { beforeAll, describe, expect, it } from "vitest";

import { buildPlan } from "../build-plan.js";
import { createExecutionCapture } from "../capture.js";
import { attachDataflow } from "../dataflow.js";
import type { Plan, Vocabulary } from "../plan.js";
import { ProgressProjector } from "../progress.js";
import { toRenderGraph } from "../render-graph.js";
import type { RenderFrame, RenderGraph } from "../types.js";
import { Gate, ioCapability, run, start, until } from "./program-harness.js";

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

async function planOf(body: string): Promise<{ src: string; plan: Plan }> {
  const src = PRELUDE + body;
  const forms = await parse(src);
  const symbols = new Set(SYMBOLS);
  return { src, plan: await attachDataflow(buildPlan({ forms, symbols, vocabulary }), { forms, symbols, vocabulary }) };
}

/** `${symbol} ${first arg source}` → skippedBecause, for every skipped step. */
const skips = (g: RenderGraph) =>
  Object.fromEntries(
    g.nodes.flatMap((n) =>
      n.kind === "step" && n.state === "skipped" ? [[`${n.symbol} ${n.input[0]?.source}`, n.skippedBecause]] : [],
    ),
  );

describe("skippedBecause", () => {
  it("not-taken: everything inside an arm control flow decided against", async () => {
    // The first test is the cond's selector; the second runs inside its own (untaken) arm.
    const { src, plan } = await planOf(`(cond ((equal? (ask "n") "x") (fetch "one"))
      ((equal? (ask "m") "y") (fetch "two"))
      (else (fetch "three")))`);
    const capture = createExecutionCapture(SYMBOLS);
    await run(src, capture);
    const g = toRenderGraph(plan, new ProgressProjector(plan, capture).update("resolved"));
    // Untaken arms stay lanes: their contents are skipped with them.
    expect(skips(g)).toEqual({ 'fetch "one"': "not-taken", 'fetch "two"': "not-taken" });
    const arms = g.nodes.filter((n) => n.kind === "frame" && n.frame === "arm" && n.state === "skipped");
    expect(arms.map((a) => (a as RenderFrame).skippedBecause)).toEqual(["not-taken", "not-taken"]);
  });

  it("not-reached: what the run never got to before it ended", async () => {
    const { src, plan } = await planOf(`(ask "a")\n(fetch "b")`);
    const gate = new Gate();
    gate.hold = true;
    const capture = createExecutionCapture(SYMBOLS);
    const r = start(src, capture, gate);
    const p = new ProgressProjector(plan, capture);
    await until(() => gate.held.length === 1);
    const g = toRenderGraph(plan, p.settle("cancelled").update());
    expect(skips(g)).toEqual({ 'fetch "b"': "not-reached" });
    gate.releaseAll();
    await r.done;
  });
});

describe("hosted steps inside a track", () => {
  it("follow the painted track, not the whole fan (a macro inside a map callback)", async () => {
    const { src, plan } = await planOf(`(map (lambda (s) (-> s (ask) (fetch))) (list "a" "b"))`);
    const gate = new Gate();
    gate.hold = true;
    const capture = createExecutionCapture(SYMBOLS);
    const r = start(src, capture, gate);
    const p = new ProgressProjector(plan, capture);
    // Finish track #0 (ask "a" then fetch "f:a!") while track #1 stays parked.
    await until(() => gate.held.some((h) => h.arg === "a"));
    gate.release("a");
    await until(() => gate.held.some((h) => h.arg === "f:a!"));
    gate.release("f:a!");
    await until(() => !gate.held.some((h) => h.arg === "f:a!"));
    await new Promise((res) => setTimeout(res, 0));
    p.update();
    const par = (g: RenderGraph) => g.nodes.find((n) => n.kind === "frame" && n.frame === "par") as RenderFrame;
    const states = par(toRenderGraph(plan, p)).instances!.map((i) => i.state);
    const done = states.indexOf("resolved");
    const live = states.findIndex((s) => s !== "resolved");
    expect(done, states.join(" ")).not.toBe(-1);
    expect(live).not.toBe(-1);
    const statesIn = (track: number) =>
      toRenderGraph(plan, p, { selection: new Map([[par(toRenderGraph(plan)).id, track]]) })
        .nodes.filter((n) => n.kind === "step")
        .map((n) => n.state);
    expect(
      statesIn(done).every((s) => s === "resolved"),
      statesIn(done).join(","),
    ).toBe(true);
    expect(statesIn(live).includes("resolved")).toBe(false);
    gate.releaseAll();
    await r.done;
  });
});
