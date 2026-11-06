/**
 * Regression suite for repo-wide provenance & wireframe failure points (Cluster 1 & Cluster 3):
 *   1.1 `EvalTrace.onSymbolResolved` collapses container provenance for list / vector / dict bindings
 *   1.2 `ADict["arrival/provenanceChildren"]` enables `collapseProvenance` & `deepProvenance` over dicts
 *   1.3 `applyCallback` & `applyArrowProc` preserve `CallCtx` (`currentInvocation`, `closureCall`, capability config/resources)
 *   1.4 `apply` wraps spread arguments with `wrapLambdaArgs` for provenance-point lambdas
 *   1.5 `computeProvenance` unions `inv.id` with input provenance on point-marked `cond`/`case`/`update`/`update-in`
 *   3.1 `freeVars` handles internal `define` in body forms and multi-body `try`
 *   3.2 `freeVars` and `builder.walkQuasi` traverse `AVector`, `ADict`, and dotted-tail unquotes inside quasiquotes
 *   3.3 `buildWireframe`, `unboundSlots`, and replay preserve variadic `rest` on top-level `define` and `fan` lambdas
 *   3.4 `buildWireframe`, `unboundSlots`, and replay thread `captures` for top-level function `define`s referencing value `define`s
 */
import { describe, expect, it } from "vitest";
import { z as zod } from "zod";
import { EnvCapability } from "../../common/capability.js";
import { BASE_ROSTER } from "../../env/base-roster.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { execState, parse } from "../../eval/generator-exec.js";
import { toJS } from "../../membrane/rosetta.js";
import { collapseProvenance } from "../provenance-collapse.js";
import { deepProvenance } from "../deep-provenance.js";
import { EvalTrace } from "../trace.js";
import type { Classifier, DeclaredRole } from "../lineage.js";
import { buildWireframe } from "../wireframe/builder.js";
import { freeVars } from "../wireframe/free-vars.js";
import { unboundSlots } from "../wireframe/validate.js";
import { replayGraphEgress, replayProgramWithPlayback } from "../replay.js";
import { recordRun, playbackOf, recordWireframe } from "../../__tests__/provenance/q16-harness.js";
import { CORPUS_BASE_NAMES, CORPUS_ROLES } from "../../__tests__/provenance/w1-corpus.js";
import { ADict } from "../../values/primitives/ADict.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AString } from "../../values/primitives/AString.js";

const stamped = (s: string, ...points: number[]) => new AString(s, new Set(points));
const sorted = (set: ReadonlySet<number>) => [...set].sort((a, b) => a - b);

const ROLES: Record<string, DeclaredRole> = {
  ...CORPUS_ROLES,
  "src-a": "source",
  "src-b": "source",
  "fetch-item": "source",
  "emit!": "sink",
  map: "fan",
  filter: "fan",
};
const C: Classifier = { roleOf: (op) => ROLES[op] };
const isBaseName = (n: string): boolean => CORPUS_BASE_NAMES.has(n);

const CFG = { prefix: "cfg:" };

function makeTrackedCaps(name: string): readonly EnvCapability[] {
  const cap = EnvCapability.define(`test/${name}`, {
    configuration: { prefix: zod.string() },
    resources: () => ({ tag: "res:" }),
    symbols: (symbol, z) => ({
      "fetch-item": symbol.rosetta`fetch-item: string source`(
        { input: [z.string], output: [z.string], provenance: "source" },
        function (x: string) {
          const cfg = this.configuration as { prefix?: string } | undefined;
          const res = this.resources as { tag?: string } | undefined;
          const p = cfg?.prefix ?? "";
          const r = res?.tag ?? "";
          return `${p}${r}${x}`;
        },
      ),
    }),
  });
  return [cap, ...BASE_ROSTER];
}

