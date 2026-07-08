/**
 * exec-seam.bench.test.ts — the survivor of `evaluator-benchmark.spec.ts`
 * (docs/test-suite-v2/REMOVAL-MANIFEST.md §A).
 *
 * The old file measured a "LIPS (promise-based)" side against a "Generator (flat
 * trampoline)" side and reported a "speedup" between them. That comparison was fiction:
 * `docs/test-invariant-atlas/verdicts/common-type-layer.md` traced both sides to the SAME
 * generator evaluator (`eval/evaluator.ts`'s `exec`/`run`) — the "LIPS" label survived only
 * because `eval/generator-exec.ts`'s public `exec()` re-exports it, a naming fossil from
 * before the `lips` handle was retired (0849de566b). What the old numbers actually measured
 * was the cost of the PUBLIC EXEC SEAM — string parse, `Resolver`/`Capabilities` assembly,
 * `RunContext` minting — layered on top of one evaluator, not two evaluators racing.
 *
 * This file measures that seam honestly, as three nested costs for the SAME expression
 * `(+ 1 2 3 4 5)`, each isolating one more layer:
 *
 *   1. `exec(source)`      — the full public seam: string→AST parse + a FRESH Resolver/
 *                            Capabilities assembly + a fresh RunContext, every call.
 *   2. `execExpr(ast, {env})` — pre-parsed AST (parse cost removed), but still a fresh
 *                            Resolver + RunContext per call (glass path over a reused env).
 *   3. `run(evaluate(ast, {resolver, runCtx}))` — pre-parsed AST AND a resolver/runCtx
 *                            built ONCE outside the loop — the bare trampoline, no seam
 *                            machinery re-assembled per call.
 *
 * (2) minus (1) is the parse cost; (1) minus (3) is the total seam overhead (parse +
 * assembly + minting); (2) minus (3) is the assembly+minting cost alone with parse
 * removed. No "speedup" is claimed anywhere — these are three honest measurements of one
 * pipeline, not a race between implementations.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { exec, execExpr, parse } from "../eval/generator-exec.js";
import run, { evaluate } from "../eval/evaluator.js";
import { Resolver } from "../eval/Resolver.js";
import { makeRunContext } from "../values/primitives/RunContext.js";
import { freshEnv } from "../__tests__/_fresh-env.js";
import type { Environment } from "../Environment.js";
import type { SchemeValue } from "../values/types.js";

const SOURCE = "(+ 1 2 3 4 5)";
const ITERATIONS = 2000;

function report(label: string, iterations: number, elapsedMs: number): void {
  console.log(
    `${label}: ${iterations} calls in ${elapsedMs.toFixed(2)}ms ` +
      `(${((iterations / elapsedMs) * 1000).toFixed(0)} ops/sec, ${(elapsedMs / iterations).toFixed(4)}ms/call)`,
  );
}

describe("exec seam overhead — one evaluator, three measurement layers", () => {
  let env: Environment;
  let ast: SchemeValue;

  beforeAll(async () => {
    env = await freshEnv();
    const parsed = await parse(SOURCE);
    ast = parsed[0];
  });

  it("layer 1 — exec(source): full seam, parse + assembly + minting, every call", async () => {
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const [result] = await exec(SOURCE, { env });
      expect(result).toBe(15);
    }
    report("exec(source)", ITERATIONS, performance.now() - start);
  });

  it("layer 2 — execExpr(pre-parsed ast): assembly + minting only, parse removed", async () => {
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const result = await execExpr(ast, { env });
      expect(result.valueOf()).toBe(15);
    }
    report("execExpr(ast)", ITERATIONS, performance.now() - start);
  });

  it("layer 3 — run(evaluate(ast)): bare trampoline, resolver + runCtx built ONCE outside the loop", async () => {
    const resolver = new Resolver(env);
    const runCtx = makeRunContext({});
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const result = await run(evaluate(ast, { resolver, runCtx }));
      expect((result as { valueOf(): unknown }).valueOf()).toBe(15);
    }
    report("run(evaluate(ast))", ITERATIONS, performance.now() - start);
  });

  it("deeply nested expression, layer 1 vs layer 3 (same shape as the old file's nested-expr case)", async () => {
    let code = "(+ 1 0)";
    for (let i = 0; i < 100; i++) code = `(+ 1 ${code})`;
    const nestedAst = (await parse(code))[0];

    const fullSeamStart = performance.now();
    for (let i = 0; i < 100; i++) {
      const [result] = await exec(code, { env });
      expect(result).toBe(101);
    }
    report("exec(source) — 100-level nesting", 100, performance.now() - fullSeamStart);

    const resolver = new Resolver(env);
    const runCtx = makeRunContext({});
    const bareStart = performance.now();
    for (let i = 0; i < 100; i++) {
      const result = await run(evaluate(nestedAst, { resolver, runCtx }));
      expect((result as { valueOf(): unknown }).valueOf()).toBe(101);
    }
    report("run(evaluate(ast)) — 100-level nesting", 100, performance.now() - bareStart);
  });
});
