/**
 * Multi-source runtime imports + loose emit contract.
 */
import { describe, expect, it } from "vitest";

import { materializeImports } from "../naming/imports.js";
import { render } from "../residual/render.js";
import { Call, Lit, RuntimeRef } from "../residual/types.js";
import { RAMDA_DIVERGENCES, RUNTIME_MANIFEST } from "../runtime/runtime-manifest.js";

describe("runtime-manifest (loose emit)", () => {
  it("routes length to ramda; car/cdr/error/map stay stage0", () => {
    expect(RUNTIME_MANIFEST["length"]?.source).toBe("ramda");
    expect(RUNTIME_MANIFEST["car"]?.source).toBe("stage0");
    expect(RUNTIME_MANIFEST["cdr"]?.source).toBe("stage0");
    expect(RUNTIME_MANIFEST["max-by"]?.source).toBe("stage0");
    expect(RUNTIME_MANIFEST["map"]?.source).toBe("stage0");
    expect(RUNTIME_MANIFEST["error"]?.source).toBe("stage0");
  });

  it("documents length as loose-friendly ramda", () => {
    const symbols = new Set(RAMDA_DIVERGENCES.map((d) => d.symbol));
    expect(symbols.has("length")).toBe(true);
  });

  it("materializeImports emits the ramda and stage0 Import decls", () => {
    const out = materializeImports(
      {
        decls: [],
        body: [Call(RuntimeRef("length"), [Lit(0)]), Call(RuntimeRef("error"), [Lit("x")])],
      },
      {
        symbols: new Set(["length", "error"]),
        runtimeModule: "./stage0.mts",
      },
    );
    const code = render(out);
    expect(code).toContain('import { length as length_ } from "ramda"');
    expect(code).toContain('import { error } from "./stage0.mts"');
  });
});
