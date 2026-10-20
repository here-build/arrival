import { disposeRunContext, execState, LexicalScope, parse } from "@here.build/arrival";
import { beforeAll, describe, expect, it } from "vitest";

import { buildPlan } from "../build-plan.js";
import { createExecutionCapture } from "../capture.js";
import { attachDataflow } from "../dataflow.js";
import type { Plan, Vocabulary } from "../plan.js";
import { type Progress, ProgressProjector } from "../progress.js";
import { followed, retainedSpans, toRenderGraph } from "../render-graph.js";
import type { RenderFrame, RenderGraph, RenderStep, RenderTransform } from "../types.js";
import { Gate, ioCapability, run, start, until } from "./program-harness.js";

// Designated functions are program-defined; `io` is the async host port the gate can hold.
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
  const { error } = await run(src, capture);
  const p = new ProgressProjector(plan, capture).update(error ? "rejected" : "resolved");
  return { plan, p, g: toRenderGraph(plan, p) };
}

/** A run whose host calls park until released. */
async function held(body: string) {
  const { src, plan } = await planOf(body);
  const gate = new Gate();
  gate.hold = true;
  const capture = createExecutionCapture(SYMBOLS);
  const r = start(src, capture, gate);
  return { plan, gate, r, p: new ProgressProjector(plan, capture) };
}

const node = (g: RenderGraph, id: string) => {
  const n = g.nodes.find((x) => x.id === id);
  expect(n, `node ${id} in [${g.nodes.map((x) => x.id).join(", ")}]`).toBeDefined();
  return n!;
};
const frame = (g: RenderGraph, id: string) => node(g, id) as RenderFrame;
const step = (g: RenderGraph, id: string) => node(g, id) as RenderStep;
const childrenOf = (g: RenderGraph, id: string) => g.nodes.filter((n) => n.parent === id);
const edgeIds = (g: RenderGraph, kind?: string) =>
  g.edges
    .filter((e) => !kind || e.kind === kind)
    .map((e) => `${e.from.node}:${e.from.port}->${e.to.node}:${e.to.port}`);
const frames = (g: RenderGraph, kind: RenderFrame["frame"]) =>
  g.nodes.filter((n): n is RenderFrame => n.kind === "frame" && n.frame === kind);
const transforms = (g: RenderGraph) => g.nodes.filter((n): n is RenderTransform => n.kind === "transform");
const text = (v: unknown) => String((v as { valueOf(): unknown }).valueOf());
const listItemsOf = (v: unknown): string[] => {
  const out: string[] = [];
  for (let c = v as { car?: unknown; cdr?: unknown } | undefined; c && "car" in c; c = c.cdr as typeof c)
    out.push(text(c.car));
  return out;
};
const strip = (f: RenderFrame) => f.instances?.map((i) => i.state);

/** Structural invariants every graph keeps. */
function wellFormed(g: RenderGraph): void {
  const seen = new Set<string>();
  for (const n of g.nodes) {
    expect(seen.has(n.id), `duplicate node ${n.id}`).toBe(false);
    if (n.parent !== null) expect(seen.has(n.parent), `${n.id} before its parent ${n.parent}`).toBe(true);
    seen.add(n.id);
    if (n.kind === "frame" && n.collapsed) expect(childrenOf(g, n.id)).toEqual([]);
  }
  const edges = new Set<string>();
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const e of g.edges) {
    expect(seen.has(e.from.node) && seen.has(e.to.node), `edge ${e.id} has a missing endpoint`).toBe(true);
    // Every edge names a port its endpoint declares (`order` attaches to the node itself).
    for (const end of [e.from, e.to]) {
      if (end.port === "order") continue;
      expect(
        byId.get(end.node)?.ports.map((p) => p.id),
        `edge ${e.id}: port ${end.port} on ${end.node}`,
      ).toContain(end.port);
    }
    expect(edges.has(e.id), `duplicate edge ${e.id}`).toBe(false);
    edges.add(e.id);
  }
}

/** Everything the layout reads — ids, parents, kinds, labels, collapsed flags, ports, edges,
 *  transform texts — and nothing it paints. */
function structureOf(g: RenderGraph): string {
  const shape = (n: RenderGraph["nodes"][number]) => {
    if (n.kind === "frame") return [n.frame, n.label, n.caption, n.collapsed === true];
    return n.kind === "transform" ? n.text : n.symbol;
  };
  return JSON.stringify({
    nodes: g.nodes.map((n) => [n.kind, n.id, n.parent, shape(n), n.ports.map((p) => `${p.id}/${p.side}`)]),
    edges: g.edges.map((e) => [e.id, e.kind, e.from, e.to, e.path]),
  });
}

/** Every selection a reader can reach by picking, from following live (breadth-first). */
function reachable(plan: Plan, p: Progress, budget = 200): RenderGraph[] {
  const seen = new Set<string>();
  const queue: Map<string, number>[] = [new Map()];
  const out: RenderGraph[] = [];
  while (queue.length > 0 && out.length < budget) {
    const selection = queue.shift()!;
    const id = JSON.stringify([...selection].sort());
    if (seen.has(id)) continue;
    seen.add(id);
    const g = toRenderGraph(plan, p, { selection });
    out.push(g);
    for (const z of g.nodes) {
      if (z.kind !== "frame" || !z.instances) continue;
      // One past the end too: clamping.
      for (let o = 0; o <= z.instances.length; o++) {
        if (o !== z.selected) queue.push(new Map([...selection, [z.selectionKey ?? z.id, o]]));
      }
    }
  }
  return out;
}

