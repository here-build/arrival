/**
 * exec-seam.bench.test.ts — the survivor of `evaluator-benchmark.spec.ts`
 * (retired in the 2026-07-09 suite consolidation).
 *
 * The old file measured a "LIPS (promise-based)" side against a "Generator (flat
 * trampoline)" side and reported a "speedup" between them. That comparison was fiction:
 * both sides trace to the SAME
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
import { Capabilities } from "../eval/Capabilities.js";
import { user_env } from "../env-roots.js";
import { makeRunContext } from "../values/primitives/RunContext.js";
import { freshEnv } from "../__tests__/_fresh-env.js";
import type { AmbientRuntime } from "../AmbientRuntime.js";
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
  let env: AmbientRuntime;
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

  // ── THE CUT PATH (ENV T2, docs/working-proposals/environment-resolution-chain.md §2) ──
  // The layers above run GLASS ({ env }): the resolver wraps the custom env's live
  // `__parent__` walk, which the compiled resolution chain deliberately does not touch.
  // The chain's promised win is the DEFAULT (cut) path — `Capabilities.assembled(user_env)`
  // — where zero live resolvers must compile to ONE flat Map.get. These two layers
  // measure that seam: the full default exec, and the bare capability lookup itself.

  it("layer 1-cut — exec(source) DEFAULT path: assembled base (the compiled-chain seam)", async () => {
    await exec(SOURCE); // warm the realm bootstrap outside the measured loop
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const [result] = await exec(SOURCE);
      expect(result).toBe(15);
    }
    report("exec(source) — default/cut", ITERATIONS, performance.now() - start);
  });

  it("layer 0-cut — Capabilities.assembled(user_env).lookup: the raw capability-half lookup", async () => {
    await exec(SOURCE); // bootstrap
    const caps = Capabilities.assembled(user_env);
    // Mixed workload: a base-leaf hit (`cons`, owned on user_env), a root hit (`+`,
    // owned on global_env), and a guaranteed miss (undefined) — the three lookup outcomes.
    const NAMES = ["+", "cons", "definitely-unbound-benchmark-name"] as const;
    const LOOKUPS = 199_998; // divisible by 3 — exact ⅔ hit count below
    const start = performance.now();
    let hits = 0;
    for (let i = 0; i < LOOKUPS; i++) {
      if (caps.lookup(NAMES[i % 3]) !== undefined) hits++;
    }
    const elapsed = performance.now() - start;
    expect(hits).toBe((LOOKUPS / 3) * 2);
    report("capabilities.lookup (÷3 hit/hit/miss)", LOOKUPS, elapsed);
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
