/**
 * Multi-source runtime imports: stage0 + ramda.
 */
import { describe, expect, it } from "vitest";

import { materializeImports } from "../naming/imports.js";
import { render } from "../residual/render.js";
import { Binding, Call, ConstDecl, FnDecl, Lit, Ref, RuntimeRef, type CompilationUnit } from "../residual/types.js";
import { RAMDA_DIVERGENCES, RUNTIME_MANIFEST } from "../runtime/runtime-manifest.js";

describe("runtime-manifest", () => {
  it("routes length/car/cdr to ramda and keeps error/map on stage0", () => {
    expect(RUNTIME_MANIFEST["length"]?.source).toBe("ramda");
    expect(RUNTIME_MANIFEST["car"]?.source).toBe("ramda");
    expect(RUNTIME_MANIFEST["car"]?.imported).toBe("head");
    expect(RUNTIME_MANIFEST["max-by"]?.source).toBe("stage0");
    expect(RUNTIME_MANIFEST["map"]?.source).toBe("stage0");
    expect(RUNTIME_MANIFEST["error"]?.source).toBe("stage0");
  });

  it("documents ramda divergences for length/car/cdr", () => {
    const symbols = new Set(RAMDA_DIVERGENCES.map((d) => d.symbol));
    expect(symbols.has("length")).toBe(true);
    expect(symbols.has("car")).toBe(true);
  });

  it("materializeImports emits ramda then stage0 Import decls", () => {
    const pick = Binding("pick");
    const unit: CompilationUnit = {
      decls: [ConstDecl(pick, RuntimeRef("car"))],
      body: [Call(RuntimeRef("length"), [Lit(0)])],
    };
    // length on a lit is silly but exercises two sources
    const out = materializeImports(
      {
        decls: unit.decls,
        body: [Call(RuntimeRef("error"), [Lit("x")])],
      },
      {
        symbols: new Set(["car", "error"]),
        runtimeModule: "./stage0.mts",
      },
    );
    const code = render(out);
    expect(code).toContain('import { head as car } from "ramda"');
    expect(code).toContain('import { error } from "./stage0.mts"');
    // ramda import appears before stage0
    expect(code.indexOf("ramda")).toBeLessThan(code.indexOf("stage0.mts"));
  });
});
