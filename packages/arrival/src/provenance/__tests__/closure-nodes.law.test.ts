/**
 * CLOSURE NODES (P17 — "any code produced … can be represented as a provenance graph").
 * Every callable VALUE that reaches wire space is a `closure` node; free lexical variables of an
 * interior are CAPTURES (`capture:<name>` wires in the enclosing graph).
 *
 * Laws over the corpus (programs from the closure-nodes design, §6.2):
 *   1. builder-totality — `buildWireframe` never throws for a program that runs (a
 *      `WireLocalityError` here is a BUILDER BUG).
 *   2. no-unbound-slot — `unboundSlots(program)` is empty (main ingress ∅; corpus programs are closed).
 * Replay-dependent laws (record-then-replay value / cone, FrozenMints) land with step 4.
 */
import { describe, it, expect } from "vitest";
import type { Classifier, DeclaredRole } from "../lineage.js";
import { buildWireframe } from "../wireframe/builder.js";
import { hashGraph, siteHash } from "../wireframe/hash.js";
import { reachableNodesForDemand } from "../wireframe/loops.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { freezeMints, recordRun, replayedCone, type RecordingShape } from "../../__tests__/provenance/q16-harness.js";
import { fanCaptureSlots, FrozenMints, replayGraphEgress } from "../replay.js";
import type { CallCtx } from "../../run/CallCtx.js";
import { execStateOverFrame as execState, parse } from "../../eval/generator-exec.js";
import { EvalTrace } from "../trace.js";
import { toJS } from "../../membrane/rosetta.js";
import type { RunEmission } from "../../run/RunContext.js";
import { foldRegionStream } from "../store/fold.js";
import { PayloadStoreFake, ProvenanceStoreFake } from "../store/fakes.js";
import type { SchemeValue } from "../../values/types.js";
import type { Payload } from "../store/interfaces.js";
import { EnvCapability } from "../../common/capability.js";
import { applyCapability } from "../../__tests__/_fresh-env.js";
import { walkGraphReplay } from "../replay-walk.js";
import { unboundSlots } from "../wireframe/validate.js";
import type { WireframeGraph, WireframeNode, WireframeProgram } from "../wireframe/types.js";

const ROLES: Record<string, DeclaredRole> = {
  "src-a": "source",
  "src-b": "source",
  "src-c": "source",
  "emit!": "sink",
  map: "fan",
  filter: "fan",
};
const CLASSIFIER: Classifier = { roleOf: (op) => ROLES[op] };
const BASE = new Set([
  "+",
  "-",
  "*",
  "/",
  "=",
  "<",
  ">",
  "positive?",
  "not",
  "null?",
  "cons",
  "car",
  "cdr",
  "cadr",
  "list",
  "length",
  "reduce",
  "apply",
  "for-each",
  "find",
  "any",
  "sort",
  "raise",
  "equal?",
]);
const isBaseName = (n: string): boolean => BASE.has(n);

async function wf(code: string): Promise<WireframeProgram> {
  return buildWireframe(await parse(code), { classifier: CLASSIFIER, isBaseName });
}

const MY_MAP = "(define (my-map f xs) (if (null? xs) (list) (cons (f (car xs)) (my-map f (cdr xs)))))";

interface Row {
  readonly n: number;
  readonly name: string;
  readonly code: string;
}

