/**
 * Wireframe soundness fixes (P-A: any code the interpreter accepts is representable as a
 * provenance graph) — record-then-replay rows. Builder-shape rows live in
 * `wireframe-builder.test.ts`; this file holds the ones whose claim is "γ over the recorded
 * ingress reproduces the eager run's value (and, where relevant, terminates)".
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execState, parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import type { Classifier, DeclaredRole } from "../lineage.js";
import { buildWireframe } from "../wireframe/builder.js";
import { unboundSlots } from "../wireframe/validate.js";
import { boxPayload, FrozenMints, replayGraphEgress, SENTINEL_BASE } from "../replay.js";
import { walkGraphReplay } from "../replay-walk.js";
import { freezeMints, recordRun, type RecordingShape } from "../../__tests__/provenance/q16-harness.js";

const ROLES: Record<string, DeclaredRole> = {
  "src-a": "source",
  "src-b": "source",
  "src-c": "source",
  "mcp/tool": "source",
  "meta-reactivity/added": "sink",
};
const classifier: Classifier = { roleOf: (op) => ROLES[op] };
const BASE = new Set(["+", "-", "*", "=", ">", "positive?", "car", "cons", "list", "length", "not"]);
const isBaseName = (n: string): boolean => BASE.has(n);

async function wf(code: string) {
  return buildWireframe(await parse(code), { classifier, isBaseName });
}

/** Record `code` live, build its wireframe, and replay both drivers from the frozen mints. */
async function replayAgrees(code: string, shapes: Record<string, RecordingShape>): Promise<void> {
  const run = await recordRun(inferenceEnv, code, shapes);
  const program = await wf(code);
  const whole = await replayGraphEgress({ program, frozen: freezeMints(run.mints) });
  expect(whole.value).toEqual(run.egress);
  const gen = walkGraphReplay({ program, frozen: freezeMints(run.mints) });
  let res = await gen.next();
  while (!res.done) res = await gen.next();
  expect(res.value.value).toEqual(run.egress);
}

beforeAll(async () => {});

describe("W-P2 — a value define of a port result replays", () => {
  it('(define plan (src-a 1)) (list plan "b")', async () => {
    await replayAgrees('(define plan (src-a 1))\n(list plan "b")', { "src-a": "num" });
  });
});

describe("W-P2b — a value define of a dict-field read off a source feeding a sink", () => {
  const code = [
    '(define inbox (:threads (mcp/tool "gmail" "search_threads" :query "in:inbox")))',
    "(meta-reactivity/added :identity :id inbox)",
  ].join("\n");

  it("builds without WireLocalityError and has no unbound slots", async () => {
    const program = await wf(code);
    expect(unboundSlots(program)).toEqual([]);
  });

  it("record-then-replay reproduces the value", async () => {
    // The sink is registered as a recording crossing (the harness only mints sources); the
    // classifier above still declares it a sink for the build.
    // A sink-tail program has no value egress by design (ReplayScopeError), so the replayed
    // program ends in `inbox`: the define's value is what must reproduce.
    await replayAgrees(`${code}\ninbox`, {
      "mcp/tool": { dict: ["threads"] },
      "meta-reactivity/added": { value: () => 1 },
    });
  });
});

describe("W-A1 — bracket surfaces replay", () => {
  it("bracket let* bindings", async () => {
    await replayAgrees("(let* ([a (src-a 1)] [b (+ a 1)]) (list a b))", { "src-a": "num" });
  });
  it("[…] vector literal with a port", async () => {
    await replayAgrees("[1 (src-a 2)]", { "src-a": "num" });
  });
  it("{…} dict literal with a port", async () => {
    await replayAgrees("{:a (src-a 2) :b 3}", { "src-a": "num" });
  });
});

describe("W-A2 — do result: replay of the loop interior from the last iteration's state", () => {
  it("(cons i acc) over the recur's next values reproduces the recorded egress", async () => {
    // Two iterations, one src-a mint each; the result clause sees the state at termination
    // (i = 2, acc = both mints) = the recur's NEXT values from the last iteration's state
    // (i = 1, acc = (m0)) — so only the LAST mint is demanded.
    const code = "(do ((i 0 (+ i 1)) (acc (list) (cons (src-a i) acc))) ((= i 2) (cons i acc)))";
    const run = await recordRun(inferenceEnv, code, { "src-a": "num" });
    const program = await wf(code);
    const binder = program.main.nodes.find((n) => n.kind === "binder");
    if (binder?.kind !== "binder") throw new Error("no binder");
    const [m0] = run.mints;
    const acc = (await execState(`(list ${String(m0.payload.value)})`)).values[0];
    const replayed = await replayGraphEgress({
      program,
      graph: binder.interior,
      frozen: freezeMints(run.mints.slice(1)),
      slots: { i: boxPayload({ value: 1, stampIds: [] }), acc },
    });
    expect(replayed.value).toEqual(run.egress);
    const gen = walkGraphReplay({
      program,
      graph: binder.interior,
      frozen: freezeMints(run.mints.slice(1)),
      slots: { i: boxPayload({ value: 1, stampIds: [] }), acc },
    });
    let res = await gen.next();
    while (!res.done) res = await gen.next();
    expect(res.value.value).toEqual(run.egress);
  });
});

describe("W-9 — a recursive port-reaching define terminates under γ", () => {
  const code = "(define (walk n) (if (= n 0) (src-a 0) (walk (- n 1))))\n(walk 3)";

  it("the template's pure-selector `if` stays a mux (its arms hold a port and a template-ref)", async () => {
    const program = await wf(code);
    const t = program.templates.get("walk")!;
    expect(t.graph.nodes.map((n) => n.kind).sort()).toEqual(["mux", "port", "source", "template-ref"]);
  });

  it("replay yields the recorded payload (both drivers) instead of recursing forever", async () => {
    await replayAgrees(code, { "src-a": "num" });
  });

  it("cut-free arms still collapse (no node cost for pure conditionals)", async () => {
    const program = await wf("(define (f n) (if (= n 0) (src-a 0) 1))\n(f 1)");
    expect(program.templates.get("f")!.graph.nodes.some((n) => n.kind === "mux")).toBe(true); // source arm
    const pure = await wf("(define (g n) (if (= n 0) (+ n 1) 1))\n(g 1)");
    expect(pure.templates.has("g")).toBe(false); // pure → prelude
  });
});

describe("FrozenMints — no global state", () => {
  it("two replays of the same program yield identical sentinel ids", async () => {
    const program = await wf("(list (src-a 1) (src-b 2))");
    const ids: number[][] = [];
    for (let i = 0; i < 2; i++) {
      const frozen = new FrozenMints(); // nothing recorded: every demand is a sentinel
      await replayGraphEgress({ program, frozen });
      ids.push([...frozen.sentinels.keys()]);
    }
    expect(ids[0]).toEqual([SENTINEL_BASE, SENTINEL_BASE + 1]);
    expect(ids[1]).toEqual(ids[0]);
  });
});
