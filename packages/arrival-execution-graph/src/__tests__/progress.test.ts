import { disposeRunContext, execState, LexicalScope, parse } from "@here.build/arrival";
import { EvalTrace } from "@here.build/arrival-provenance";
import { reaction } from "mobx";
import { beforeAll, describe, expect, it } from "vitest";

import { buildPlan } from "../build-plan.js";
import { createExecutionCapture } from "../capture.js";
import type { Plan, Vocabulary } from "../plan.js";
import { type Body, type FrameInstance, type Instance, ProgressProjector, type StepInstance } from "../progress.js";
import { branch, frame, Gate, ioCapability, planOf, run, start, step, text, until } from "./program-harness.js";

const FETCH = `(define (fetch-page u) (io u))`;
const SUMMARIZE = `(define (summarize t) (io (string-append "s:" t)))`;

const only = (body: Body, key: string): Instance => {
  const list = body.byKey.get(key) ?? [];
  expect(list.length, `${key} instances`).toBe(1);
  return list[0]!;
};
const frameAt = (body: Body, key: string) => only(body, key) as FrameInstance;
const stepAt = (body: Body, key: string) => only(body, key) as StepInstance;
const rootBody = (p: ProgressProjector) => p.root.bodies[0]!;

async function project(src: string, plan: Plan, symbols: string[], opts: { plain?: boolean } = {}) {
  const trace = opts.plain ? new EvalTrace() : createExecutionCapture(symbols);
  const { error } = await run(src, trace);
  const p = new ProgressProjector(plan, trace, { symbols }).update(error ? "rejected" : "resolved");
  return { p, trace, error };
}

const conserved = (p: ProgressProjector) => {
  expect(p.counters.unplacedInvocations, p.notes.join("\n")).toBe(0);
  expect(p.counters.pendingAttribution).toBe(0);
};

describe("ProgressProjector — top-level seq", () => {
  const src = `${FETCH}
${SUMMARIZE}
(define page (fetch-page "a"))
(summarize (fetch-page page))`;
  const plan = planOf([
    step("fetch-page@3:13", "fetch-page"),
    step("fetch-page@4:11", "fetch-page"),
    step("summarize@4:0", "summarize"),
  ]);

  it("places every step, in order, resolved, with captured values", async () => {
    const { p } = await project(src, plan, ["fetch-page", "summarize"]);
    conserved(p);
    const body = rootBody(p);
    // Enter order: a call is entered before its operands (F20).
    expect(body.items.map((i) => i.key)).toEqual(["fetch-page@3:13", "summarize@4:0", "fetch-page@4:11"]);
    for (const i of body.items) expect(p.stateOf(i)).toBe("resolved");
    expect(p.stateOf(p.root)).toBe("resolved");
    expect(text(p.valuesOf(stepAt(body, "fetch-page@3:13")).output)).toBe("a!");
    expect(text(p.valuesOf(stepAt(body, "summarize@4:0")).inputs[0]!.value)).toBe("a!!");
  });

  it("works over a plain EvalTrace — values only where the trace kept them", async () => {
    const { p } = await project(src, plan, ["fetch-page", "summarize"], { plain: true });
    conserved(p);
    const body = rootBody(p);
    expect(body.items).toHaveLength(3);
    // Pruned when `define` exited.
    expect(p.valuesOf(stepAt(body, "fetch-page@3:13")).hasOutput).toBe(false);
    // Top-level: nothing prunes it. Its Pair operand was pruned at its own exit.
    const top = p.valuesOf(stepAt(body, "summarize@4:0"));
    expect(text(top.output)).toBe("s:a!!!");
    expect(top.inputs[0]!.hasValue).toBe(false);
    // Symbol operands survive (the symbol log is not pruned).
    expect(text(p.valuesOf(stepAt(body, "fetch-page@4:11")).inputs[0]!.value)).toBe("a!");
  });

  it("attaches designated invocations the plan lacks as `unplanned`", async () => {
    const partial = planOf([step("fetch-page@3:13", "fetch-page"), step("fetch-page@4:11", "fetch-page")]);
    const { p } = await project(src, partial, ["fetch-page", "summarize"]);
    conserved(p);
    expect(p.counters.unplanned).toBe(1);
    expect(rootBody(p).unplanned.map((s) => s.symbol)).toEqual(["summarize"]);
  });

  it("a step reads `pending` while its operands evaluate (F20), `running` once called", async () => {
    const gate = new Gate();
    gate.hold = true;
    const capture = createExecutionCapture(["fetch-page", "summarize"]);
    const r = start(src, capture, gate);
    const p = new ProgressProjector(plan, capture);
    await until(() => gate.held.length === 1);
    p.update();
    expect(p.stateOf(stepAt(rootBody(p), "fetch-page@3:13"))).toBe("running");
    expect(rootBody(p).byKey.has("summarize@4:0")).toBe(false);
    gate.release();
    await until(() => gate.held.length === 1);
    p.update();
    expect(p.phaseOf(stepAt(rootBody(p), "summarize@4:0"))).toBe("pending");
    expect(p.stateOf(stepAt(rootBody(p), "summarize@4:0"))).toBe("pending");
    expect(p.stateOf(stepAt(rootBody(p), "fetch-page@4:11"))).toBe("running");
    gate.release();
    await until(() => gate.held.length === 1);
    p.update();
    expect(p.stateOf(stepAt(rootBody(p), "summarize@4:0"))).toBe("running");
    gate.releaseAll();
    await r.done;
    p.update("resolved");
    expect(p.stateOf(p.root)).toBe("resolved");
  });
});