const MAP = `(let* ((plan (ask "plan"))
       (steps (map (lambda (s) (ask s)) (list plan "b" "c"))))
  (fetch (car steps)))`;
const LOOP = `(let loop ((i 0) (d "x"))
  (if (< i 3) (loop (+ i 1) (ask d)) (fetch d)))`;
const BRANCH = `(let ((d (ask "q")))
  (if (string? d) (fetch d) (ask "no")))`;
const RECURSION = `(define (deep n) (if (= n 0) (fetch "end") (string-append (ask "x") (deep (- n 1)))))
(deep 2)`;
const NESTED = `(map (lambda (s) (let loop ((i 0) (acc s)) (if (< i 2) (loop (+ i 1) (ask acc)) acc)))
     (list "a" "b" "c"))`;
const WALK = `(define (walk t) (if (pair? t) (map walk t) (ask t)))
(walk (list "a" (list "b" "c")))`;

/** Programs on the supported corpus: no top-level value define captured by a wire (arrival
 *  0.9.9 wireframe), no macros. */
const CORPUS: Record<string, string> = {
  letStar: `(let* ((a (ask "1")) (b (fetch a))) (ask b))`,
  nested: `(ask (fetch "x"))`,
  independent: `(ask "a")\n(fetch "b")`,
  map: MAP,
  mapBare: `(map ask (list "a" "b"))`,
  loop: LOOP,
  branch: BRANCH,
  cond: `(let ((d (ask "q"))) (cond ((equal? d "x") (ask "x")) ((string? d) (fetch d)) (else (ask "e"))))`,
  call: `(define (summarize u) (ask (fetch u)))\n(summarize "a")\n(summarize "b")`,
  recursion: RECURSION,
  forEach: `(for-each (lambda (s) (ask s)) (list "a" "b"))`,
  doLoop: `(do ((i 0 (+ i 1))) ((= i 2) (fetch "done")) (ask "body"))`,
  walk: WALK,
  handler: `(with-exception-handler (lambda (e) (fetch "h")) (lambda () (ask "a")))`,
  guard: `(guard (e (#t (fetch "handled"))) (ask "a") (raise 'boom) (ask "never"))`,
  nestedFold: NESTED,
  fanIn: `(string-append (ask "a") (fetch "b"))`,
};

describe("toRenderGraph — potential", () => {
  it("let*-chain: steps in order, data edges, no order edge where data already orders", async () => {
    const { plan } = await planOf(CORPUS.letStar!);
    const g = toRenderGraph(plan);
    wellFormed(g);
    expect(g.nodes.map((n) => `${n.kind}:${n.id}:${n.state}`)).toEqual([
      "frame:<program>:potential",
      "step:ask@3:10:potential",
      "step:fetch@3:24:potential",
      "step:ask@3:36:potential",
    ]);
    expect(edgeIds(g, "data")).toEqual(
      expect.arrayContaining(["ask@3:10:out->fetch@3:24:in:arg0", "fetch@3:24:out->ask@3:36:in:arg0"]),
    );
    expect(edgeIds(g, "order")).toEqual([]);
    expect(step(g, "fetch@3:24").ports.map((p) => p.id)).toEqual(["in:arg0", "out"]);
    expect(step(g, "fetch@3:24").input).toEqual([{ slot: "arg0", source: "a", hasValue: false }]);
  });

  it("a keyword argument is one slot in both modes: the value after the keyword, its port named by it", async () => {
    const body = `(define (tool name . opts) (io name))
(tool "t" :k "v" :n (string-append "x" "y"))`;
    const { plan } = await planOf(body, ["tool"]);
    const potential = toRenderGraph(plan).nodes.find((n): n is RenderStep => n.kind === "step")!;
    expect(potential.input.map((a) => [a.slot, a.source])).toEqual([
      ["arg0", '"t"'],
      [":k", '"v"'],
      [":n", '(string-append "x" "y")'],
    ]);
    expect(potential.ports.map((p) => p.id)).toEqual(["in:arg0", "in::k", "in::n", "out"]);
    const { g } = await completed(body, ["tool"]);
    const actual = g.nodes.find((n): n is RenderStep => n.kind === "step")!;
    expect(actual.input.map((a) => [a.slot, text(a.value)])).toEqual([
      ["arg0", "t"],
      [":k", "v"],
      [":n", "xy"],
    ]);
  });

  it("independent steps get an order edge", async () => {
    const { plan } = await planOf(CORPUS.independent!);
    const g = toRenderGraph(plan);
    expect(edgeIds(g, "order")).toEqual(["ask@3:0:order->fetch@4:0:order"]);
  });

  it("map: one par frame holding the template, ports from params, captions from the schedule", async () => {
    const { plan } = await planOf(MAP);
    const g = toRenderGraph(plan);
    wellFormed(g);
    const par = frame(g, "map@4:14");
    expect(par).toMatchObject({ frame: "par", caption: "in parallel" });
    expect(par.instances).toBeUndefined();
    expect(par.ports.map((p) => p.id)).toEqual(expect.arrayContaining(["in:s"]));
    expect(childrenOf(g, par.id).map((n) => n.id)).toEqual(["ask@4:31"]);
    expect(edgeIds(g)).toContain("map@4:14:in:s->ask@4:31:in:arg0");
  });

  it("captions: loop / series / ×? via host / on raise", async () => {
    const caption = async (body: string, kind: RenderFrame["frame"]) =>
      frames(toRenderGraph((await planOf(body)).plan), kind).map((f) => f.caption);
    expect(await caption(LOOP, "loop")).toEqual(["in loop"]);
    expect(await caption(`(reduce (lambda (x acc) (ask acc)) "" (list "a"))`, "loop")).toEqual(["in series"]);
    expect(await caption(CORPUS.handler!, "callback")).toEqual([
      "×? via with-exception-handler",
      "×? via with-exception-handler",
    ]);
    expect(await caption(CORPUS.guard!, "branch")).toEqual(["on raise"]);
  });

  it("call frame inlined per call site; recursion stub collapsed", async () => {
    const call = toRenderGraph((await planOf(CORPUS.call!)).plan);
    expect(frame(call, "summarize@4:0").frame).toBe("call");
    expect(frame(call, "summarize@5:0").frame).toBe("call");
    expect(edgeIds(call, "order")).toEqual(["summarize@4:0:order->summarize@5:0:order"]);
    const rec = toRenderGraph((await planOf(RECURSION)).plan);
    expect(frame(rec, "deep@4:0▸deep@3:68").collapsed).toBe(true);
  });

  it("no order edge into a guard's on-raise branch", async () => {
    const g = toRenderGraph((await planOf(CORPUS.guard!)).plan);
    expect(g.edges.filter((e) => e.kind === "order" && e.to.node.endsWith("/raise"))).toEqual([]);
  });

  it("no order edge between callbacks of the same host (operand order is not run order)", async () => {
    const g = toRenderGraph((await planOf(CORPUS.handler!)).plan);
    expect(frames(g, "callback")).toHaveLength(2);
    expect(edgeIds(g, "order")).toEqual([]);
  });

  it.each(Object.keys(CORPUS))("corpus %s: well-formed, nothing dropped", async (name) => {
    const { plan } = await planOf(CORPUS[name]!);
    const g = toRenderGraph(plan);
    wellFormed(g);
    expect(g.nodes.every((n) => n.state === "potential")).toBe(true);
    expect(g.diagnostics.droppedEdges).toBe(0);
    expect(g.diagnostics.unplacedInvocations).toBe(0);
  });
});

