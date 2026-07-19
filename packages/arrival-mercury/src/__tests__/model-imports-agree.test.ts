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
import type { EmitRegistry } from "../registry/harvest.js";
import { emitRegistryOf } from "../registry/index.js";
import { phase1Rules, withRules } from "../rules/index.js";
import { STAGE0 } from "../runtime/runtime-manifest.js";
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

    it("the IDIOM fold: importsOf agrees over the ORIGINAL forms — the E1b call-site rule DISSOLVES at E2", () => {
      // Regression pin, FLIPPED at E2 (engine plan §2 E2, second half): a
      // separate `peephole()` pre-walk pass used to MOVE the symbol census —
      // `(car (infer …))` folds to `infer/scalar` — so E1b's own caller-side
      // discipline was "query `sm.importsOf` over the PEEPHOLED forms, never
      // the model's own `sm.coreform` forms" (importsOf's then-documented
      // limit 2, model.ts). That pass is GONE: folding now happens INSIDE
      // `sm.idiomAt`, consulted inline by BOTH the real walk (`walk()`'s
      // `lowerApp`) and `importsOf`'s own synthetic walk
      // (`model.ts`'s `computeImportsOf`, which passes `idiomAt: this.idiomAt`
      // too) — so querying over `sm.coreform`'s ORIGINAL, un-folded forms
      // already agrees with the emitted imports. This row now pins the
      // DISSOLUTION: the workaround this test used to require no longer
      // exists, and the naive (original-forms) query is simply correct.
      const source = `(define (f m p) (car (infer m p)))\n(f "gpt" "q")`;
      const sm = new SchemeSemanticModel(source, registry);

      const viaModel = new Set<string>();
      for (const form of sm.coreform.forms) for (const s of sm.importsOf(form)) viaModel.add(s);
      expect([...viaModel]).toContain("infer/scalar"); // the folded symbol, not bare `infer`
      expect([...viaModel]).not.toContain("infer");

      const walked = walk(sm.coreform, { registry, facts: sm.factsMap(), idiomAt: sm.idiomAt, register: "run" });
      expect([...viaModel].sort()).toEqual([...runtimeRefsOf(walked)].sort());

      const materialized = materializeImports(walked, { symbols: viaModel, runtimeModule: RUNTIME_MODULE });
      const importDecl = materialized.decls[0];
      if (importDecl?.t !== "Import") throw new Error("expected an Import decl at decls[0]");
      expect(importDecl.names.map((n) => n.imported)).toContain("inferScalar");
    });
  });
});