describe("ProgressProjector — long-lived trace", () => {
  it("`since` ignores earlier runs that share the spans", async () => {
    const src = `${FETCH}\n(fetch-page "a")`;
    const plan = planOf([step("fetch-page@2:0", "fetch-page")]);
    const capture = createExecutionCapture(["fetch-page"]);
    await run(src, capture);
    const since = capture.invocationLog.length; // ids start at 0 and are gap-free here
    capture.beginRun();
    await run(src, capture);
    const all = new ProgressProjector(plan, capture).update("resolved");
    expect(rootBody(all).byKey.get("fetch-page@2:0")).toHaveLength(2);
    const second = new ProgressProjector(plan, capture, { since }).update("resolved");
    const [only] = rootBody(second).byKey.get("fetch-page@2:0")!;
    expect(only!.invocation!.id).toBeGreaterThanOrEqual(since);
    expect(rootBody(second).items).toHaveLength(1);
  });
});

describe("ProgressProjector — par (map)", () => {
  const src = `${FETCH}
${SUMMARIZE}
(map (lambda (u) (fetch-page u) (summarize u)) (list "a" "b" "c"))`;
  const plan = planOf([
    frame("par", "map@3:0", [step("fetch-page@3:17", "fetch-page"), step("summarize@3:32", "summarize")], {
      params: ["u"],
      bodyRoots: ["fetch-page@3:17", "summarize@3:32"],
      host: "map",
    }),
  ]);

  it("one track per element; a multi-form body joins its track by element identity", async () => {
    const gate = new Gate();
    gate.hold = true;
    const capture = createExecutionCapture(["fetch-page", "summarize"]);
    const r = start(src, capture, gate);
    const p = new ProgressProjector(plan, capture);
    await until(() => gate.held.length === 3);
    p.update();
    const par = frameAt(rootBody(p), "map@3:0");
    expect(par.bodies).toHaveLength(3);
    for (const t of par.bodies) {
      expect(p.stateOf(t)).toBe("running");
      expect(t.byKey.has("summarize@3:32")).toBe(false); // pending for L4
    }
    // Finish out of element order: the second forms enter c, a, b.
    for (const arg of ["c", "a", "b"]) {
      gate.release(arg);
      await until(() => gate.held.some((h) => h.arg === `s:${arg}`));
      p.update();
    }
    gate.releaseAll();
    await r.done;
    p.update("resolved");
    conserved(p);
    expect(par.unattributed).toBeUndefined();
    for (const [k, t] of par.bodies.entries()) {
      const el = ["a", "b", "c"][k]!;
      expect(text(p.valuesOf(stepAt(t, "fetch-page@3:17")).inputs[0]!.value)).toBe(el);
      expect(text(p.valuesOf(stepAt(t, "summarize@3:32")).inputs[0]!.value)).toBe(el);
      expect(p.stateOf(t)).toBe("resolved");
    }
    // Enter order of the second form really was c, a, b.
    const order = par.bodies.map((t) => stepAt(t, "summarize@3:32").invocation.id);
    expect(order[2]).toBeLessThan(order[0]!);
    expect(order[0]).toBeLessThan(order[1]!);
  });

  it("a later form that never reads the param is `unattributed`", async () => {
    const constSrc = `${FETCH}
${SUMMARIZE}
(map (lambda (u) (fetch-page u) (summarize "k")) (list "a" "b"))`;
    const constPlan = planOf([
      frame("par", "map@3:0", [step("fetch-page@3:17", "fetch-page"), step("summarize@3:32", "summarize")], {
        params: ["u"],
        bodyRoots: ["fetch-page@3:17", "summarize@3:32"],
      }),
    ]);
    const { p } = await project(constSrc, constPlan, ["fetch-page", "summarize"]);
    conserved(p);
    const par = frameAt(rootBody(p), "map@3:0");
    expect(par.bodies).toHaveLength(2);
    expect(par.unattributed!.byKey.get("summarize@3:32")).toHaveLength(2);
    expect(p.counters.unattributed).toBe(2);
  });

  it("after an abnormal outcome, still-running steps read `cancelled`", async () => {
    const gate = new Gate();
    gate.hold = true;
    const capture = createExecutionCapture(["fetch-page", "summarize"]);
    const r = start(src, capture, gate);
    const p = new ProgressProjector(plan, capture);
    await until(() => gate.held.length === 3);
    p.update("cancelled");
    const par = frameAt(rootBody(p), "map@3:0");
    expect(p.stateOf(stepAt(par.bodies[0]!, "fetch-page@3:17"))).toBe("cancelled");
    expect(p.stateOf(par)).toBe("cancelled");
    expect(p.isSettled(par.bodies[1]!)).toBe(true);
    gate.releaseAll();
    await r.done;
  });
});

