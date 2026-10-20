/**
 * LAW — mux arm choice (docs/PROVENANCE.md §1 A2, §4 D3): for every mux op the builder emits
 * (`if` / else-less `if` / `when` / `unless`), both replay drivers' decisions-less γ pick the arm
 * the EAGER oracle recorded — same value, same source cone — on both selector outcomes. An
 * else-less / not-taken form falls through to void (a proper result, not a record gap). The
 * sequential muxes (`cond`, and W-6's `case`: one selector per clause) and short-circuit
 * `and` / `or` are held to the same law at the end of this file.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import type { Classifier, DeclaredRole } from "../lineage.js";
import { buildWireframe } from "../wireframe/builder.js";
import { replayGraphEgress } from "../replay.js";
import { walkGraphReplay } from "../replay-walk.js";
import { freezeMints, recordRun, replayedCone } from "../../__tests__/provenance/q16-harness.js";

const ROLES: Record<string, DeclaredRole> = {
  "src-a": "source",
  "src-b": "source",
  "src-c": "source",
  "src-d": "source",
};
const classifier: Classifier = { roleOf: (op) => ROLES[op] };
const BASE = new Set(["+", "-", "*", ">", "positive?", "car", "cons", "list", "length"]);
const isBaseName = (n: string): boolean => BASE.has(n);

async function wf(code: string) {
  return buildWireframe(await parse(code), { classifier, isBaseName });
}

beforeAll(async () => {});

// selector source answers 5 (truthy test) or -5 (falsy test) — `positive?` makes the mux port-coupled
const MUX_FORMS: Record<string, string> = {
  if: "(if (positive? (src-a)) (src-b) (src-c))",
  "if (else-less)": "(if (positive? (src-a)) (src-b))",
  when: "(when (positive? (src-a)) (src-b))",
  unless: "(unless (positive? (src-a)) (src-b))",
};

describe("decisions-less γ picks the eager oracle's arm for every builder-emitted mux op", () => {
  describe.each(Object.entries(MUX_FORMS))("%s", (_name, code) => {
    it.each([5, -5])("selector %i", async (sel) => {
      const run = await recordRun(inferenceEnv, code, {
        "src-a": { value: () => sel },
        "src-b": "num",
        "src-c": "num",
      });
      const program = await wf(code);
      expect(program.main.nodes.some((n) => n.kind === "mux")).toBe(true);

      const whole = await replayGraphEgress({ program, frozen: freezeMints(run.mints) });
      expect(whole.value).toEqual(run.egress);
      expect([...run.registry.opsOf(replayedCone(whole.boxed))].sort()).toEqual(
        [...run.registry.opsOf(run.eagerCone)].sort(),
      );

      const gen = walkGraphReplay({ program, frozen: freezeMints(run.mints) });
      let res = await gen.next();
      while (!res.done) res = await gen.next();
      expect(res.value.value).toEqual(run.egress);
      expect([...run.registry.opsOf(replayedCone(res.value.boxed))].sort()).toEqual(
        [...run.registry.opsOf(run.eagerCone)].sort(),
      );
    });
  });
});

describe("cond mux — sequential selectors, γ arm == eager arm (was a teaching door)", () => {
  const PROGRAMS: [string, string][] = [
    ["plain clauses", "(cond ((positive? (src-a)) (src-b)) ((positive? (src-d)) (src-c)) (else 0))"],
    ["no else (fallthrough)", "(cond ((positive? (src-a)) (src-b)))"],
    ["=> receiver", "(cond ((positive? (src-a)) => (lambda (t) (list t t))) (else (src-c)))"],
  ];
  describe.each(PROGRAMS)("%s", (_name, code) => {
    it.each([
      [5, 5],
      [-5, 5],
      [-5, -5],
    ])("selectors %i / %i", async (a, d) => {
      const run = await recordRun(inferenceEnv, code, {
        "src-a": { value: () => a },
        "src-b": "num",
        "src-c": "num",
        "src-d": { value: () => d },
      });
      const program = await wf(code);
      expect(program.main.nodes.some((n) => n.kind === "mux" && n.op === "cond")).toBe(true);
      const whole = await replayGraphEgress({ program, frozen: freezeMints(run.mints) });
      expect(whole.value).toEqual(run.egress);
      const gen = walkGraphReplay({ program, frozen: freezeMints(run.mints) });
      let res = await gen.next();
      while (!res.done) res = await gen.next();
      expect(res.value.value).toEqual(run.egress);
    });
  });
});

describe("decisions are scoped to the graph they index (A6)", () => {
  // main mux and the template's mux are both node 0 in their OWN graphs; a decision recorded for
  // main's node 0 must not force the template's node 0.
  const code = "(define (f) (if (positive? (src-a)) (src-b) (src-c)))\n(if (positive? (src-d)) (f) 0)";
  it("a main-graph decision does not leak into a nested template graph", async () => {
    const run = await recordRun(inferenceEnv, code, {
      "src-a": { value: () => -5 }, // template selector false → eager takes src-c
      "src-b": "num",
      "src-c": "num",
      "src-d": "num", // main selector true → arm0
    });
    const program = await wf(code);
    const decisions = new Map([[0, 0]]); // main mux: then-arm (would force the template's mux to src-b)
    const whole = await replayGraphEgress({ program, frozen: freezeMints(run.mints), decisions });
    expect(whole.value).toEqual(run.egress);
    const gen = walkGraphReplay({ program, frozen: freezeMints(run.mints), decisions });
    let res = await gen.next();
    while (!res.done) res = await gen.next();
    expect(res.value.value).toEqual(run.egress);
  });
});

// W-6 — `case` and short-circuit `and`/`or` with a port-reaching selector/operand stay LAZY
// (a mux): folding them into one wire would make γ demand every arm's port.
describe("W-6 — case / and / or muxes: γ arm == eager arm, both drivers", () => {
  const SOURCES = (sel: number, sel2: number) => ({
    "src-a": { value: () => sel },
    "src-b": { value: () => sel2 },
    "src-c": "num" as const,
    "src-d": "num" as const,
  });
  const PROGRAMS: [string, string, [number, number][]][] = [
    [
      "and (2 operands)",
      "(and (positive? (src-a)) (src-c))",
      [
        [5, 0],
        [-5, 0],
      ],
    ],
    [
      "or (2 operands)",
      "(or (positive? (src-a)) (src-c))",
      [
        [5, 0],
        [-5, 0],
      ],
    ],
    [
      "and (3 operands, lazy middle)",
      "(and (positive? (src-a)) (positive? (src-b)) (src-c))",
      [
        [5, 5],
        [5, -5],
        [-5, 5],
      ],
    ],
    [
      "or (3 operands, lazy middle)",
      "(or (positive? (src-a)) (positive? (src-b)) (src-c))",
      [
        [-5, -5],
        [-5, 5],
        [5, 0],
      ],
    ],
    // keys go through an exact-integer `if` (a recorded mint replays as an exact number, the
    // live stamped mint is inexact — `eqv?` would see them differently; the key is the point)
    [
      "case",
      "(case (if (positive? (src-a)) 1 2) ((1) (src-c)) ((2 3) (src-d)) (else 0))",
      [
        [5, 0],
        [-5, 0],
      ],
    ],
    ["case (else arm)", "(case (if (positive? (src-a)) 1 2) ((3) (src-c)) (else 0))", [[5, 0]]],
    [
      "case (else-less)",
      "(case (if (positive? (src-a)) 1 2) ((1) (src-c)))",
      [
        [5, 0],
        [-5, 0],
      ],
    ],
    [
      "case (bracket clauses)",
      "(case (if (positive? (src-a)) 1 2) [(1) (src-c)] [else 0])",
      [
        [5, 0],
        [-5, 0],
      ],
    ],
  ];

  describe.each(PROGRAMS)("%s", (_name, code, outcomes) => {
    it("builds a mux node (not one eager wire)", async () => {
      expect((await wf(code)).main.nodes.some((n) => n.kind === "mux")).toBe(true);
    });
    it.each(outcomes)("selectors %i / %i", async (sel, sel2) => {
      const run = await recordRun(inferenceEnv, code, SOURCES(sel, sel2));
      const program = await wf(code);

      const whole = await replayGraphEgress({ program, frozen: freezeMints(run.mints) });
      expect(whole.value).toEqual(run.egress);
      expect([...run.registry.opsOf(replayedCone(whole.boxed))].sort()).toEqual(
        [...run.registry.opsOf(run.eagerCone)].sort(),
      );

      const gen = walkGraphReplay({ program, frozen: freezeMints(run.mints) });
      let res = await gen.next();
      while (!res.done) res = await gen.next();
      expect(res.value.value).toEqual(run.egress);
      expect([...run.registry.opsOf(replayedCone(res.value.boxed))].sort()).toEqual(
        [...run.registry.opsOf(run.eagerCone)].sort(),
      );
    });
  });

  it("a pure-operand and/or and a pure-key case still collapse (no mux, no regression)", async () => {
    expect((await wf("(and (positive? x) y)")).main.nodes.some((n) => n.kind === "mux")).toBe(false);
    expect((await wf("(case x ((1) y) (else 0))")).main.nodes.some((n) => n.kind === "mux")).toBe(false);
  });
});