describe("Cluster 1 — Core evaluator & trace provenance retention", () => {
  it("1.1 & 1.2: ADict implements arrival/provenanceChildren; collapseProvenance and deepProvenance walk dict entries", () => {
    const dict = new ADict([
      [new ASymbol(":a"), stamped("alpha", 10)],
      [new ASymbol(":b"), stamped("beta", 20)],
    ]);
    // Container's own shallow provenance stays empty (preserving the grouping-fact law),
    // while collapseProvenance and deepProvenance collect entry provenance.
    expect(dict.provenance.size).toBe(0);
    expect(sorted(collapseProvenance(dict))).toEqual([10, 20]);
    expect(sorted(deepProvenance(dict))).toEqual([10, 20]);
  });

  it("1.1: EvalTrace.onSymbolResolved records element provenance when resolving list, vector, and dict symbols", async () => {
    const capabilities = makeTrackedCaps("sym-resolved-containers");
    const trace = new EvalTrace();
    const code = `
      (let ((xs (list (fetch-item "a")))
            (vec [(fetch-item "b")])
            (d {:k (fetch-item "c")}))
        (list (car xs) (vector-ref vec 0) (:k d)))
    `;
    const state = await execState(code, { capabilities, tap: trace, eagerStamps: true, config: CFG });
    expect(toJS(state.values[0])).toEqual(["cfg:res:a", "cfg:res:b", "cfg:res:c"]);

    const points = [...trace.points()];
    expect(points).toHaveLength(3);
    const pointIds = points.map((p) => p.id).sort((a, b) => a - b);

    // The inner `(list (car xs) (vector-ref vec 0) (:k d))` resolved `xs`, `vec`, and `d`:
    // its children (`(car xs)`, `(vector-ref vec 0)`, `(:k d)`) must each receive symbolContributions
    // from the container bindings even though `list`, `[...]`, and `{...}` have empty top-level `.provenance`.
    const allContribs = new Set<number>();
    for (const cur of trace.invocationLog) {
      if (!cur.symbolContributions) continue;
      for (const contribSet of cur.symbolContributions) {
        for (const id of contribSet) allContribs.add(id);
      }
    }
    expect(sorted(allContribs)).toEqual(pointIds);
  });

  it("1.3: HOF callbacks (map, filter, find, reduce) preserve capability configuration/resources and provenance", async () => {
    const capabilities = makeTrackedCaps("hof-callbacks");
    const trace = new EvalTrace();
    const [res] = (
      await execState(`(map fetch-item (list "x" "y"))`, {
        capabilities,
        tap: trace,
        eagerStamps: true,
        config: CFG,
      })
    ).values;
    expect(toJS(res)).toEqual(["cfg:res:x", "cfg:res:y"]);
    expect(sorted(deepProvenance(res))).toHaveLength(1);
  });

  it("1.4: (apply fn args) wraps spread arguments with wrapLambdaArgs so provenance-point lambdas stamp outputs", async () => {
    const capabilities = makeTrackedCaps("apply-wrap-lambda");
    const trace = new EvalTrace();
    const code = `
      (let ((item (fetch-item "seed"))
            (wrap (lambda (x) (string-append "wrapped:" x))))
        (apply wrap (list item)))
    `;
    const [res] = (await execState(code, { capabilities, tap: trace, eagerStamps: true, config: CFG })).values;
    expect(toJS(res)).toBe("wrapped:cfg:res:seed");
    const points = [...trace.points()];
    expect(points.length).toBeGreaterThanOrEqual(1);
    expect(sorted(deepProvenance(res))).toContain(points[0]!.id);
  });

  it("1.5: point-marked cond => and update/update-in union own invocation ID with input provenance", async () => {
    const capabilities = makeTrackedCaps("cond-arrow-and-update");
    const trace = new EvalTrace();
    const code = `
      (let ((u (update-in {:a (fetch-item "v")} '(:a) (lambda (old) (fetch-item old))))
            (c (cond ((fetch-item "test") => fetch-item))))
        (list (:a u) c))
    `;
    const [res] = (await execState(code, { capabilities, tap: trace, eagerStamps: true, config: CFG })).values;
    expect(toJS(res)).toEqual(["cfg:res:cfg:res:v", "cfg:res:cfg:res:test"]);
    const allProvs = sorted(deepProvenance(res));
    // Both upstream and callback provenance points are retained
    expect(allProvs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Cluster 3 — Wireframe free-vars, builder, validator, and replay", () => {
  it("3.1: freeVars treats internal (define ...) in lambda/let bodies as bound and walks multi-body (try ...)", async () => {
    const [lamForm] = await parse(`
      (lambda (x)
        (define (helper y) (+ y z))
        (define local-val (helper x))
        local-val)
    `);
    expect([...freeVars(lamForm!)].sort()).toEqual(["+", "z"]);

    const [tryForm] = await parse(`
      (try
        (emit! first-free)
        (+ second-free 1)
        (catch (e) (handle-err e)))
    `);
    const tryFvs = freeVars(tryForm!);
    expect(tryFvs.has("first-free")).toBe(true);
    expect(tryFvs.has("second-free")).toBe(true);
    expect(tryFvs.has("handle-err")).toBe(true);
    expect(tryFvs.has("e")).toBe(false);
  });

  it("3.2: freeVars and buildWireframe walk unquotes inside quasiquoted vectors, dicts, and dotted tails", async () => {
    const [qqForm] = await parse("`[,vec-var {:k ,dict-var} (head . ,tail-var)]");
    expect([...freeVars(qqForm!)].sort()).toEqual(["dict-var", "tail-var", "vec-var"]);

    const forms = await parse(`(let ((x "v")) \`[,(src-a) {:k ,(src-b)} (h . ,(fetch-item x))])`);
    const prog = buildWireframe(forms, { classifier: C, isBaseName });
    expect(unboundSlots(prog)).toEqual([]);
    const sourceOps = prog.main.nodes
      .filter((n) => n.kind === "source")
      .map((n) => (n as { op: string }).op)
      .sort();
    expect(sourceOps).toEqual(["fetch-item", "src-a", "src-b"]);
  });

  it("3.3: variadic top-level define and variadic fan lambda pass unboundSlots validation and replay cleanly", async () => {
    const code = `
      (define (tag-all prefix . items)
        (cons (src-a prefix) items))
      (tag-all "p" "a" "b")
    `;
    const sources = { "src-a": "str" } as const;
    const wfOpts = recordWireframe(sources);
    const forms = await parse(code);
    const prog = buildWireframe(forms, wfOpts);
    expect(unboundSlots(prog)).toEqual([]);
    expect(prog.templates.get("tag-all")?.params).toEqual(["prefix"]);
    expect(prog.templates.get("tag-all")?.rest).toBe("items");

    const run = await recordRun(inferenceEnv, code, sources);
    const replayed = await replayGraphEgress({ program: prog, frozen: run.frozen });
    expect(replayed.value).toEqual(run.egress);
    const playedBack = await replayProgramWithPlayback({
      source: code,
      playback: playbackOf(run),
      wireframe: wfOpts,
    });
    expect(playedBack.value).toEqual(run.egress);
  });

  it("3.4: top-level function define capturing top-level value define wires capture:<name> and replays", async () => {
    const code = `
      (define shared (src-a "init"))
      (define (enrich x) (list shared (src-b x)))
      (enrich "item")
    `;
    const sources = { "src-a": "str", "src-b": "str" } as const;
    const wfOpts = recordWireframe(sources);
    const forms = await parse(code);
    const prog = buildWireframe(forms, wfOpts);
    expect(unboundSlots(prog)).toEqual([]);
    expect(prog.templates.get("enrich")?.captures).toEqual(["shared"]);

    const run = await recordRun(inferenceEnv, code, sources);
    const replayed = await replayGraphEgress({ program: prog, frozen: run.frozen });
    expect(replayed.value).toEqual(run.egress);
    const playedBack = await replayProgramWithPlayback({
      source: code,
      playback: playbackOf(run),
      wireframe: wfOpts,
    });
    expect(playedBack.value).toEqual(run.egress);
  });
});