describe("ProgressProjector — loops", () => {
  it("named let: iterations flattened, recur operands in iteration k, tail chain resolved", async () => {
    const src = `(define (step-it s) (io s))
(let loop ((i 0) (acc "x")) (if (< i 3) (loop (+ i 1) (step-it acc)) acc))`;
    const plan = planOf([
      frame(
        "loop",
        "let@2:0",
        [branch("if@2:28", [{ roots: ["loop@2:40"], children: [step("step-it@2:54", "step-it")] }, { roots: [] }])],
        {
          params: ["i", "acc"],
          bodyRoots: ["if@2:28"],
          recurSpans: ["loop@2:40"],
          tail: true,
        },
      ),
    ]);
    const gate = new Gate();
    gate.hold = true;
    const capture = createExecutionCapture(["step-it"]);
    const r = start(src, capture, gate);
    const p = new ProgressProjector(plan, capture);
    await until(() => gate.held.length === 1);
    gate.release();
    await until(() => gate.held.length === 1 && gate.calls.length === 2);
    p.update();
    const loop = frameAt(rootBody(p), "let@2:0");
    expect(loop.bodies).toHaveLength(2);
    // The trampoline still holds iteration 0's `if` running; the projection knows it is done.
    const if0 = frameAt(loop.bodies[0]!, "if@2:28");
    expect(if0.invocation!.state).toBe("running");
    expect(p.stateOf(if0)).toBe("resolved");
    expect(p.stateOf(loop.bodies[0]!)).toBe("resolved");
    expect(p.stateOf(loop.bodies[1]!)).toBe("running");
    gate.releaseAll();
    await r.done;
    p.update("resolved");
    conserved(p);

    expect(loop.bodies).toHaveLength(4);
    const accs = loop.bodies.slice(0, 3).map((it) => {
      const b = frameAt(it, "if@2:28");
      expect(b.takenArm).toBe(0);
      const arm = frameAt(b.bodies[0]!, "if@2:28#0").bodies[0]!;
      return text(p.valuesOf(stepAt(arm, "step-it@2:54")).inputs[0]!.value);
    });
    expect(accs).toEqual(["x", "x!", "x!!"]);
    expect(frameAt(loop.bodies[3]!, "if@2:28").takenArm).toBe(1);
    expect(loop.bodies.slice(1).every((b) => b.tail === true)).toBe(true);
    expect(loop.bodies[0]!.next).toBe(loop.bodies[1]!.start);
    for (const b of loop.bodies) expect(p.stateOf(b)).toBe("resolved");
  });

  it("non-tail loop: iteration k is not settled when k+1 starts (it completes after)", async () => {
    const src = `(define (step-it s) (io s))
(let loop ((i 0)) (if (< i 2) (string-append (step-it "x") (loop (+ i 1)) (step-it "after")) ""))`;
    const plan = planOf([
      frame(
        "loop",
        "let@2:0",
        [
          branch("if@2:18", [
            {
              roots: ["string-append@2:30"],
              children: [step("step-it@2:45", "step-it"), step("step-it@2:74", "step-it")],
            },
            { roots: [] },
          ]),
        ],
        { params: ["i"], bodyRoots: ["if@2:18"], recurSpans: ["loop@2:59"], tail: false },
      ),
    ]);
    const gate = new Gate();
    gate.hold = true;
    const capture = createExecutionCapture(["step-it"]);
    const r = start(src, capture, gate);
    const p = new ProgressProjector(plan, capture);
    await until(() => gate.held.length === 1);
    gate.release();
    await until(() => gate.held.length === 1 && gate.calls.length === 2);
    p.update();
    const loop = frameAt(rootBody(p), "let@2:0");
    expect(loop.bodies).toHaveLength(2);
    expect(loop.bodies[1]!.tail).toBe(false);
    expect(p.isSettled(loop.bodies[0]!)).toBe(false); // its "after" step is still to come
    expect(p.stateOf(loop.bodies[0]!)).toBe("running");
    gate.releaseAll();
    await r.done;
    p.update("resolved");
    conserved(p);
    const after = (k: number) =>
      frameAt(frameAt(loop.bodies[k]!, "if@2:18").bodies[0]!, "if@2:18#0").bodies[0]!.byKey.get("step-it@2:74");
    expect(after(0)).toHaveLength(1);
    expect(after(1)).toHaveLength(1);
    expect(p.isSettled(loop.bodies[0]!)).toBe(true);
  });

  it("do: one iteration per test; step exprs in their iteration; results after the loop", async () => {
    const src = `(define (step-it s) (io s))
(do ((i 0 (+ i 1)) (acc "x" (step-it acc))) ((= i 2) (step-it acc)) (step-it "body"))`;
    const plan = planOf([
      frame("loop", "do@2:0", [step("step-it@2:68", "step-it"), step("step-it@2:28", "step-it")], {
        params: ["i", "acc"],
        bodyRoots: ["=@2:45", "step-it@2:68", "+@2:10", "step-it@2:28"],
        iterationMarker: "=@2:45",
      }),
      step("step-it@2:53", "step-it"),
    ]);
    const { p } = await project(src, plan, ["step-it"]);
    conserved(p);
    const loop = frameAt(rootBody(p), "do@2:0");
    expect(loop.bodies).toHaveLength(3);
    for (const it of loop.bodies.slice(0, 2)) {
      expect(it.byKey.get("step-it@2:68")).toHaveLength(1);
      expect(it.byKey.get("step-it@2:28")).toHaveLength(1);
    }
    expect(loop.bodies[2]!.items).toHaveLength(0); // the exit test only
    expect(text(p.valuesOf(stepAt(rootBody(p), "step-it@2:53")).output)).toBe("x!!!");
  });
});

