/**
 * E0's compiler-view stratum (engine plan §2 E0; model.ts's own header): unit
 * coverage for `sm.narrowsMembers` / `sm.registryRow` / `sm.factsAt` /
 * `sm.factsMap`, plus the PINNING AGREEMENT between `sm.importsOf` (the
 * recursive, pre-render decision-view) and `frame`'s actual post-render
 * census (`runtimeRefsOf(walk(...))`) — the proof that E1b's cut-over
 * (imports emitted FROM the model, killing the `frame` post-pass) is a
 * mechanical no-op over today's corpus, never a behavior change.
 *
 * Also carries S5's dependency-rule lint in its minimal, "start small, grow
 * per phase" form (engine plan §1 S5): a static check that `model.ts` never
 * imports anything shaped like emitted output (the renderer).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClassifyResult } from "../coreform/types.js";
import { SchemeSemanticModel } from "../model/model.js";
import { MULTI_SLOT, TWO_CROSSINGS } from "../model/__fixtures__.js";
import { openOracleSession, type OracleSession } from "../oracle/harness.js";
import type { EmitRegistry } from "../registry/harvest.js";
import { emitRegistryOf } from "../registry/index.js";
import { phase1Rules, withRules } from "../rules/index.js";
import { runtimeRefsOf, walk } from "../walker/index.js";

let session: OracleSession;
let registry: EmitRegistry;
beforeAll(async () => {
  session = await openOracleSession();
  registry = withRules(emitRegistryOf(session.ambient), phase1Rules);
}, 120_000);
afterAll(async () => {
  await session.dispose();
});

const defineFnOf = (classified: ClassifyResult, index = 0) => {
  const form = classified.forms[index];
  if (form?.kind !== "DefineFn") throw new Error(`forms[${index}] is not a DefineFn`);
  return form;
};

describe("SchemeSemanticModel — E0 compiler views", () => {
  it("narrowsMembers wraps narrowsMembersOf(registry): null? is a member, infer is not", () => {
    const sm = new SchemeSemanticModel(TWO_CROSSINGS, registry);
    expect(sm.narrowsMembers.has("null?")).toBe(true);
    expect(sm.narrowsMembers.has("infer")).toBe(false);
  });

  it("registryRow is a thin wrap over registry.lookup — same row, both surfaces", () => {
    const sm = new SchemeSemanticModel(TWO_CROSSINGS, registry);
    expect(sm.registryRow("infer")).toBe(registry.lookup("infer"));
    expect(sm.registryRow("this-symbol-does-not-exist-anywhere")).toBeUndefined();
  });

  it("factsAt proves null?'s condition boolean; absent for a node with no provable fact", () => {
    const sm = new SchemeSemanticModel(`(define (f xs) (if (null? xs) 0 (car xs)))`, registry);
    const ifNode = defineFnOf(sm.coreform).body[0];
    if (ifNode?.kind !== "If") throw new Error("expected an If as the sole body form");
    expect(sm.factsAt(ifNode.cond)).toEqual({ boolean: true });
    expect(sm.factsAt(ifNode)).toBeUndefined(); // If itself is not a QUERIED kind's own fact holder
  });

  it("factsMap is the same table factsAt reads — a direct .get(id) agrees", () => {
    const sm = new SchemeSemanticModel(`(define (f xs) (if (null? xs) 0 (car xs)))`, registry);
    const ifNode = defineFnOf(sm.coreform).body[0];
    if (ifNode?.kind !== "If") throw new Error("expected an If");
    expect(sm.factsMap().get(ifNode.cond.id)).toEqual(sm.factsAt(ifNode.cond));
  });

  it("importsOf is memoized per node identity — repeat queries return the identical Set", () => {
    const sm = new SchemeSemanticModel(TWO_CROSSINGS, registry);
    const form = sm.coreform.forms[0]!;
    expect(sm.importsOf(form)).toBe(sm.importsOf(form));
  });

  it("importsOf: a pure-only form (no registry symbol needing a shim) is empty", () => {
    const sm = new SchemeSemanticModel(`(define (add a b) (+ a b))`, registry);
    expect(sm.importsOf(sm.coreform.forms[0]!)).toEqual(new Set());
  });

  describe("importsOf agrees with frame's post-render census (the E1b pinning proof)", () => {
    const FIXTURES = { TWO_CROSSINGS, MULTI_SLOT };

    for (const [name, source] of Object.entries(FIXTURES)) {
      it(`${name}: union of per-form sm.importsOf === runtimeRefsOf(walk(whole program))`, () => {
        const sm = new SchemeSemanticModel(source, registry);

        // The model's answer: the recursive view, per top-level form, unioned
        // (exactly how a materializer would ask "what does this program need"
        // once files split per-artifact, E4).
        const viaModel = new Set<string>();
        for (const form of sm.coreform.forms) for (const s of sm.importsOf(form)) viaModel.add(s);

        // Ground truth: `frame`'s OWN census mechanism (frame/frame.ts's
        // `runtimeRefsOf`), run directly over the real whole-program walk with
        // the SAME registry/facts. Peephole/legibility/asyncIfy never add or
        // remove a RuntimeRef symbol (importsOf's doc, limit 2) — a fixed
        // point today's corpus does not exercise (no fixture nests `(car
        // (infer …))` directly; see __fixtures__.ts).
        const viaWholeProgramWalk = runtimeRefsOf(walk(sm.coreform, { registry, facts: sm.factsMap(), register: "run" }));

        expect([...viaModel].sort()).toEqual([...viaWholeProgramWalk].sort());
      });
    }

    it("TWO_CROSSINGS: the census is exactly {infer, string-append} (car needs no shim)", () => {
      const sm = new SchemeSemanticModel(TWO_CROSSINGS, registry);
      const viaModel = new Set<string>();
      for (const form of sm.coreform.forms) for (const s of sm.importsOf(form)) viaModel.add(s);
      expect([...viaModel].sort()).toEqual(["infer", "string-append"]);
    });
  });
});

describe("S5 — the dependency-rule lint (minimal; engine plan §1 S5, \"start minimal — the lint grows per phase\")", () => {
  it("model.ts's own import specifiers never point at emitted output (the renderer)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../model/model.ts", import.meta.url), "utf8");
    const specifiers = [...src.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
    expect(specifiers.length, "sanity: the file must actually have import statements to check").toBeGreaterThan(0);
    const EMITTED_OUTPUT = /residual\/render(\.js)?$/;
    const offenders = specifiers.filter((s) => EMITTED_OUTPUT.test(s));
    expect(offenders, "a view may not read emitted output (the renderer) — S5's stratification law").toEqual([]);
  });
});