describe("toRenderGraph — lines and blocks", () => {
  it("a projection is a line with its path; an identity a plain line", async () => {
    const g = toRenderGraph((await planOf(MAP)).plan);
    const toFetch = g.edges.find((e) => e.to.node === "fetch@5:2")!;
    expect(toFetch).toMatchObject({ from: { node: "map@4:14", port: "out" }, path: [{ car: true }] });
    expect(toFetch.label).toBeUndefined();
    expect(g.edges.find((e) => e.id === "map@4:14:in:s->ask@4:31:in:arg0")?.path).toBeUndefined();
    const fields = toRenderGraph(
      (await planOf(`(let ((d (ask "x"))) (fetch (:url d)) (fetch (list-ref d 2)) (fetch (@ d :a)))`)).plan,
    );
    expect(fields.edges.filter((e) => e.path).map((e) => e.path)).toEqual([
      [{ field: "url" }],
      [{ index: 2 }],
      [{ field: "a" }],
    ]);
  });

  it("a compute wire is ONE block in the consumer's frame; fan-in is one block, not N labelled lines", async () => {
    const { plan } = await planOf(CORPUS.fanIn!);
    const g = toRenderGraph(plan);
    wellFormed(g);
    const [t, ...more] = transforms(g);
    expect(more).toEqual([]);
    expect(t).toMatchObject({
      parent: "<program>",
      op: "string-append",
      text: "(string-append (ask …) (fetch …))",
      state: "potential",
      hasValue: false,
    });
    expect(t!.ports.map((p) => p.id)).toEqual(["in:0", "in:1", "out"]);
    expect(edgeIds(g, "data")).toEqual([
      `ask@3:15:out->${t!.id}:in:0`,
      `fetch@3:25:out->${t!.id}:in:1`,
      `${t!.id}:out-><program>:out`,
    ]);
  });

  it("a block into a step operand reads as the operand's source, sits in the step's frame, carries its value", async () => {
    const body = `(map (lambda (i) (ask (string-append "n" (fetch i)))) (list "a" "b" "c"))`;
    const t = (g: RenderGraph) => transforms(g)[0]!;
    expect(t(toRenderGraph((await planOf(body)).plan))).toMatchObject({
      parent: "map@3:0",
      text: `(string-append "n" (fetch i))`,
    });
    const { plan, p, g } = await completed(body);
    expect(t(g)).toMatchObject({ state: "resolved", hasValue: true });
    expect(text(t(g).value)).toBe("nf:c!");
    expect(text(t(toRenderGraph(plan, p, { selection: new Map([["map@3:0", 0]]) })).value)).toBe("nf:a!");
    // The edge out of the block carries its state.
    expect(g.edges.find((e) => e.from.node === t(g).id)?.state).toBe("resolved");
  });

  it("a computation over params only is a line: its expression shown unless a step operand prints it", async () => {
    const operand = toRenderGraph((await planOf(`(map (lambda (i) (ask (string-append "n" i))) (list "a"))`)).plan);
    expect(transforms(operand)).toEqual([]);
    expect(operand.edges.find((e) => e.to.node === "ask@3:17")).toMatchObject({
      from: { node: "map@3:0", port: "in:i" },
    });
    expect(operand.edges.find((e) => e.to.node === "ask@3:17")?.expr).toBeUndefined();
    const rec = toRenderGraph((await planOf(RECURSION)).plan);
    expect(rec.edges.find((e) => e.to.node === "deep@4:0▸deep@3:68" && e.kind === "data")).toMatchObject({
      from: { node: "deep@4:0", port: "in:n" },
      expr: "(- n 1)",
    });
    // A loop counter: the loop's own update, a recur from its param back into it.
    const loop = toRenderGraph((await planOf(NESTED)).plan);
    expect(transforms(loop).map((t) => t.op)).toEqual([]);
    expect(loop.edges.find((e) => e.id === "let@3:17:in:i->let@3:17:in:i")).toMatchObject({
      kind: "recur",
      expr: "(+ i 1)",
    });
  });

  it("a conditional drawn as a branch area is cut: each arm's value is its own wire inside the arm", async () => {
    const g = toRenderGraph((await planOf(RECURSION)).plan);
    const lines = g.edges
      .filter((e) => e.kind === "data")
      .map((e) => `${e.from.node}:${e.from.port}->${e.to.node}:${e.to.port}`);
    const [block, ...more] = transforms(g);
    expect(more).toEqual([]);
    expect(block).toMatchObject({
      parent: "deep@4:0▸if@3:17#1",
      op: "string-append",
      text: "(string-append (ask …) (deep …))",
    });
    expect(lines).toEqual(
      expect.arrayContaining([
        "deep@4:0▸fetch@3:29:out->deep@4:0▸if@3:17:out",
        `deep@4:0▸ask@3:58:out->${block!.id}:in:0`,
        `deep@4:0▸deep@3:68:out->${block!.id}:in:1`,
        `${block!.id}:out->deep@4:0▸if@3:17:out`,
        "deep@4:0▸if@3:17:out->deep@4:0:out",
      ]),
    );
    // The branch's test reads `n`: not part of the value — no line from the param to the result.
    expect(lines).not.toContain("deep@4:0:in:n->deep@4:0:out");
    // The stub is the function's plain name.
    expect(frame(g, "deep@4:0▸deep@3:68").label).toBe("deep");
    // Around a cut conditional, the rest stays a wire reading the branch's result.
    const around = toRenderGraph((await planOf(`(string-append "<" (if (pred) (ask "a") (fetch "b")) ">")`)).plan);
    expect(transforms(around).map((t) => t.text)).toEqual([`(string-append "<" (if …) ">")`]);
    expect(edgeIds(around)).toEqual(
      expect.arrayContaining(["ask@3:30:out->if@3:19:out", "fetch@3:40:out->if@3:19:out"]),
    );
    // A choice with no area (no step inside it) stays in its block.
    const choice = toRenderGraph(
      (await planOf(`(let ((n (ask "k"))) (string-append (if (> (string-length n) 2) "long" "short") "!"))`)).plan,
    );
    expect(transforms(choice).map((t) => t.op)).toEqual(["string-append"]);
  });

  it("retained spans keep a block's value after the run settles (into a frame port, into a branch's out)", async () => {
    const settled = async (body: string, retain: boolean) => {
      const { src, plan } = await planOf(body);
      const capture = createExecutionCapture(SYMBOLS);
      if (retain) capture.retainSpans(retainedSpans(plan));
      await run(src, capture);
      return transforms(toRenderGraph(plan, new ProgressProjector(plan, capture).update("resolved")))[0]!;
    };
    const list = await settled(MAP, true);
    expect(list).toMatchObject({ op: "list", state: "resolved", hasValue: true });
    expect(listItemsOf(list.value)).toEqual(["plan!", "b", "c"]);
    // Without retention the trace pruned it.
    expect((await settled(MAP, false)).hasValue).toBe(false);
    const arm = await settled(RECURSION, true);
    expect(arm).toMatchObject({ op: "string-append", hasValue: true });
    expect(text(arm.value)).toBe("x!x!f:end!");
  });

  it("any control form drawn as an area is cut to its out: guard and and/or, no block", async () => {
    const guard = toRenderGraph(
      (await planOf(`(guard (e (#t (fetch "recovered"))) (ask "first") (string-append (ask "last") "!"))`)).plan,
    );
    expect(edgeIds(guard, "data")).toEqual(
      expect.arrayContaining([
        "guard@3:0:out-><program>:out",
        "fetch@3:14:out->guard@3:0/raise:out",
        "guard@3:0/raise:out->guard@3:0:out",
      ]),
    );
    // Only the body's value is a block — inside the guard; no `guard` block around it all.
    expect(transforms(guard).map((t) => `${t.op} in ${t.parent}`)).toEqual(["string-append in guard@3:0"]);
    const and = toRenderGraph((await planOf(`(and (ask "a") (fetch "b"))`)).plan);
    expect(transforms(and)).toEqual([]);
    expect(edgeIds(and, "data").toSorted()).toEqual([
      "and@3:0:out-><program>:out",
      "ask@3:5:out->and@3:0:out",
      "fetch@3:15:out->and@3:0:out",
    ]);
  });

  it("a block into a frame port reads the frame's operand while the trace holds it", async () => {
    const { plan, gate, r, p } = await held(`(map (lambda (s) (ask s)) (list (fetch "p") "b"))`);
    await until(() => gate.held.some((h) => h.arg === "f:p"));
    gate.release("f:p");
    await until(() => gate.held.length === 2);
    const t = transforms(toRenderGraph(plan, p.update()))[0]!;
    expect(t).toMatchObject({ parent: "<program>", state: "resolved", hasValue: true });
    expect(text((t.value as { car: unknown }).car)).toBe("f:p!");
    gate.releaseAll();
    await r.done;
  });
});