describe("ProgressProjector — branches", () => {
  const src = `(define (good? t) (> (string-length t) 1))
${FETCH}
(if (good? "abc") (fetch-page "yes") (fetch-page "no"))
(if (good? "a") (fetch-page "yes") "literal")
(when (good? "a") (fetch-page "w"))
(cond ((good? "a") (fetch-page "c1")) ((good? "bb") (fetch-page "c2")) (else (fetch-page "c3")))`;
  const cond = frame(
    "branch",
    "cond@6:0",
    [
      frame("arm", "cond@6:0#0", [step("fetch-page@6:19", "fetch-page")], { bodyRoots: ["fetch-page@6:19"] }),
      frame("arm", "cond@6:0#1", [step("good?@6:39", "good?"), step("fetch-page@6:52", "fetch-page")], {
        bodyRoots: ["fetch-page@6:52"],
      }),
      frame("arm", "cond@6:0#2", [step("fetch-page@6:77", "fetch-page")], { bodyRoots: ["fetch-page@6:77"] }),
    ],
    {
      bodyRoots: ["good?@6:39", "fetch-page@6:19", "fetch-page@6:52", "fetch-page@6:77"],
      armTests: ["good?@6:7", "good?@6:39", undefined],
    },
  );
  const plan = planOf([
    step("good?@3:4", "good?"),
    branch("if@3:0", [
      { roots: ["fetch-page@3:18"], children: [step("fetch-page@3:18", "fetch-page")] },
      { roots: ["fetch-page@3:37"], children: [step("fetch-page@3:37", "fetch-page")] },
    ]),
    step("good?@4:4", "good?"),
    branch("if@4:0", [
      { roots: ["fetch-page@4:16"], children: [step("fetch-page@4:16", "fetch-page")] },
      { roots: [] },
    ]),
    step("good?@5:6", "good?"),
    branch("when@5:0", [
      { roots: ["fetch-page@5:18"], children: [step("fetch-page@5:18", "fetch-page")] },
      { roots: [] },
    ]),
    step("good?@6:7", "good?"),
    cond,
  ]);

  it("taken arm by its forms, by the atom rule, and through flat cond clauses", async () => {
    const { p } = await project(src, plan, ["good?", "fetch-page"]);
    conserved(p);
    const body = rootBody(p);
    const taken = frameAt(body, "if@3:0");
    expect(taken.takenArm).toBe(0);
    expect(frameAt(taken.bodies[0]!, "if@3:0#0").bodies[0]!.byKey.has("fetch-page@3:18")).toBe(true);
    expect(taken.bodies[0]!.byKey.has("if@3:0#1")).toBe(false); // untaken → skipped by L4
    expect(frameAt(body, "if@4:0").takenArm).toBe(1); // literal arm
    expect(frameAt(body, "when@5:0").takenArm).toBe(1); // implicit empty else
    const c = frameAt(body, "cond@6:0");
    expect(c.takenArm).toBe(1);
    const arm1 = frameAt(c.bodies[0]!, "cond@6:0#1").bodies[0]!;
    expect(arm1.items.map((i) => i.key)).toEqual(["good?@6:39", "fetch-page@6:52"]);
    expect(stepAt(body, "good?@6:7")).toBeDefined(); // clause-0 test is the selector
    for (const k of ["if@3:0", "if@4:0", "when@5:0", "cond@6:0"]) expect(p.stateOf(frameAt(body, k))).toBe("resolved");
  });
});