const CORPUS: readonly Row[] = [
  { n: 1, name: "let-closure-two-calls", code: "(let ((h (lambda (x) (src-a x)))) (list (h 1) (h 2)))" },
  { n: 2, name: "let-closure-captures-port", code: "(let* ((k (src-b 1)) (h (lambda (x) (+ x k (src-a x))))) (h 1))" },
  { n: 3, name: "letrec-self-recursion", code: "(letrec ((h (lambda (x) (if (= x 0) (src-a 0) (h (- x 1)))))) (h 3))" },
  {
    n: 4,
    name: "letrec-mutual",
    code: "(letrec ((ev (lambda (n) (if (= n 0) (src-a 0) (od (- n 1))))) (od (lambda (n) (if (= n 0) (src-b 0) (ev (- n 1)))))) (ev 3))",
  },
  { n: 5, name: "internal-define-closure", code: "(define (f) (define (g x) (src-a x)) (list (g 1) (g 2)))\n(f)" },
  {
    n: 6,
    name: "closure-returned",
    code: "(define (mk k) (lambda (x) (src-a (+ x k))))\n(let ((f (mk 10))) (list (f 1) (f 2)))",
  },
  {
    n: 7,
    name: "closure-returned-captures-port",
    code: "(define (mk) (let ((k (src-b 1))) (lambda (x) (+ x k))))\n((mk) 5)",
  },
  {
    n: 8,
    name: "closures-in-list",
    code: "(let ((fs (list (lambda (x) (src-a x)) (lambda (x) (src-b x))))) (list ((cadr fs) 2) ((car fs) 1)))",
  },
  { n: 9, name: "closure-in-dict", code: "(let ((d {:a (lambda (x) (src-a x))})) ((:a d) 1))" },
  {
    n: 10,
    name: "partial-application-port",
    code: "(define (adder k) (lambda (x) (+ x k)))\n(let ((a (adder (src-a 1)))) (a 5))",
  },
  {
    n: 11,
    name: "partial-application-closure-port",
    code: "(define (wrap f) (lambda (x) (f x)))\n((wrap (lambda (y) (src-a y))) 1)",
  },
  { n: 12, name: "user-hof-define", code: `${MY_MAP}\n(my-map (lambda (x) (src-a x)) (list 1 2 3))` },
  {
    n: 13,
    name: "for-each-material-define",
    code: "(define (helper x) (emit! (src-a x)))\n(for-each helper (list 1 2))",
  },
  { n: 14, name: "apply-material-define", code: "(define (helper x) (src-a x))\n(apply helper (list 7))" },
  { n: 15, name: "apply-lambda", code: "(apply (lambda (x y) (src-a (+ x y))) (list 1 2))" },
  { n: 16, name: "reduce-with-port-closure", code: "(reduce (lambda (acc x) (+ acc (src-a x))) 0 (list 1 2 3))" },
  {
    n: 17,
    name: "find-any-with-port-pred",
    code: "(list (find (lambda (x) (positive? (src-a x))) (list 1 2)) (any (lambda (x) (src-b x)) (list 1)))",
  },
  { n: 18, name: "map-material-define", code: "(define (helper x) (src-a x))\n(map helper (list 1 2))" },
  { n: 19, name: "map-bare-port", code: "(list (map src-a (list 1)) (map src-a (list 2)))" },
  { n: 20, name: "alias-let-port", code: "(let ((g src-a)) (list (g 1) (g 2)))" },
  { n: 21, name: "alias-let-material", code: "(define (helper x) (src-a x))\n(let ((g helper)) (g 1))" },
  {
    n: 22,
    name: "fan-capture-let-port",
    code: "(let ((k (src-b 1))) (map (lambda (x) (+ x k (src-a x))) (list 1 2)))",
  },
  {
    n: 23,
    name: "fan-capture-value-define",
    code: "(define plan (src-b 1))\n(map (lambda (x) (+ x plan)) (list 1 2))",
  },
  {
    n: 24,
    name: "closure-inside-fan-template",
    code: "(map (lambda (x) (let ((h (lambda (y) (src-a (+ x y))))) (h 1))) (list 1 2))",
  },
  {
    n: 25,
    name: "loop-captures-port",
    code: "(let ((k (src-b 1))) (let loop ((i 0) (acc 0)) (if (= i 2) acc (loop (+ i 1) (+ acc k (src-a i))))))",
  },
  { n: 26, name: "guard-var-feeds-port", code: "(guard (e (#t (src-b e))) (raise 'boom))" },
  { n: 27, name: "guard-port-body-no-raise", code: "(guard (e (#t 0)) (src-a 1))" },
  { n: 28, name: "try-catch-port", code: "(try (src-a 1) (catch (e) (src-b 1)) (finally (emit! 0)))" },
  { n: 29, name: "if-bare-port-positions", code: "((if (src-a 1) src-b src-b) 2)" },
  {
    n: 30,
    name: "port-coupled-mux-inside-closure",
    code: "(let ((h (lambda (x) (if (positive? (src-a x)) (src-b x) 0)))) (list (h 1) (h -1)))",
  },
];