describe("toRenderGraph — actual, completed run", () => {
  it.each(Object.keys(CORPUS))("corpus %s: well-formed, conserved, settled", async (name) => {
    const { g } = await completed(CORPUS[name]!);
    wellFormed(g);
    expect(g.diagnostics).toMatchObject({ unplacedInvocations: 0, droppedEdges: 0 });
    for (const n of g.nodes) expect(["resolved", "rejected", "skipped"], `${n.id}: ${n.state}`).toContain(n.state);
  });

  it.each(Object.keys(CORPUS))("corpus %s: the potential structure under every reachable selection", async (name) => {
    const { plan, p } = await completed(CORPUS[name]!);
    const potential = structureOf(toRenderGraph(plan));
    for (const g of reachable(plan, p)) expect(structureOf(g)).toBe(potential);
  });

  it("map: the template once, painted from the last track; a pick repaints it, clamped", async () => {
    const { plan, p, g } = await completed(MAP);
    const par = frame(g, "map@4:14");
    expect(par.progress).toEqual({ resolved: 3, running: 0, rejected: 0, pending: 0, total: 3 });
    expect(par.instances).toEqual([0, 1, 2].map((ordinal) => ({ ordinal, state: "resolved" })));
    expect(par).toMatchObject({ selected: 2 });
    expect(par.pinned).toBeUndefined();
    expect(childrenOf(g, par.id).map((n) => n.id)).toEqual(["ask@4:31"]);
    const ask = step(g, "ask@4:31");
    expect(ask).toMatchObject({ state: "resolved", instance: { ordinals: [2] } });
    expect(text(ask.input[0]!.value)).toBe("c");
    expect(edgeIds(g).filter((e) => e.includes("ask@4:31:in:arg0"))).toEqual(["map@4:14:in:s->ask@4:31:in:arg0"]);
    expect(text(step(g, "fetch@5:2").output.value)).toBe("f:plan!!!");

    const picked = toRenderGraph(plan, p, { selection: new Map([["map@4:14", 1]]) });
    expect(frame(picked, "map@4:14")).toMatchObject({ selected: 1, pinned: true });
    expect(text(step(picked, "ask@4:31").input[0]!.value)).toBe("b");
    expect(step(picked, "ask@4:31").instance.ordinals).toEqual([1]);
    const clamped = toRenderGraph(plan, p, { selection: new Map([["map@4:14", 9]]) });
    expect(frame(clamped, "map@4:14").selected).toBe(2);
  });

  it("named let: one template, the latest iteration painted, recur edges into the param ports", async () => {
    const { plan, p, g } = await completed(LOOP);
    const loop = frame(g, "let@3:0");
    expect(strip(loop)).toEqual(["resolved", "resolved", "resolved", "resolved"]);
    expect(loop.selected).toBe(3);
    expect(childrenOf(g, loop.id).map((n) => n.id)).toEqual(["if@4:2"]);
    expect(edgeIds(g, "recur")).toEqual(["let@3:0:in:i->let@3:0:in:i", "ask@4:28:out->let@3:0:in:d"]);
    expect(edgeIds(g)).toEqual(expect.arrayContaining(["fetch@4:37:out->if@4:2:out", "if@4:2:out->let@3:0:out"]));
    expect(edgeIds(g)).toContain("let@3:0:in:d->ask@4:28:in:arg0");
    // Iteration 3 left the loop: `then` untaken — a skipped lane, its contents with it.
    expect(frame(g, "if@4:2#0")).toMatchObject({ state: "skipped", skippedBecause: "not-taken" });
    expect(frame(g, "if@4:2#0").collapsed).toBeUndefined();
    expect(step(g, "ask@4:28")).toMatchObject({ state: "skipped", skippedBecause: "not-taken" });
    expect(step(g, "fetch@4:37").state).toBe("resolved");
    const first = toRenderGraph(plan, p, { selection: new Map([["let@3:0", 0]]) });
    expect(step(first, "ask@4:28").state).toBe("resolved");
    expect(text(step(first, "ask@4:28").input[0]!.value)).toBe("x");
    expect(step(first, "fetch@4:37")).toMatchObject({ state: "skipped", skippedBecause: "not-taken" });
  });

  it("branch: arms are always lanes — taken arm painted, the other skipped (not collapsed)", async () => {
    const { g } = await completed(BRANCH);
    const arms = frames(g, "arm");
    expect(arms.map((a) => `${a.label}:${a.state}:${a.collapsed ?? false}`)).toEqual([
      "then:resolved:false",
      "else:skipped:false",
    ]);
    expect(childrenOf(g, arms[1]!.id).map((n) => `${n.id}:${n.state}:${(n as RenderStep).skippedBecause}`)).toEqual([
      "ask@4:28:skipped:not-taken",
    ]);
  });

  it("non-tail recursion: the call frame is a z-axis of depths; the stub is the next depth, collapsed", async () => {
    const { plan, p, g } = await completed(RECURSION);
    const owner = frame(g, "deep@4:0");
    expect(strip(owner)).toEqual(["resolved", "resolved", "resolved"]);
    // Settled: the outermost level.
    expect(owner.selected).toBe(0);
    expect(step(g, "deep@4:0▸ask@3:58").state).toBe("resolved");
    expect(frame(g, "deep@4:0▸deep@3:68")).toMatchObject({ state: "resolved", collapsed: true });
    expect(step(g, "deep@4:0▸fetch@3:29").state).toBe("skipped");
    const bottom = toRenderGraph(plan, p, { selection: new Map([["deep@4:0", 2]]) });
    expect(frame(bottom, "deep@4:0")).toMatchObject({ selected: 2, pinned: true });
    expect(step(bottom, "deep@4:0▸fetch@3:29").state).toBe("resolved");
    expect(step(bottom, "deep@4:0▸ask@3:58").state).toBe("skipped");
    // The deepest level re-enters nothing: its stub never ran.
    expect(frame(bottom, "deep@4:0▸deep@3:68").state).toBe("skipped");
    expect(edgeIds(bottom)).toEqual(edgeIds(g));
  });

  it("recursion through a fan: the next depth through the painted track, each depth its own picker", async () => {
    const { plan, p, g } = await completed(WALK);
    const owner = frame(g, "walk@4:0");
    const par = "walk@4:0▸map@3:31";
    // Follow: depth 0, whose fan follows its last track — `("b" "c")`, a further level.
    expect(strip(owner)).toHaveLength(3);
    expect(frame(g, par).selectionKey).toBeUndefined();
    const askOf = (selection: [string, number][]) => {
      const gs = toRenderGraph(plan, p, { selection: new Map(selection) });
      const ask = step(gs, "walk@4:0▸ask@3:44");
      return ask.state === "resolved" ? text(ask.input[0]!.value) : ask.state;
    };
    expect(askOf([["walk@4:0", 2]])).toBe("c");
    // At depth 1 the fan is another picker: `walk@4:0▸map@3:31↓1`.
    const d1 = toRenderGraph(plan, p, { selection: new Map([["walk@4:0", 1]]) });
    expect(frame(d1, par).selectionKey).toBe(`${par}↓1`);
    expect(
      askOf([
        ["walk@4:0", 2],
        [`${par}↓1`, 0],
      ]),
    ).toBe("b");
    // Depth 0's own pick leads elsewhere: track 0 is the leaf "a", one level down.
    expect(
      askOf([
        [par, 0],
        ["walk@4:0", 1],
      ]),
    ).toBe("a");
  });

  it("do: the exit test is not an extra iteration", async () => {
    const { g } = await completed(CORPUS.doLoop!);
    expect(frames(g, "loop")[0]!.instances).toHaveLength(2);
  });

  it("(map ask xs): the bare callback step carries the par's state", async () => {
    const { g } = await completed(CORPUS.mapBare!);
    const s = g.nodes.find((n) => n.kind === "step")!;
    expect(s.state).toBe("resolved");
  });
});