describe("ProgressProjector — calls and recursion", () => {
  it("call frame: operands outside, body inside under the call path", async () => {
    const src = `${FETCH}
(define (pipeline u) (fetch-page (string-append u "/1")) (fetch-page u))
(pipeline (fetch-page "seed"))`;
    const path = "pipeline@3:0▸";
    const plan = planOf([
      step("fetch-page@3:10", "fetch-page"),
      frame(
        "call",
        "pipeline@3:0",
        [step("fetch-page@2:21", "fetch-page", path), step("fetch-page@2:57", "fetch-page", path)],
        {
          params: ["u"],
          bodyRoots: ["fetch-page@2:21", "fetch-page@2:57"],
        },
      ),
    ]);
    const { p } = await project(src, plan, ["fetch-page"]);
    conserved(p);
    const body = rootBody(p);
    expect(stepAt(body, "fetch-page@3:10")).toBeDefined();
    const call = frameAt(body, "pipeline@3:0");
    expect(call.bodies[0]!.callPath).toBe(path);
    expect(call.bodies[0]!.items.map((i) => i.key)).toEqual([`${path}fetch-page@2:21`, `${path}fetch-page@2:57`]);
    expect(text(p.valuesOf(stepAt(call.bodies[0]!, `${path}fetch-page@2:57`)).inputs[0]!.value)).toBe("seed!");
  });

  it("tail recursion flattens into iterations; non-tail nests call instances by depth", async () => {
    const src = `${FETCH}
(define (walk n acc) (if (= n 0) acc (walk (- n 1) (fetch-page acc))))
(walk 2 "s")
(define (deep n) (if (= n 0) "z" (string-append (fetch-page "x") (deep (- n 1)))))
(deep 2)`;
    const w = "walk@3:0▸";
    const d = "deep@5:0▸";
    const plan = planOf([
      frame(
        "loop",
        "walk@3:0",
        [
          branch(
            "if@2:21",
            [{ roots: [] }, { roots: ["walk@2:37"], children: [step("fetch-page@2:51", "fetch-page", w)] }],
            { path: w },
          ),
        ],
        {
          params: ["n", "acc"],
          bodyRoots: ["if@2:21"],
          recurSpans: ["walk@2:37"],
          tail: true,
        },
      ),
      frame(
        "call",
        "deep@5:0",
        [
          branch(
            "if@4:17",
            [
              { roots: [] },
              {
                roots: ["string-append@4:33"],
                children: [
                  step("fetch-page@4:48", "fetch-page", d),
                  frame("call", "deep@4:65", [], { path: d, params: ["n"], bodyRoots: ["if@4:17"], recursive: true }),
                ],
              },
            ],
            { path: d },
          ),
        ],
        { params: ["n"], bodyRoots: ["if@4:17"] },
      ),
    ]);
    const { p } = await project(src, plan, ["fetch-page"]);
    conserved(p);
    const body = rootBody(p);

    const walk = frameAt(body, "walk@3:0");
    expect(walk.bodies.map((it) => frameAt(it, `${w}if@2:21`).takenArm)).toEqual([1, 1, 0]);

    const depths: number[] = [];
    let call: FrameInstance | undefined = frameAt(body, "deep@5:0");
    while (call) {
      depths.push(call.depth);
      expect(call.template.key).toBe("deep@5:0");
      const br = frameAt(call.bodies[0]!, `${d}if@4:17`);
      if (br.takenArm === 0) break;
      const arm = frameAt(br.bodies[0]!, `${d}if@4:17#1`).bodies[0]!;
      expect(arm.byKey.get(`${d}fetch-page@4:48`)).toHaveLength(1);
      call = frameAt(arm, `${d}deep@4:65`);
    }
    expect(depths).toEqual([0, 1, 2]);
  });
});