/** Every graph (main, templates, nested interiors) with its path. */
function allGraphs(program: WireframeProgram): { path: string; graph: WireframeGraph }[] {
  const out: { path: string; graph: WireframeGraph }[] = [];
  const visit = (graph: WireframeGraph, path: string): void => {
    out.push({ path, graph });
    graph.nodes.forEach((n, i) => {
      if ((n.kind === "closure" || n.kind === "fan") && n.template !== undefined) visit(n.template, `${path}/#${i}`);
      if (n.kind === "binder") visit(n.interior, `${path}/#${i}`);
    });
  };
  visit(program.main, "main");
  for (const [name, t] of program.templates) visit(t.graph, `template:${name}`);
  return out;
}

const nodesOf = (program: WireframeProgram, kind: WireframeNode["kind"]): WireframeNode[] =>
  allGraphs(program).flatMap(({ graph }) => graph.nodes.filter((n) => n.kind === kind));

describe("closure nodes — builder totality (never throws for a program that runs)", () => {
  it.each(CORPUS)("row $n $name", async ({ code }) => {
    await expect(wf(code)).resolves.toBeDefined();
  });
});

describe("closure nodes — no unbound slot (every wire slot param is bound at its level)", () => {
  it.each(CORPUS)("row $n $name", async ({ code }) => {
    expect(unboundSlots(await wf(code))).toEqual([]);
  });
});