describe("toRenderGraph — nested selection composes", () => {
  it("an inner frame is painted from the SELECTED outer instance, its pick clamped to that instance", async () => {
    const { plan, p, g } = await completed(NESTED);
    const sel = (...kv: [string, number][]) => toRenderGraph(plan, p, { selection: new Map(kv) });
    const askIn = (gs: RenderGraph) => text(step(gs, "ask@3:69").input[0]!.value);
    // Follow: the last track (c), its latest iteration (the exit) — ask is not taken there.
    expect(frame(g, "map@3:0").selected).toBe(2);
    expect(frame(g, "let@3:17").selected).toBe(2);
    expect(step(g, "ask@3:69").state).toBe("skipped");
    expect(askIn(sel(["map@3:0", 1], ["let@3:17", 0]))).toBe("b");
    expect(askIn(sel(["map@3:0", 0], ["let@3:17", 1]))).toBe("a!");
    expect(askIn(sel(["map@3:0", 2], ["let@3:17", 1]))).toBe("c!");
    // The inner strip is the selected track's own.
    const inner = frame(sel(["map@3:0", 1]), "let@3:17");
    expect(inner.instance?.ordinals).toEqual([1]);
    expect(step(sel(["map@3:0", 1], ["let@3:17", 0]), "ask@3:69").instance.ordinals).toEqual([1, 0]);
    // Past the inner instances: clamped to the last.
    expect(frame(sel(["map@3:0", 0], ["let@3:17", 7]), "let@3:17").selected).toBe(2);
  });
});