describe("ProgressProjector — per-tick consistency", () => {
  it("a step never reads `resolved` without its output, on any revision tick", async () => {
    const src = `(define (ask p) (io p))
(define (fetch u) (io (string-append "f:" u)))
(let* ((plan (ask "plan"))
       (steps (map (lambda (s) (ask s)) (list plan "research" "draft" "edit"))))
  (fetch (car steps)))`;
    const symbols = ["ask", "fetch"];
    const state = await execState("(begin)", {
      scope: LexicalScope.fresh("v"),
      capabilities: [ioCapability(new Gate())],
      config: {},
    });
    const vocabulary = state.runCtx.vocabulary!;
    await disposeRunContext(state.runCtx);
    const plan = buildPlan({ forms: await parse(src), symbols: new Set(symbols), vocabulary });
    const gate = new Gate();
    gate.hold = true;
    const capture = createExecutionCapture(symbols);
    const p = new ProgressProjector(plan, capture);
    const bad: string[] = [];
    let ticks = 0;
    const visit = (i: Instance): void => {
      if (i.kind === "step") {
        if (p.stateOf(i) === "resolved" && !p.valuesOf(i).hasOutput) bad.push(`#${i.invocation.id}`);
        return;
      }
      for (const b of i.bodies) b.items.forEach(visit);
    };
    const dispose = reaction(
      () => capture.revision,
      () => {
        ticks++;
        p.update();
        visit(p.root);
      },
    );
    const r = start(src, capture, gate);
    let settled = false;
    void r.done.then(() => (settled = true));
    while (!settled) {
      await until(() => settled || gate.held.length > 0);
      if (gate.held.length > 0) gate.release(gate.held.at(-1)!.arg); // out of order
    }
    expect(gate.calls).toHaveLength(6);
    dispose();
    expect(ticks).toBe(capture.revision);
    expect(bad).toEqual([]);
  });
});

describe("ProgressProjector — failure", () => {
  it("an aborted run: abort rejections read `cancelled`, a genuine (caught) error stays `rejected`", async () => {
    const src = `${FETCH}
(define (explode u) (fail u))
(guard (e (#t "caught")) (explode "x"))
(map (lambda (u) (fetch-page u)) (list "a" "b"))`;
    const plan = planOf([
      step("explode@3:25", "explode"),
      frame("par", "map@4:0", [step("fetch-page@4:17", "fetch-page")], {
        params: ["u"],
        bodyRoots: ["fetch-page@4:17"],
      }),
    ]);
    const gate = new Gate();
    gate.hold = true;
    const capture = createExecutionCapture(["fetch-page", "explode"]);
    const abort = new AbortController();
    const r = start(src, capture, gate, abort.signal);
    await until(() => gate.held.length === 2);
    abort.abort();
    const { error } = await r.done;
    expect(error).toBeDefined();
    const p = new ProgressProjector(plan, capture, { signal: abort.signal }).update("cancelled");
    const par = frameAt(rootBody(p), "map@4:0");
    for (const t of par.bodies) {
      const s = stepAt(t, "fetch-page@4:17");
      expect(s.invocation.state).toBe("rejected"); // what the trace says
      expect(p.stateOf(s)).toBe("cancelled");
    }
    expect(p.stateOf(par)).toBe("cancelled");
    expect(p.stateOf(stepAt(rootBody(p), "explode@3:25"))).toBe("rejected");
    // The same trace under a `rejected` outcome: rejections are failures.
    const asFailure = new ProgressProjector(plan, capture).update("rejected");
    expect(asFailure.stateOf(stepAt(frameAt(rootBody(asFailure), "map@4:0").bodies[0]!, "fetch-page@4:17"))).toBe(
      "rejected",
    );
  });

  it("a rejected step: error kept, later steps never entered, enclosing instance settled", async () => {
    const src = `${FETCH}
(define (explode u) (fail u))
(fetch-page "a")
(explode "b")
(fetch-page "c")`;
    const plan = planOf([
      step("fetch-page@3:0", "fetch-page"),
      step("explode@4:0", "explode"),
      step("fetch-page@5:0", "fetch-page"),
    ]);
    const { p, error } = await project(src, plan, ["fetch-page", "explode"]);
    expect(error).toBeDefined();
    conserved(p);
    const body = rootBody(p);
    const boom = stepAt(body, "explode@4:0");
    expect(p.stateOf(boom)).toBe("rejected");
    expect(String(p.valuesOf(boom).error)).toMatch(/fail b/);
    expect(body.byKey.has("fetch-page@5:0")).toBe(false);
    expect(p.isSettled(body)).toBe(true);
    expect(p.stateOf(p.root)).toBe("rejected");
  });
});