describe("closure nodes — builder shape pins", () => {
  it("row 1: closure{template:[source,port]}, wire x->source.arg0 reads slot x, no captures", async () => {
    const p = await wf(CORPUS[0].code);
    expect(p.main.nodes.map((n) => n.kind)).toEqual(["closure", "port"]);
    const c = p.main.nodes[0];
    if (c.kind !== "closure" || c.template === undefined) throw new Error("expected inline closure");
    expect(c.captures).toEqual([]);
    expect(c.params).toEqual(["x"]);
    expect(c.template.nodes.map((n) => n.kind)).toEqual(["source", "port"]);
    expect(c.template.wires[0].paramRefs).toEqual([{ kind: "slot", name: "x" }]);
    expect(p.main.wires.find((w) => w.consumer.slot === "out")?.source).toBe(
      "(lambda (in0) (let ((h in0)) (list (h 1) (h 2))))",
    );
  });

  it("row 3: letrec self-capture is a self-edge through the full frame", async () => {
    const p = await wf(CORPUS[2].code);
    const idx = p.main.nodes.findIndex((n) => n.kind === "closure");
    const c = p.main.nodes[idx];
    if (c.kind !== "closure") throw new Error("expected closure");
    expect(c.captures).toEqual(["h"]);
    const w = p.main.wires.find((x) => x.consumer.node === idx && x.consumer.slot === "capture:h");
    expect(w?.source).toBe("(lambda (in0) (letrec ((h in0)) h))");
    expect(w?.paramRefs).toEqual([{ kind: "node", name: "in0", node: idx }]);
  });

  it("row 4: mutual recursion — each capture wire sees BOTH sibling cuts (deferred flush)", async () => {
    const p = await wf(CORPUS[3].code);
    const w = p.main.wires.find((x) => x.consumer.slot === "capture:od");
    expect(w?.source).toBe("(lambda (in0 in1) (letrec ((ev in0) (od in1)) od))");
  });

  it("row 22: fan.captures = [k], supplied by a wire to the src-b node", async () => {
    const p = await wf(CORPUS[21].code);
    const idx = p.main.nodes.findIndex((n) => n.kind === "fan");
    const f = p.main.nodes[idx];
    if (f.kind !== "fan") throw new Error("expected fan");
    expect(f.captures).toEqual(["k"]);
    const w = p.main.wires.find((x) => x.consumer.node === idx && x.consumer.slot === "capture:k");
    expect(w?.source).toMatch(/^\(lambda \(in0\) \(let \(\(k in0\)\) k\)\)$/);
    const src = p.main.nodes.findIndex((n) => n.kind === "source");
    expect(w?.paramRefs).toEqual([{ kind: "node", name: "in0", node: src }]);
  });

  it("row 23: a material VALUE define is captured through the pruned root frame", async () => {
    const p = await wf(CORPUS[22].code);
    const f = p.main.nodes.find((n) => n.kind === "fan");
    if (f?.kind !== "fan") throw new Error("expected fan");
    expect(f.captures).toEqual(["plan"]);
    expect(p.main.wires.find((x) => x.consumer.slot === "capture:plan")?.source).toBe(
      "(lambda (in0) (let* ((plan in0)) plan))",
    );
  });

  it("row 25: binder.captures = [k]", async () => {
    const p = await wf(CORPUS[24].code);
    const b = p.main.nodes.find((n) => n.kind === "binder");
    if (b?.kind !== "binder") throw new Error("expected binder");
    expect(b.captures).toEqual(["k"]);
  });

  it("row 18: a material define as a map callback is a `fn` wire to a closure{ref:define}", async () => {
    const p = await wf(CORPUS[17].code);
    const f = p.main.nodes.findIndex((n) => n.kind === "fan");
    const node = p.main.nodes[f];
    if (node.kind !== "fan") throw new Error("expected fan");
    expect(node.fnOp).toBeUndefined();
    const w = p.main.wires.find((x) => x.consumer.node === f && x.consumer.slot === "fn");
    expect(w?.source).toBe("(lambda (in0) in0)");
    const ref = p.main.nodes[(w?.paramRefs[0] as { node: number }).node];
    expect(ref).toMatchObject({ kind: "closure", ref: { kind: "define", name: "helper" } });
  });

  it("row 19 / 29: one closure{ref:port} node PER OCCURRENCE", async () => {
    const p19 = await wf(CORPUS[18].code);
    expect(nodesOf(p19, "closure").filter((n) => n.kind === "closure" && n.ref?.kind === "port")).toHaveLength(2);
    const p29 = await wf(CORPUS[28].code);
    expect(nodesOf(p29, "closure").filter((n) => n.kind === "closure" && n.ref?.kind === "port")).toHaveLength(2);
  });

  it("a pure lambda stays wire material (no closure node)", async () => {
    const p = await wf("(let ((f (lambda (x) (+ x 1)))) (f 2))");
    expect(nodesOf(p, "closure")).toEqual([]);
    expect(unboundSlots(p)).toEqual([]);
  });
});

describe("closure nodes — hashing (two-hash rule)", () => {
  const closureTemplate = (p: WireframeProgram): WireframeGraph[] =>
    p.main.nodes.flatMap((n) => (n.kind === "closure" && n.template !== undefined ? [n.template] : []));

  it("two identical lambdas at two sites share ONE template hash and have two site hashes", async () => {
    const p = await wf("(list (lambda (x) (src-a x)) (lambda (x) (src-a x)))");
    const [a, b] = closureTemplate(p);
    expect(hashGraph(a)).toBe(hashGraph(b));
    const [na, nb] = nodesOf(p, "closure");
    expect(siteHash(hashGraph(a), na.span)).not.toBe(siteHash(hashGraph(b), nb.span));
  });

  it("α-renaming a lambda formal changes the template hash (α-ruling kept)", async () => {
    const [a] = closureTemplate(await wf("(list (lambda (x) (src-a x)))"));
    const [b] = closureTemplate(await wf("(list (lambda (y) (src-a y)))"));
    expect(hashGraph(a)).not.toBe(hashGraph(b));
  });

  it("a different capture set changes the enclosing graph hash", async () => {
    const a = await wf("(let ((k (src-b 1))) (map (lambda (x) (+ x k)) (list 1)))");
    const b = await wf("(let ((j (src-b 1))) (map (lambda (x) (+ x j)) (list 1)))");
    expect(hashGraph(a.main)).not.toBe(hashGraph(b.main));
  });
});

