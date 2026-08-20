/**
 * Product compileSource — always names SchemeSemanticModel (organ 1).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  compileSource,
  greenfieldRegistryFor,
  type OracleSession,
  SchemeSemanticModel,
} from "../index.js";
import { openRunnerOracleSession } from "./runner-plane.js";

describe("compileSource (product API)", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openRunnerOracleSession();
  }, 120_000);
  afterAll(async () => {
    await session.dispose();
  });

  it("returns code and a SchemeSemanticModel over the same source", async () => {
    const source = `(define (greet name) (string-append "hi " name))\n(greet "x")`;
    const { code, model } = await compileSource(source, { registry: greenfieldRegistryFor(session) });
    expect(model).toBeInstanceOf(SchemeSemanticModel);
    expect(model.source).toBe(source);
    // Program face: a default export the program-face guard can call.
    expect(code).toMatch(/export default/);
  });

  it("is deterministic under a fixed registry", async () => {
    const source = `(define x 1)\n(+ x 1)`;
    const registry = greenfieldRegistryFor(session);
    const a = await compileSource(source, { registry });
    const b = await compileSource(source, { registry });
    expect(a.code).toBe(b.code);
  });

  it("refuses to assemble a session without registry or capabilities", async () => {
    await expect(compileSource("(+ 1 2)", {})).rejects.toThrow(/does not default a product plane/);
  });
});