describe("ProgressProjector × buildPlan (integration)", () => {
  const corpus: Record<string, { src: string; symbols: string[] }> = {
    seq: {
      src: `${FETCH}\n${SUMMARIZE}\n(define page (fetch-page "a"))\n(summarize (fetch-page page))`,
      symbols: ["fetch-page", "summarize"],
    },
    map: {
      src: `${FETCH}\n${SUMMARIZE}\n(map (lambda (u) (fetch-page u) (summarize u)) (list "a" "b" "c"))`,
      symbols: ["fetch-page", "summarize"],
    },
    helperMap: {
      src: `${FETCH}\n(define (both u) (fetch-page u) (fetch-page (string-append u "?")))\n(map both (list "a" "b"))`,
      symbols: ["fetch-page"],
    },
    namedLet: {
      src: `(define (step-it s) (io s))\n(let loop ((i 0) (acc "x")) (if (< i 3) (loop (+ i 1) (step-it acc)) acc))`,
      symbols: ["step-it"],
    },
    do: {
      src: `(define (step-it s) (io s))\n(do ((i 0 (+ i 1)) (acc "x" (step-it acc))) ((= i 2) (step-it acc)) (step-it "body"))`,
      symbols: ["step-it"],
    },
    branches: {
      src: `(define (good? t) (> (string-length t) 1))\n${FETCH}\n(if (good? "abc") (fetch-page "yes") (fetch-page "no"))\n(if (good? "a") (fetch-page "yes") "literal")\n(when (good? "a") (fetch-page "w"))\n(cond ((good? "a") (fetch-page "c1")) ((good? "bb") (fetch-page "c2")) (else (fetch-page "c3")))\n(and (good? "aa") (fetch-page "and"))`,
      symbols: ["good?", "fetch-page"],
    },
    call: {
      src: `${FETCH}\n(define (pipeline u) (fetch-page (string-append u "/1")) (fetch-page u))\n(pipeline (fetch-page "seed"))`,
      symbols: ["fetch-page"],
    },
    recursion: {
      src: `${FETCH}\n(define (walk n acc) (if (= n 0) acc (walk (- n 1) (fetch-page acc))))\n(walk 2 "s")\n(define (deep n) (if (= n 0) "z" (string-append (fetch-page "x") (deep (- n 1)))))\n(deep 2)`,
      symbols: ["fetch-page"],
    },
    mutual: {
      src: `${FETCH}\n(define (ping n acc) (if (= n 0) acc (pong (- n 1) (fetch-page acc))))\n(define (pong n acc) (ping n (fetch-page acc)))\n(ping 2 "s")`,
      symbols: ["fetch-page"],
    },
    recurViaFan: {
      src: `(define (walk t) (if (pair? t) (map walk t) (io t)))\n(walk (list "a" (list "b" "c")))`,
      symbols: ["io"],
    },
    apply: { src: `${FETCH}\n(apply fetch-page (list "z"))`, symbols: ["fetch-page"] },
    condRules: {
      src: `(define (good? t) (> (string-length t) 1))\n${FETCH}\n(cond ((good? "a") "atom1") ((good? "bb") "atom2") (else (fetch-page "e")))\n(cond ((good? "a") "x") ((good? "b") "y"))\n(cond ((fetch-page "k") => fetch-page) (else "no"))`,
      symbols: ["good?", "fetch-page"],
    },
    hostedTrack: {
      src: `${FETCH}\n(map (lambda (s) (-> s (fetch-page) (fetch-page))) (list "a" "b"))`,
      symbols: ["fetch-page"],
    },
    arrowInCallback: {
      src: `${FETCH}\n(map (lambda (s) (cond (s => fetch-page))) (list "a" "b"))`,
      symbols: ["fetch-page"],
    },
    testRejects: {
      src: `${FETCH}\n(define (explode u) (fail u))\n(map (lambda (s) (if (explode s) (fetch-page "t") (fetch-page "e"))) (list "a"))`,
      symbols: ["fetch-page", "explode"],
    },
    guard: {
      src: `${FETCH}\n(define (explode u) (fail u))\n(guard (e (#t (fetch-page "handled")))\n  (fetch-page "a")\n  (explode "b")\n  (fetch-page "never"))`,
      symbols: ["fetch-page", "explode"],
    },
    designatedCall: {
      src: `${FETCH}\n(define (crawl u) (fetch-page u) (fetch-page (string-append u "/2")))\n(crawl "r")`,
      symbols: ["fetch-page", "crawl"],
    },
  };

  let vocabulary: Vocabulary;
  beforeAll(async () => {
    const state = await execState("(begin)", {
      scope: LexicalScope.fresh("vocab"),
      capabilities: [ioCapability(new Gate())],
      config: {},
    });
    vocabulary = state.runCtx.vocabulary!;
    await disposeRunContext(state.runCtx);
  });

  for (const [name, { src, symbols }] of Object.entries(corpus)) {
    it(`${name}: every designated invocation is placed`, async () => {
      const plan = buildPlan({ forms: await parse(src), symbols: new Set(symbols), vocabulary });
      const capture = createExecutionCapture(symbols);
      const { error } = await run(src, capture);
      const p = new ProgressProjector(plan, capture).update(error ? "rejected" : "resolved");
      conserved(p);
      expect(p.counters.unplanned, "unplanned").toBe(0);
      expect(p.counters.unattributed, "unattributed").toBe(0);
      const designated = capture.invocationLog.filter((i) => capture.isDesignated(i));
      // Hosted-only case: its designated call has no invocation of its own.
      if (name !== "arrowInCallback") expect(designated.length).toBeGreaterThan(0);
      for (const inv of designated) expect(p.instanceOf(inv), `#${inv.id}`).toBeDefined();
      expect(p.stateOf(p.root)).toBe(error ? "rejected" : "resolved");
      checks[name]?.(p, capture);
    });
  }

  const checks: Record<string, (p: ProgressProjector, capture: ReturnType<typeof createExecutionCapture>) => void> = {
    // A branch whose test rejected reached no arm: none is instantiated (L4: skipped).
    testRejects: (p) => {
      const par = rootBody(p).items.find((i): i is FrameInstance => i.kind === "frame" && i.frame === "par")!;
      const br = par.bodies[0]!.items.find((i): i is FrameInstance => i.kind === "frame" && i.frame === "branch")!;
      expect(p.stateOf(br)).toBe("rejected");
      expect(br.takenArm).toBe("undecided");
      expect(br.bodies[0]?.items ?? []).toHaveLength(0);
      expect(p.isSettled(br)).toBe(true);
    },
    // G-1: a track whose designated calls are all hosted (macro-built calls have no
    // invocations) settles with the form that opened it.
    // A threading macro's expansion `(fetch-page (fetch-page s))` carries the `->` use's span: each
    // call lands on its planned `via: "macro"` step, the inner (first-threaded) one on the first.
    hostedTrack: (p) => {
      const par = rootBody(p).items.find((i): i is FrameInstance => i.kind === "frame" && i.frame === "par")!;
      expect(par.bodies).toHaveLength(2);
      for (const t of par.bodies) {
        expect(p.stateOf(t)).toBe("resolved");
        const [first, second] = par.template.children.map((c) => only(t, c.key) as StepInstance);
        expect(first!.plan!.via).toBe("macro");
        expect(first!.invocation!.parent).toBe(second!.invocation);
      }
    },
    // G-2: a branch that settled undecided has no untaken arm: every arm reads its state.
    arrowInCallback: (p) => {
      const par = rootBody(p).items.find((i): i is FrameInstance => i.kind === "frame" && i.frame === "par")!;
      for (const t of par.bodies) {
        const cond = t.items.find((i): i is FrameInstance => i.kind === "frame" && i.frame === "branch")!;
        expect(cond.takenArm).toBe("undecided");
        const arms = cond.bodies[0]!.items as FrameInstance[];
        expect(arms).toHaveLength(cond.template.children.length);
        for (const arm of arms) expect(p.stateOf(arm)).toBe("resolved");
      }
    },
    // P2-4: each track of `(map walk t)` is a nested instance of walk's call frame.
    recurViaFan: (p) => {
      const walk = frameAt(rootBody(p), "walk@2:0");
      const br = frameAt(walk.bodies[0]!, "walk@2:0▸if@1:17");
      const par = frameAt(frameAt(br.bodies[0]!, "walk@2:0▸if@1:17#0").bodies[0]!, "walk@2:0▸map@1:31");
      expect(par.bodies).toHaveLength(2);
      const nested = par.bodies.map((t) => t.items[0] as FrameInstance);
      expect(nested.map((n) => [n.depth, n.template.key])).toEqual([
        [1, "walk@2:0"],
        [1, "walk@2:0"],
      ]);
      // "a" is a leaf: its nested instance ran the io arm.
      const leaf = frameAt(nested[0]!.bodies[0]!, "walk@2:0▸if@1:17");
      expect(leaf.takenArm).toBe(1);
      // ("b" "c") recurses again: depth 2 inside.
      const inner = frameAt(nested[1]!.bodies[0]!, "walk@2:0▸if@1:17");
      const innerPar = frameAt(frameAt(inner.bodies[0]!, "walk@2:0▸if@1:17#0").bodies[0]!, "walk@2:0▸map@1:31");
      expect(innerPar.bodies.map((t) => (t.items[0] as FrameInstance).depth)).toEqual([2, 2]);
    },
    // P2-13: the apply host is the step; inputs are the spread list.
    apply: (p) => {
      const s = rootBody(p).items[0] as StepInstance;
      expect(s.symbol).toBe("fetch-page");
      const v = p.valuesOf(s);
      expect(v.inputs.map((i) => text(i.value))).toEqual(["z"]);
      expect(text(v.output)).toBe("z!");
    },
    // P2-2: the clause of the last evaluated test; all false → the implicit else; `=>`.
    condRules: (p) => {
      const conds = rootBody(p).items.filter((i): i is FrameInstance => i.kind === "frame");
      expect(conds.map((c) => c.takenArm)).toEqual([1, 2, 0]);
    },
  };
});