describe("toRenderGraph — mid-run", () => {
  it("pending ghosts ahead, the operand phase reads pending, running only once called", async () => {
    const { plan, gate, r, p } = await held(`(fetch (ask "a"))\n(ask "b")`);
    await until(() => gate.held.length === 1);
    const g = toRenderGraph(plan, p.update());
    wellFormed(g);
    // `fetch` entered first, but its operand `ask` is the one running.
    expect(step(g, "fetch@3:0").state).toBe("pending");
    expect(step(g, "ask@3:7").state).toBe("running");
    expect(step(g, "ask@4:0").state).toBe("pending");
    expect(step(g, "ask@4:0").instance.invocationId).toBeUndefined();
    expect(frame(g, "<program>").state).toBe("running");
    gate.release();
    await until(() => gate.held.length === 1);
    const g2 = toRenderGraph(plan, p.update());
    expect(step(g2, "ask@3:7").state).toBe("resolved");
    expect(step(g2, "fetch@3:0").state).toBe("running");
    gate.releaseAll();
    await r.done;
    expect(toRenderGraph(plan, p.update("resolved")).nodes.every((n) => n.state === "resolved")).toBe(true);
  });

  it("follow live: the first running track; a pinned pick stays put while the run moves", async () => {
    const { plan, gate, r, p } = await held(`(map (lambda (s) (ask s)) (list "a" "b" "c" "d" "e" "f" "g" "h"))`);
    await until(() => gate.held.length === 8);
    const par = (g: RenderGraph) => frames(g, "par")[0]!;
    const resolved = () => par(toRenderGraph(plan, p.update())).progress!.resolved;
    for (const a of ["c", "f"]) gate.release(a);
    await until(() => resolved() === 2);
    const g1 = toRenderGraph(plan, p.update());
    wellFormed(g1);
    expect(par(g1).progress).toEqual({ resolved: 2, running: 6, rejected: 0, pending: 0, total: 8 });
    expect(strip(par(g1))).toEqual([
      "running",
      "running",
      "resolved",
      "running",
      "running",
      "resolved",
      "running",
      "running",
    ]);
    expect(par(g1).selected).toBe(0);
    const pinned = new Map([[par(g1).id, 2]]);
    gate.release("a");
    await until(() => resolved() === 3);
    const g2 = toRenderGraph(plan, p.update());
    expect(par(g2).selected).toBe(1);
    expect(step(g2, "ask@3:17").state).toBe("running");
    const g3 = toRenderGraph(plan, p, { selection: pinned });
    expect(par(g3)).toMatchObject({ selected: 2, pinned: true });
    expect(step(g3, "ask@3:17").state).toBe("resolved");
    gate.releaseAll();
    await r.done;
    // Settled: the last resolved.
    expect(par(toRenderGraph(plan, p.update("resolved"))).selected).toBe(7);
  });

  it("STATIC LAYOUT: across every tick of a live run and every selection, the structure is the plan's", async () => {
    const { plan, gate, r, p } = await held(NESTED);
    const potential = structureOf(toRenderGraph(plan));
    let samples = 0;
    let graphs = 0;
    const check = () => {
      samples++;
      for (const g of reachable(plan, p.update(), 60)) {
        graphs++;
        wellFormed(g);
        expect(structureOf(g)).toBe(potential);
      }
    };
    check();
    while (!(await Promise.race([r.done.then(() => true), new Promise((res) => setTimeout(() => res(false), 5))]))) {
      if (gate.held.length === 0) continue;
      check();
      // Out of order: the last held first.
      gate.release(gate.held.at(-1)!.arg);
      check();
    }
    p.update("resolved");
    check();
    expect(samples).toBeGreaterThan(10);
    expect(graphs).toBeGreaterThan(samples);
  });

  it("settle('cancelled'): what still runs reads cancelled", async () => {
    const { plan, gate, r, p } = await held(`(ask "a")\n(fetch "b")`);
    await until(() => gate.held.length === 1);
    const g = toRenderGraph(plan, p.settle("cancelled").update());
    expect(step(g, "ask@3:0").state).toBe("cancelled");
    expect(step(g, "fetch@4:0").state).toBe("skipped");
    gate.releaseAll();
    await r.done;
  });
});