// ── replay: record the program for real, then γ it from FrozenMints alone ─────────────────────────
const SOURCES: Record<string, RecordingShape> = { "src-a": "num", "src-b": "num", "src-c": "num", "emit!": "echo" };

/** Rows whose replay is the claim; 22–25 ride the fan arm (step 6) and the loop door stays a door. */
const REPLAY_ROWS = CORPUS.filter((r) => r.n !== 25);

async function drained(opts: Parameters<typeof walkGraphReplay>[0]) {
  const gen = walkGraphReplay(opts);
  let r = await gen.next();
  while (r.done !== true) r = await gen.next();
  return r.value;
}

describe("closure nodes — record-then-replay (value AND cone equal the eager run; the world is never consulted)", () => {
  it.each(REPLAY_ROWS)("row $n $name", async ({ code }) => {
    const run = await recordRun(inferenceEnv, code, SOURCES);
    const program = await wf(code);
    const callsAfterRecord = new Map(run.registry.calls);

    const whole = await replayGraphEgress({ program, frozen: freezeMints(run.mints) });
    expect(whole.value).toEqual(run.egress);
    expect(run.registry.opsOf(replayedCone(whole.boxed))).toEqual(run.registry.opsOf(run.eagerCone));

    const walked = await drained({ program, frozen: freezeMints(run.mints) });
    expect(walked.value).toEqual(run.egress);
    expect(run.registry.opsOf(replayedCone(walked.boxed))).toEqual(run.registry.opsOf(run.eagerCone));

    expect(run.registry.calls).toEqual(callsAfterRecord); // FrozenMints never consult the world
  });
});

describe("closure nodes — guard / try shapes and fan capture slots", () => {
  it("rows 26–28 are guard nodes with the right arity", async () => {
    const g26 = (await wf(CORPUS[25].code)).main.nodes[0];
    expect(g26).toMatchObject({ kind: "guard", op: "guard", var: "e", clauses: 1, hasFinally: false });
    const g28 = (await wf(CORPUS[27].code)).main.nodes[0];
    expect(g28).toMatchObject({ kind: "guard", op: "try", var: "e", clauses: 1, hasFinally: true });
  });

  it("a pure guard stays wire material", async () => {
    const p = await wf("(guard (e (#t 0)) (raise 'boom))");
    expect(nodesOf(p, "guard")).toEqual([]);
  });

  it("fanCaptureSlots γ's the sealed captures from frozen ingress", async () => {
    const code = CORPUS[21].code; // row 22
    const run = await recordRun(inferenceEnv, code, SOURCES);
    const program = await wf(code);
    const fanIdx = program.main.nodes.findIndex((n) => n.kind === "fan");
    const slots = await fanCaptureSlots({ program, fanIdx, frozen: freezeMints(run.mints) });
    expect(Object.keys(slots)).toEqual(["k"]);
  });
});

// ── step 7: raised crossings — a rejected host crossing is RECORDED and replayed ──────────────────
/** Real rosetta `src-a`/`src-b` under a run with `emission`: `src-a` throws on "fail", `src-b` mints 7. */
async function recordWithThrowingWorld(code: string) {
  const store = new ProvenanceStoreFake();
  const payloads = new PayloadStoreFake();
  const emission: RunEmission = {
    store,
    payloads,
    regionId: "closure-raise",
    coordinate: { templateHash: "th", ordinalPath: [0], regionEpoch: "e0" },
  };
  const env = inferenceEnv.child("closure-raise-world");
  await applyCapability(env, [
    EnvCapability.define("test/closure-raise", {
      symbols: (symbol, z) => ({
        "src-a": symbol.rosetta`src-a: throws on "fail"`(
          { input: [z.string], output: [z.number] },
          function (this: CallCtx, arg: string) {
            if (arg === "fail") throw new Error("boom");
            return 1;
          },
        ),
        "src-b": symbol.rosetta`src-b: mints 7`(
          { input: [z.number], output: [z.number] },
          function (this: CallCtx, _n: number) {
            return 7;
          },
        ),
      }),
    }),
  ]);
  const result = await execState(code, { env, tap: new EvalTrace(), emission });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  const frozen = new FrozenMints();
  const ops = ["src-a", "src-b"];
  const stream = await store.readStream("closure-raise");
  const recorded: Payload[] = [];
  for (const r of stream) {
    if (r.kind !== "mint") continue;
    const rec = await payloads.get(r.payloadHash);
    recorded.push({
      value: rec.value,
      stampIds: rec.stampIds,
      ...(rec.raised === true ? { raised: true as const } : {}),
    });
  }
  return { egress: toJS(result.values.at(-1) as SchemeValue), recorded, frozen, ops };
}

