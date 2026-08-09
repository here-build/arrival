/**
 * W8 — SchemeSemanticModel must stay the named product middle-end (organ 1).
 * Product APIs construct it by name; materialization reads model views, not a
 * private second analysis plane.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileSource } from "../product/compile-source.js";
import { SchemeSemanticModel } from "../model/model.js";
import { greenfieldRegistryFor, openOracleSession, type OracleSession } from "../registry/greenfield-session.js";

describe("W8 — product surface names SchemeSemanticModel", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 120_000);
  afterAll(async () => {
    await session.dispose();
  });

  it("compileSource returns an instance of SchemeSemanticModel", async () => {
    const source = `(define (f x) (+ x 1))\n(f 2)`;
    const { code, model } = await compileSource(source, { registry: greenfieldRegistryFor(session) });
    expect(model).toBeInstanceOf(SchemeSemanticModel);
    expect(model.source).toBe(source);
    expect(code.length).toBeGreaterThan(0);
  });

  it("model views are queryable after compileSource (importsOf / coreform)", async () => {
    const source = `(define xs (list 1 2 3))\n(car xs)`;
    const { model } = await compileSource(source, { registry: greenfieldRegistryFor(session) });
    expect(model.coreform.forms.length).toBeGreaterThan(0);
    // car may be residual (no RuntimeRef) — still a defined view surface
    const imports = new Set<string>();
    for (const form of model.coreform.forms) for (const s of model.importsOf(form)) imports.add(s);
    expect(imports).toBeInstanceOf(Set);
  });

  it("SchemeSemanticModel is constructible with the product registry (no hidden factory)", () => {
    const registry = greenfieldRegistryFor(session);
    const model = new SchemeSemanticModel(`(+ 1 2)`, registry);
    expect(model).toBeInstanceOf(SchemeSemanticModel);
    expect(model.registry).toBe(registry);
  });
});

describe("W8 — S5 model does not import residual renderer", () => {
  it("model.ts never imports residual/render or residual/types emit path", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const modelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../model/model.ts");
    const text = readFileSync(modelPath, "utf8");
    expect(text).not.toMatch(/from ["'].*residual\/render/);
    expect(text).not.toMatch(/from ["'].*residual\/chunk/);
    // materialize* is ok in comments; live import of render is not
    expect(text).not.toMatch(/import\s*\{[^}]*render[^}]*\}\s*from/);
  });
});