describe("followed", () => {
  it("loop → latest; fan → running, pending, rejected, cancelled, else last resolved; depth → deepest live", () => {
    expect(followed("loop", ["resolved", "running"])).toBe(1);
    expect(followed("fan", ["resolved", "rejected", "running", "running"])).toBe(2);
    expect(followed("fan", ["resolved", "pending", "rejected"])).toBe(1);
    expect(followed("fan", ["resolved", "cancelled", "rejected"])).toBe(2);
    expect(followed("fan", ["resolved", "cancelled", "resolved"])).toBe(1);
    expect(followed("fan", ["resolved", "resolved"])).toBe(1);
    expect(followed("depth", ["running", "running", "resolved"])).toBe(1);
    expect(followed("depth", ["resolved", "resolved"])).toBe(0);
    expect(followed("fan", [])).toBeUndefined();
  });
});

describe("toRenderGraph — audit pass 3 regressions", () => {
  it("a key instantiated twice in one body paints its latest instance; the structure never moves", async () => {
    const { plan, gate, r, p } = await held(
      '(define-macro (twice e) `(begin ,e ,e))\n(twice (map (lambda (s) (ask s)) (list "a" "b")))',
    );
    const potential = structureOf(toRenderGraph(plan));
    const graphs: RenderGraph[] = [];
    for (let released = 0; released < 4; released++) {
      await until(() => gate.held.length > 0);
      graphs.push(toRenderGraph(plan, p.update()));
      gate.release();
    }
    await r.done;
    graphs.push(toRenderGraph(plan, p.update("resolved")));
    for (const g of graphs) {
      wellFormed(g);
      expect(structureOf(g)).toBe(potential);
    }
    const g = graphs.at(-1)!;
    expect(g.nodes.filter((n) => n.kind === "step")).toHaveLength(1);
    expect(frames(g, "par")[0]!.instances).toHaveLength(2);
  });

  it("a long-lived trace without `since`: the latest run is painted, the structure unchanged", async () => {
    const body = `(map (lambda (s) (ask s)) (list "a" "b"))`;
    const { src, plan } = await planOf(body);
    const capture = createExecutionCapture(SYMBOLS);
    const p = new ProgressProjector(plan, capture);
    await run(src, capture);
    const g1 = toRenderGraph(plan, p.update());
    await run(src, capture);
    const g2 = toRenderGraph(plan, p.update("resolved"));
    wellFormed(g1);
    wellFormed(g2);
    expect(structureOf(g2)).toBe(structureOf(g1));
    const ask = (g: RenderGraph) => g.nodes.find((n) => n.kind === "step")!.instance!.invocationId!;
    expect(ask(g2)).toBeGreaterThan(ask(g1));
  });

  it("a tested-but-untaken arm is skipped, its test keeps its state; only the taken arm ran", async () => {
    const { g } = await completed(`(cond ((equal? (ask "n") "x") (fetch "one"))
      ((equal? (ask "m") "y") (fetch "two"))
      (else (fetch "three")))`);
    wellFormed(g);
    expect(frames(g, "arm").map((a) => a.state)).toEqual(["skipped", "skipped", "resolved"]);
    const tests = g.nodes.filter((n) => n.kind === "step" && n.symbol === "ask");
    expect(tests.map((t) => t.state)).toEqual(["resolved", "resolved"]);
  });

  it("(map io xs) over a bare designated callback: counts from the output's length, never 0 / 0", async () => {
    const { g } = await completed(`(map io (list "a" "b" "c"))`, ["io"]);
    const par = frames(g, "par")[0]!;
    expect(par.progress).toEqual({ resolved: 3, running: 0, rejected: 0, pending: 0, total: 3 });
    expect(par.instances).toEqual([]);
    expect(g.nodes.find((n) => n.kind === "step")!.state).toBe("resolved");
  });

  it("(map io (list)): no counts, the hosted step skipped", async () => {
    const { g } = await completed(`(map io (list))`, ["io"]);
    const par = frames(g, "par")[0]!;
    expect(par.state).toBe("resolved");
    expect(par.progress).toBeUndefined();
    expect(g.nodes.find((n) => n.kind === "step")!.state).toBe("skipped");
  });

  it("a long loop: every iteration in the strip, the template painted from the picked one", async () => {
    const { plan, p, g } = await completed(`(let loop ((i 0) (acc "")) (if (< i 9) (loop (+ i 1) (ask acc)) acc))`);
    wellFormed(g);
    const loop = frames(g, "loop")[0]!;
    expect(loop.instances).toHaveLength(10);
    expect(loop.selected).toBe(9);
    const third = toRenderGraph(plan, p, { selection: new Map([[loop.id, 2]]) });
    expect(text(third.nodes.find((n): n is RenderStep => n.kind === "step")!.input[0]!.value)).toBe("!!");
  });

  it("cancelled tracks count apart from rejected", async () => {
    const { plan, gate, r, p } = await held(`(map (lambda (s) (ask s)) (list "a" "b" "c"))`);
    await until(() => gate.held.length === 3);
    gate.release("a");
    await until(() => frames(toRenderGraph(plan, p.update()), "par")[0]!.progress?.resolved === 1);
    const g = toRenderGraph(plan, p.settle("cancelled").update());
    const par = frames(g, "par")[0]!;
    expect(par.progress).toEqual({ resolved: 1, running: 0, rejected: 0, pending: 0, cancelled: 2, total: 3 });
    expect(strip(par)).toEqual(["resolved", "cancelled", "cancelled"]);
    expect(par.selected).toBe(1);
    gate.releaseAll();
    await r.done;
  });

  it("the plan's dataflow status reaches the graph", async () => {
    // No program makes arrival's wireframe throw any more; the status is the plan's, whatever set it.
    const { plan } = await planOf(`(define plan (ask "p"))\n(ask plan)`);
    const unavailable = { status: "unavailable", reason: "WireLocalityError: x", missing: 0 } as const;
    expect(toRenderGraph({ ...plan, dataflow: unavailable }).diagnostics.dataflow).toEqual(unavailable);
    const { plan: ok } = await planOf(`(fetch (ask "a"))`);
    expect(toRenderGraph(ok).diagnostics.dataflow).toEqual({ status: "complete", missing: 0 });
  });
});
