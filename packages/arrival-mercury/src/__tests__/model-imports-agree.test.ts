/**
 * E0's compiler-view stratum (engine plan §2 E0; model.ts's own header): unit
 * coverage for `sm.narrowsMembers` / `sm.registryRow` / `sm.factsAt` /
 * `sm.factsMap`, plus the PINNING AGREEMENT between `sm.importsOf` (the
 * recursive, pre-render decision-view) and the ACTUAL EMITTED IMPORTS — the
 * proof that E1b's cut-over (imports emitted FROM the model, via
 * `naming/imports.ts`'s `materializeImports`, killing the `frame` post-pass
 * entirely) was a mechanical no-op over today's corpus, never a behavior
 * change.
 *
 * Pre-E1b this described "frame's actual post-render census
 * (`runtimeRefsOf(walk(...))`)"; `frame/` is now deleted. The ground truth
 * this suite pins against is `runtimeRefsOf` run directly over an
 * INDEPENDENT whole-program walk (never fed by `sm.importsOf` — that would
 * make the check circular), then materialized for real through
 * `materializeImports` — so the comparison exercises the actual E1b emission
 * code path, not just the symbol-discovery step it replaced.
 *
 * Also carries S5's dependency-rule lint in its minimal, "start small, grow
 * per phase" form (engine plan §1 S5): a static check that `model.ts` never
 * imports anything shaped like emitted output (the renderer).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClassifyResult } from "../coreform/types.js";
import { SchemeSemanticModel } from "../model/model.js";
import { MULTI_SLOT, TWO_CROSSINGS } from "../model/__fixtures__.js";
import { materializeImports } from "../naming/index.js";
import { openOracleSession, type OracleSession } from "../oracle/harness.js";
import { peephole } from "../peepholes/index.js";
import type { EmitRegistry } from "../registry/harvest.js";
import { emitRegistryOf } from "../registry/index.js";
import { phase1Rules, withRules } from "../rules/index.js";
import { STAGE0 } from "../runtime/stage0.js";
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

  describe("importsOf agrees with the EMITTED imports (the E1b pinning proof — frame is dissolved)", () => {
    const FIXTURES = { TWO_CROSSINGS, MULTI_SLOT };
    const RUNTIME_MODULE = "./stage0.mts"; // matches oracle/harness.ts's own staged specifier

    /**
     * The new ground truth: an INDEPENDENT whole-program walk (never fed by
     * `sm.importsOf` — that would make the comparison circular), censused by
     * the SAME `runtimeRefsOf` the dissolved `frame` used to read, then
     * materialized for real through `materializeImports` — the actual E1b
     * emission code path. Returns the manifest EXPORTED names (`ImportName
     * .imported`), so the caller must map `sm.importsOf`'s scheme-symbol
     * answer through the SAME manifest before comparing (see the two `it`s
     * below) — the two sides are scheme-symbol-named vs. JS-export-named by
     * construction, not an oversight.
     */
    const emittedImportsOf = (source: string): string[] => {
      const sm = new SchemeSemanticModel(source, registry);
      const walked = walk(sm.coreform, { registry, facts: sm.factsMap(), register: "run" });
      const wholeProgramCensus = runtimeRefsOf(walked);
      const materialized = materializeImports(walked, { symbols: wholeProgramCensus, runtimeModule: RUNTIME_MODULE });
      const importDecl = materialized.decls[0];
      if (importDecl?.t !== "Import") {
        throw new Error("expected materializeImports to prepend an Import decl as decls[0]");
      }
      return importDecl.names.map((n) => n.imported);
    };

    for (const [name, source] of Object.entries(FIXTURES)) {
      it(`${name}: manifest-mapped sm.importsOf === materializeImports's actual emitted import names`, () => {
        const sm = new SchemeSemanticModel(source, registry);

        // The model's answer: the recursive view, per top-level form, unioned
        // (exactly how a materializer would ask "what does this program need"
        // once files split per-artifact, E4) — scheme-symbol-named.
        const viaModel = new Set<string>();
        for (const form of sm.coreform.forms) for (const s of sm.importsOf(form)) viaModel.add(s);
        const viaModelExported = [...viaModel].map((s) => STAGE0[s]).filter((v): v is string => v !== undefined);

        expect(viaModelExported.sort()).toEqual([...emittedImportsOf(source)].sort());
      });
    }

    it("TWO_CROSSINGS: the emitted imports are exactly {infer, stringAppend} (car needs no shim)", () => {
      const sm = new SchemeSemanticModel(TWO_CROSSINGS, registry);
      const viaModel = new Set<string>();
      for (const form of sm.coreform.forms) for (const s of sm.importsOf(form)) viaModel.add(s);
      expect([...viaModel].sort()).toEqual(["infer", "string-append"]);
      expect(emittedImportsOf(TWO_CROSSINGS).sort()).toEqual(["infer", "stringAppend"]);
    });

    it("the PEEPHOLE fold: importsOf must be queried over the PEEPHOLED forms (the E1b call-site rule)", () => {
      // Regression pin for the bug the E1b cut-over surfaced live: peephole is
      // the one eager pre-walk rewrite that MOVES the symbol census —
      // `(car (infer …))` folds to `infer/scalar` — so a consumer querying
      // `sm.importsOf` over the PRE-peephole forms answers `infer` for a tree
      // that references `RuntimeRef("infer/scalar")` (importsOf's documented
      // limit 2, model.ts; `materializeImports` fail-closes on the mismatch).
      // `compileGreenfield` queries over the peepholed forms; this row pins
      // that discipline at the unit level, per-form union vs whole-walk.
      const source = `(define (f m p) (car (infer m p)))\n(f "gpt" "q")`;
      const sm = new SchemeSemanticModel(source, registry);
      const peepholed = peephole(sm.coreform);

      const viaModel = new Set<string>();
      for (const form of peepholed.forms) for (const s of sm.importsOf(form)) viaModel.add(s);
      expect([...viaModel]).toContain("infer/scalar"); // the folded symbol, not bare `infer`
      expect([...viaModel]).not.toContain("infer");

      const walked = walk(peepholed, { registry, facts: sm.factsMap(), register: "run" });
      expect([...viaModel].sort()).toEqual([...runtimeRefsOf(walked)].sort());

      const materialized = materializeImports(walked, { symbols: viaModel, runtimeModule: RUNTIME_MODULE });
      const importDecl = materialized.decls[0];
      if (importDecl?.t !== "Import") throw new Error("expected an Import decl at decls[0]");
      expect(importDecl.names.map((n) => n.imported)).toContain("inferScalar");
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
