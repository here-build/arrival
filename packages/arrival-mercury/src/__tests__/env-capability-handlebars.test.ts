/**
 * Reference example: opt-in EnvCapability package → mercury compile.
 *
 * `arrival-env-capability-handlebars` owns the handlebars dep + Contract.emit +
 * `/runtime` surface. Mercury's RUNTIME_MANIFEST maps RuntimeRefs to that package.
 * A `.hbs` file is pretreat→scheme (import executable), then ordinary scm compile.
 */
import { describe, expect, it } from "vitest";

import { arrivalHandlebarsCapability, hbsContentsToSchemeSource } from "@inhuman.tools/arrival-env-capability-handlebars";

import { compileHbsFile } from "../build/hbs-module.js";
import { greenfieldRegistryFor, openOracleSession } from "../oracle/harness.js";
import { emitRegistryOf } from "../registry/harvest.js";
import type { EmitRegistry } from "../registry/harvest.js";
import { withRules } from "../rules/overlay.js";

describe("arrival-env-capability-handlebars × mercury (reference)", () => {
  it("hbsContentsToSchemeSource is the CALLABLE RULE pretreat", () => {
    expect(hbsContentsToSchemeSource("Hi {{name}}")).toContain("template/handlebars");
    // Fixed-first lambda (not bare-symbol variadic) so mercury classify can lower it.
    expect(hbsContentsToSchemeSource("Hi {{name}}")).toMatch(/^\(lambda \(arg \. rest\) /);
  });

  it("harvest exposes template/handlebars with emit", () => {
    const reg = emitRegistryOf([arrivalHandlebarsCapability]);
    const row = reg.lookup("template/handlebars");
    expect(row).toBeDefined();
    expect(row?.emit).toBeDefined();
  });

  it("compileHbsFile emits import from the package /runtime + default program face", async () => {
    await using session = await openOracleSession();
    const ambient = greenfieldRegistryFor(session);
    // Static harvest fill-in (same pattern as srfi-1 in greenfieldRegistryFor):
    // ambient wins; handlebars package fills names the ambient may not yet carry
    // after the capability move (or when testing the package in isolation).
    const hbsReg = emitRegistryOf([arrivalHandlebarsCapability]);
    const merged: EmitRegistry = {
      lookup: (name) => ambient.lookup(name) ?? hbsReg.lookup(name),
      names: new Set([...ambient.names, ...hbsReg.names]),
    };
    const baseRegistry = withRules(merged, {});

    const compiled = compileHbsFile(
      "Hello {{name}}!",
      { baseRegistry },
      { path: "greet.hbs", runtimeImportPath: "./stage0.ts" },
    );

    expect(compiled.shape.defaultFace).toBe("function");
    expect(compiled.content).toContain("@inhuman.tools/arrival-env-capability-handlebars/runtime");
    expect(compiled.content).toContain("templateHandlebars");
    expect(compiled.content).toContain("Hello {{name}}!");
    expect(compiled.content).toMatch(/export default (async )?function/);
  });
});