describe("closure nodes — raised crossings (step 7)", () => {
  it("row 31: the hook records the rejected crossing as a raised payload; replay re-raises it into the guard", async () => {
    const code = `(guard (e (#t (src-b 1))) (src-a "fail"))`;
    const run = await recordWithThrowingWorld(code);
    expect(run.egress).toBe(7);
    expect(run.recorded[0]).toMatchObject({ value: "boom", stampIds: [], raised: true });
    expect(run.recorded[1].raised).toBeUndefined();

    const frozen = new FrozenMints();
    run.recorded.forEach((p, i) => frozen.push(run.ops[i], p));
    const program = await wf(code);
    // the replay env has NO src-a / src-b at all: the world (throwing or not) cannot be consulted
    const replayed = await replayGraphEgress({ program, frozen });
    expect(replayed.value).toBe(7);
    const frozen2 = new FrozenMints();
    run.recorded.forEach((p, i) => frozen2.push(run.ops[i], p));
    expect((await drained({ program, frozen: frozen2 })).value).toBe(7);
  });

  it("an in-γ port closure that raised replays inside a native guard", async () => {
    const code = `(let ((h src-a)) (guard (e (#t 7)) (h "fail")))`;
    const run = await recordWithThrowingWorld(code);
    expect(run.egress).toBe(7);
    const frozen = new FrozenMints();
    run.recorded.forEach((p, i) => frozen.push(run.ops[i], p));
    expect((await replayGraphEgress({ program: await wf(code), frozen })).value).toBe(7);
  });

  it("an un-guarded recorded raise surfaces as a ReplayRaise (never a fabricated value)", async () => {
    const code = `(src-a "fail")`;
    const frozen = new FrozenMints();
    frozen.push("src-a", { value: "boom", stampIds: [], raised: true });
    await expect(replayGraphEgress({ program: await wf(code), frozen })).rejects.toThrow(/boom/);
  });
});

// ── step 8: a closure CALL is a track — its ports emit under [...E, r_C, k, n] ───────────────────
async function recordWithClosureSites(code: string) {
  const store = new ProvenanceStoreFake();
  const payloads = new PayloadStoreFake();
  const [form] = await parse(code);
  // the SAME parsed form feeds the wireframe and the evaluator: sites are keyed by pair identity
  const program = buildWireframe([form], { classifier: CLASSIFIER, isBaseName });
  const emission: RunEmission = {
    store,
    payloads,
    regionId: "closure-calls",
    coordinate: { templateHash: "th", ordinalPath: [0], regionEpoch: "e0" },
    closureSites: program.closureSites,
  };
  const env = inferenceEnv.child("closure-calls-world");
  await applyCapability(env, [
    EnvCapability.define("test/closure-calls", {
      symbols: (symbol, z) => ({
        "src-a": symbol.rosetta`src-a: numeric source`(
          { input: [z.number], output: [z.number] },
          function (this: CallCtx, n: number) {
            return n * 10;
          },
        ),
      }),
    }),
  ]);
  const result = await execState(form, { env, tap: new EvalTrace(), emission });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const stream = await store.readStream("closure-calls");
  return { program, stream, egress: toJS(result.values.at(-1) as SchemeValue) };
}

