/**
 * End-to-end proof the harness machinery runs: one value row, one both-throw
 * row, one user-error row (the compiled-side `error()` shim), and one
 * divergence-by-design stub (the RATIO exact-overflow split, spec §4.3). The
 * REAL corpus (~24 bug cells + sidecars) is a separate deliverable that builds
 * against these interfaces — this file only proves the machinery.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupOracleScratch,
  openOracleSession,
  runCorpusCase,
  runOracle,
  type OracleSession,
} from "../index.js";

describe("oracle harness smoke", () => {
  let session: OracleSession;

  beforeAll(async () => {
    session = await openOracleSession();
  }, 60_000);

  afterAll(async () => {
    await session.dispose();
    cleanupOracleScratch();
  }, 30_000);

  it("value row: (+ 1 2) agrees at plain number 3", { timeout: 30_000 }, async () => {
    const verdict = await runOracle(session, "(+ 1 2)");
    expect(verdict.interpreter).toEqual({ kind: "value", value: 3 });
    expect(verdict.compiled).toEqual({ kind: "value", value: 3 });
    expect(verdict.agree).toBe(true);
  });

  it("both-throw row: unbound variable classifies identically", { timeout: 30_000 }, async () => {
    const verdict = await runOracle(session, "(zzz-unbound 1)");
    expect(verdict.interpreter.kind).toBe("throw");
    expect(verdict.compiled.kind).toBe("throw");
    if (verdict.interpreter.kind === "throw") expect(verdict.interpreter.errorClass).toBe("unbound-variable");
    if (verdict.compiled.kind === "throw") expect(verdict.compiled.errorClass).toBe("unbound-variable");
    expect(verdict.agree).toBe(true);
  });

  it('user-error row: (error "boom") throws user-error on BOTH sides (compiled via the shim)', { timeout: 30_000 }, async () => {
    const verdict = await runOracle(session, '(error "boom")');
    expect(verdict.interpreter).toMatchObject({ kind: "throw", errorClass: "user-error" });
    expect(verdict.compiled).toMatchObject({ kind: "throw", errorClass: "user-error" });
    expect(verdict.agree).toBe(true);
  });

  it("divergent stub: exact overflow splits by design (interpreter throws, compiled floats)", { timeout: 30_000 }, async () => {
    const verdict = await runCorpusCase(session, "(* 94906266 94906266)", {
      divergent: {
        interpreter: { errorClass: "exact-overflow" },
        // The identical plain-JS product — computed HERE on the same V8, so the
        // expectation can never drift from the artifact's own float behavior.
        compiled: { value: 94906266 * 94906266 },
      },
    });
    expect(verdict.failures).toEqual([]);
    expect(verdict.pass).toBe(true);
  });

  it("three-way corpus row: (+ 1 2) with { value: 3 } passes all checks", { timeout: 30_000 }, async () => {
    const verdict = await runCorpusCase(session, "(+ 1 2)", { value: 3 });
    expect(verdict.failures).toEqual([]);
    expect(verdict.pass).toBe(true);
  });
});