describe("S5 — the dependency-rule lint (engine plan §1 S5; extended at E1's exit gate, §2)", () => {
  it("model.ts's own import specifiers never point at emitted output (the renderer)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../model/model.ts", import.meta.url), "utf8");
    const specifiers = [...src.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
    expect(specifiers.length, "sanity: the file must actually have import statements to check").toBeGreaterThan(0);
    const EMITTED_OUTPUT = /residual\/render(\.js)?$/;
    const offenders = specifiers.filter((s) => EMITTED_OUTPUT.test(s));
    expect(offenders, "a view may not read emitted output (the renderer) — S5's stratification law").toEqual([]);
  });

  /**
   * E1 exit gate (engine plan §2, "E1 exit gate"): "the emitted-output path
   * contains zero post-passes — pipeline is `model views → materialize
   * (census → allocate → emit) → format`. The paradigm's causality property
   * holds mechanically (S5's lint extended: no pass may take emitted output
   * as input)." Grown from the model-only check above to every module that
   * feeds the greenfield pipeline (views AND the passes that materialize
   * them) — none may import the renderer, because none may take rendered
   * TEXT as an input to a further decision.
   */
  it("no view or pass module (model + naming + walker + legibility + peepholes + lowering + shake) reads emitted output", async () => {
    const fs = await import("node:fs/promises");
    const MODULES = [
      "../model/model.ts",
      "../naming/asyncness.ts",
      "../naming/census.ts",
      "../naming/allocate.ts",
      "../naming/materialize.ts",
      "../naming/imports.ts",
      "../naming/origin.ts",
      "../naming/shared-bindings.ts",
      "../walker/walk.ts",
      "../legibility/tree.ts",
      "../peepholes/index.ts",
      "../peepholes/infer.ts",
      "../lowering/index.ts",
      "../shake/index.ts",
    ] as const;
    const EMITTED_OUTPUT = /residual\/render(\.js)?$/;
    let filesChecked = 0;
    for (const rel of MODULES) {
      const src = await fs.readFile(new URL(rel, import.meta.url), "utf8");
      filesChecked++;
      const specifiers = [...src.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
      const offenders = specifiers.filter((s) => EMITTED_OUTPUT.test(s));
      expect(offenders, `${rel}: no pass may take emitted output (the renderer) as input — E1 exit gate`).toEqual([]);
    }
    expect(filesChecked, "sanity: the module list above must not have silently shrunk to nothing").toBe(MODULES.length);
  });

  /**
   * The other half of the exit gate — a source-level structural check over
   * `oracle/harness.ts`'s own pipeline chain (the plan's own concession:
   * "a source-level test over harness.ts's chain is acceptable and
   * honest"). Proves `render(...)` is the LAST transformation
   * `compileGreenfield` performs: nothing — no further pass, no
   * re-materialization — follows its `return render(...)` statement.
   */
  it("compileGreenfield's pipeline chain ends at render() — zero post-passes after materialize/format", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../oracle/harness.ts", import.meta.url), "utf8");
    const fnStart = src.indexOf("export function compileGreenfield(");
    expect(fnStart, "sanity: compileGreenfield must exist in harness.ts").toBeGreaterThan(-1);
    const rest = src.slice(fnStart);
    // The function's OWN closing brace: a bare `}` at column 0 (every nested
    // block inside compileGreenfield is indented at least 2 spaces).
    const fnEnd = rest.indexOf("\n}\n");
    expect(fnEnd, "sanity: could not find compileGreenfield's own closing brace").toBeGreaterThan(-1);
    const body = rest.slice(0, fnEnd);
    const returnIdx = body.indexOf("return render(");
    expect(returnIdx, "compileGreenfield must end by returning render(...) — the pipeline's format step").toBeGreaterThan(-1);
    const afterReturnKeyword = body.slice(returnIdx);
    const semicolonIdx = afterReturnKeyword.indexOf(";");
    expect(semicolonIdx, "sanity: the return render(...) statement must be semicolon-terminated").toBeGreaterThan(-1);
    const trailing = afterReturnKeyword.slice(semicolonIdx + 1).trim();
    expect(
      trailing,
      "nothing may follow the render(...) return — it must be the pipeline's LAST statement (no post-pass)",
    ).toBe("");
  });

  // ── E3's extension: no EMITTER branches on semantics (engine plan §2 E3) ──
  //
  // "The walker/materializer becomes a pure reader; if an emitter branches on
  // semantics anywhere, S5's lint fails it." Operationalized as strictly as is
  // honest (the plan's own concession): a SOURCE-SCAN test over walk.ts's own
  // text, comments stripped first (feedback-comments-are-the-drift-origin.md
  // — a doc comment mentioning "registry.lookup" in prose must never count as
  // an offense). Two mechanical, achievable checks; anything this coarse a
  // scan cannot honestly assert (e.g. "no rule/naming module calls
  // registry.lookup either") stays a convention, not a lint, per the plan's
  // own "pin the achievable subset" clause.

  /** Strip `/* … *\/` and `// …` comments — good enough for this package's own
   *  code style (no string literal in this file contains a bare `//`); never
   *  claimed as a general-purpose TS/JS comment stripper. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("walk.ts's own CODE (comments stripped) never calls registry.lookup(...) directly — the §4.2 ladder is loweringDecisionAt's decision", async () => {
    const fs = await import("node:fs/promises");
    const src = stripComments(await fs.readFile(new URL("../walker/walk.ts", import.meta.url), "utf8"));
    const offenders = [...src.matchAll(/\b\w+\.lookup\s*\(/g)].map((m) => m[0]);
    expect(offenders, "walk.ts must not read the registry directly — the ladder relocated to ../lowering/index.ts").toEqual([]);
  });

  it("walk.ts's own CODE (comments stripped) reads TypeFacts through exactly ONE named accessor, never a second facts.get(...) call site", async () => {
    const fs = await import("node:fs/promises");
    const src = stripComments(await fs.readFile(new URL("../walker/walk.ts", import.meta.url), "utf8"));
    const hits = [...src.matchAll(/\bfacts\.get\s*\(/g)];
    expect(hits.length, "exactly one facts.get(...) call site is allowed: the factsAt(id) wrapper's own definition").toBe(1);
  });

  it("walk.ts actually IMPORTS the relocated decision views (a positive check — renaming the calls away would satisfy the two greps above without ever consulting the view)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../walker/walk.ts", import.meta.url), "utf8");
    expect(src).toMatch(/from\s+["']\.\.\/lowering\/index\.js["']/);
    expect(src).toContain("loweringDecisionAt");
    expect(src).toContain("guardFormOf");
  });
});