describe("closure nodes — closure-call coordinates (step 8)", () => {
  it("each call of a closure opens/closes one track; its ports emit at [...E, r_C, k, n] under the template hash", async () => {
    const { program, stream, egress } = await recordWithClosureSites(CORPUS[0].code);
    expect(egress).toEqual([10, 20]);
    const rC = program.main.nodes.findIndex((n) => n.kind === "closure");
    const closure = program.main.nodes[rC];
    if (closure.kind !== "closure" || closure.template === undefined) throw new Error("expected inline closure");
    const th = hashGraph(closure.template);

    const fold = foldRegionStream(stream);
    expect(fold.started).toBe(2);
    expect(fold.completed).toBe(2);
    expect(fold.pending).toBe(0); // opens = closes

    const mints = stream.filter((r) => r.kind === "mint");
    expect(mints.map((m) => m.id.templateHash)).toEqual([th, th]);
    // [0] = the run's coordinate, then r_C, call ordinal k; the trailing n is the window's event counter
    expect(mints.map((m) => m.id.ordinalPath.slice(0, 3))).toEqual([
      [0, rC, 0],
      [0, rC, 1],
    ]);
    // mints, track-open and track-close of ONE call never share a record id (store upserts by id alone)
    const ids = new Set(stream.map((r) => JSON.stringify(r.id)));
    expect(ids.size).toBe(stream.length);
  });

  it("a closure DEFINED inside a closure call but called from the root nests under the root (its caller)", async () => {
    const code = `(let ((f (lambda (a) (lambda (b) (src-a (+ a b)))))) (list ((f 1) 1) ((f 2) 2)))`;
    const { program, stream, egress } = await recordWithClosureSites(code);
    expect(egress).toEqual([20, 40]);
    const outer = program.main.nodes.find((n) => n.kind === "closure");
    if (outer?.kind !== "closure" || outer.template === undefined) throw new Error("expected inline closure");
    const inner = outer.template.nodes.findIndex((n) => n.kind === "closure");
    const mints = stream.filter((r) => r.kind === "mint");
    // [0, r_inner, k, n]: directly under the run's coordinate, not under f's call window
    expect(mints.every((m) => m.id.ordinalPath.length === 4)).toBe(true);
    expect(mints.map((m) => m.id.ordinalPath[1])).toEqual([inner, inner]);
    // the root window numbers its calls per site index, so the two inner calls get distinct k
    const ks = mints.map((m) => m.id.ordinalPath[2]);
    expect(new Set(ks).size).toBe(2);
    expect(new Set(stream.map((r) => JSON.stringify(r.id))).size).toBe(stream.length);
    const fold = foldRegionStream(stream);
    expect(fold.started).toBe(4); // 2 outer + 2 inner calls
    expect(fold.pending).toBe(0);
  });

  it("calls into one closure from several fan rows nest under each row's window, numbered within the row", async () => {
    const code = `(let ((f (lambda (v) (src-a v)))) (map (lambda (row) (map f row)) (list (list 1 2) (list 3 4))))`;
    const { program, stream, egress } = await recordWithClosureSites(code);
    expect(egress).toEqual([
      [10, 20],
      [30, 40],
    ]);
    const fan = program.main.nodes.findIndex((n) => n.kind === "fan");
    const f = program.main.nodes.findIndex((n) => n.kind === "closure");
    const mints = stream.filter((r) => r.kind === "mint");
    // [0, r_fan, row, r_f, k, n]: under row `row`'s window, k = the call's index within that row
    const coords = mints.map((m) => m.id.ordinalPath.slice(0, 5)).sort((a, b) => a[2] - b[2] || a[4] - b[4]);
    expect(coords).toEqual([
      [0, fan, 0, f, 0],
      [0, fan, 0, f, 1],
      [0, fan, 1, f, 0],
      [0, fan, 1, f, 1],
    ]);
  });

  it("a silent run emits nothing (closure windows are an emission concern only)", async () => {
    const [form] = await parse(CORPUS[0].code);
    const store = new ProvenanceStoreFake();
    const program = buildWireframe([form], { classifier: CLASSIFIER, isBaseName });
    const emission: RunEmission = {
      store,
      payloads: new PayloadStoreFake(),
      regionId: "closure-silent",
      coordinate: { templateHash: "th", ordinalPath: [0], regionEpoch: "e0" },
      closureSites: program.closureSites,
    };
    const env = inferenceEnv.child("closure-silent-world");
    await applyCapability(env, [
      EnvCapability.define("test/closure-silent", {
        symbols: (symbol, z) => ({
          "src-a": symbol.rosetta`src-a: numeric source`(
            { input: [z.number], output: [z.number] },
            function (this: CallCtx, n: number) {
              return n;
            },
          ),
        }),
      }),
    ]);
    await execState(form, { env, tap: new EvalTrace(), emission, silent: true });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(await store.readStream("closure-silent")).toHaveLength(0);
  });
});

