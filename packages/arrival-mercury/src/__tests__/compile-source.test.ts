/**
 * Product compileSource — always names SchemeSemanticModel (organ 1).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileSource, greenfieldRegistryFor, openOracleSession, type OracleSession } from "../index.js";

describe("compileSource (product API)", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 120_000);
  afterAll(async () => {
    await session.dispose();
  });

  it("returns code and a SchemeSemanticModel over the same source", async () => {
    const source = `(define (greet name) (string-append "hi " name))\n(greet "x")`;
    const { code, model } = await compileSource(source, { registry: greenfieldRegistryFor(session) });
    expect(code.length).toBeGreaterThan(0);
    expect(model.constructor.name).toBe("SchemeSemanticModel");
    expect(model.source).toBe(source);
    // Module face / program face: some export or default present.
    expect(code).toMatch(/export|string-append|stringAppend|hi /);
  });

  it("is deterministic under a fixed registry", async () => {
    const source = `(define x 1)\n(+ x 1)`;
    const registry = greenfieldRegistryFor(session);
    const a = await compileSource(source, { registry });
    const b = await compileSource(source, { registry });
    expect(a.code).toBe(b.code);
  });
});