// STEP 6+ ledger — still open.
describe("closure nodes — ledgered gaps", () => {
  it.todo("row 32: sort-comparator-closure — value equality only, call ORDER is a host-schedule LIMIT");
  it.todo(
    "row 25: loop-captures-port wire-γ replay — named-let could lift (recur = recursion), do cannot (value-dropped exit test); ledger: closure nodes — loop binder replay",
  );
});

describe("unboundSlots — validator on hand-built graphs", () => {
  const wire = (slot: string, consumerSlot: string, node = 0) => ({
    source: `(lambda (${slot}) ${slot})`,
    params: [slot],
    paramRefs: [{ kind: "slot" as const, name: slot }],
    span: "s",
    consumer: { node, slot: consumerSlot },
  });
  const prelude = { names: new Set<string>(), source: "" };
  const membership = { pure: new Set<string>(), wireframe: new Set<string>(), reasons: new Map<string, string>() };

  it("flags an unbound slot, a missing capture wire, and a stray capture wire", () => {
    const template: WireframeGraph = {
      nodes: [{ kind: "port", direction: "out", span: "s" }],
      wires: [wire("k", "out")],
      egress: 0,
    };
    const closure: WireframeNode = { kind: "closure", span: "s", params: ["x"], template, captures: [] };
    const main: WireframeGraph = { nodes: [closure], wires: [wire("zz", "capture:zz")], egress: null };
    const found = unboundSlots({ prelude, membership, templates: new Map(), main });
    expect(found.map((f) => f.name).toSorted()).toEqual(["capture:zz", "k", "zz"].toSorted());
  });

  it("accepts declared ingress and declared captures", () => {
    const template: WireframeGraph = {
      nodes: [{ kind: "port", direction: "out", span: "s" }],
      wires: [wire("k", "out")],
      egress: 0,
    };
    const closure: WireframeNode = { kind: "closure", span: "s", params: ["x"], template, captures: ["k"] };
    const main: WireframeGraph = { nodes: [closure], wires: [wire("k", "capture:k")], egress: null };
    const program = { prelude, membership, templates: new Map(), main };
    expect(unboundSlots(program)).toEqual([{ graph: "main", wire: 0, name: "k" }]);
    expect(unboundSlots(program, { declaredIngress: new Set(["k"]) })).toEqual([]);
  });
});

describe("count-demand: a fan's `fn` wire is followed only for non-length-preserving fans", () => {
  it("map prunes `fn` under count demand; filter keeps it", async () => {
    const m = await wf("(define (helper x) (src-a x))\n(map helper (list 1 2))");
    const f = await wf("(define (helper x) (src-a x))\n(filter helper (list 1 2))");
    const fanIdx = (p: WireframeProgram): number => p.main.nodes.findIndex((n) => n.kind === "fan");
    const closureIdx = (p: WireframeProgram): number => p.main.nodes.findIndex((n) => n.kind === "closure");
    expect(reachableNodesForDemand(m.main, fanIdx(m), "count").has(closureIdx(m))).toBe(false);
    expect(reachableNodesForDemand(m.main, fanIdx(m), "value").has(closureIdx(m))).toBe(true);
    expect(reachableNodesForDemand(f.main, fanIdx(f), "count").has(closureIdx(f))).toBe(true);
  });
});
