import { describe, expect, it } from "vitest";
import { exec } from "../eval/generator-exec";
import { inferenceEnv } from "../inference-env";

/**
 * Heap-budget coverage for the term-delegated sequence ops.
 *
 * Why this test EXISTS: the Fantasy-Land -> arrival/tagless-final dissolution moved
 * map/filter/reduce off the metered `flCollectValues` collect-pass onto each term's
 * OWN arrival/tagless-final method, which walks the spine/array DIRECTLY (bypassing
 * `to_array`, the only other charge point). That silently dropped the per-run
 * allocation bound on a NATIVE sequence pass — the exact un-TICKed O(K^2)-churn case
 * the heap budget exists to catch, which the wall-clock budget cannot preempt. NO test
 * installed a meter on these paths, so the regression was invisible to a green suite
 * (feedback-live-verify-is-the-gate: a green unit suite is necessary, not sufficient).
 * `chargeSequenceHeap` (env/fl-interop.ts) restores the charge at the env-layer dispatch.
 *
 * These run through the INFERENCE env (where the fl-interop overlay map/filter/reduce
 * live) — a plain exec defaults to user_env's base ops, which still meter via to_array
 * and would pass for the wrong reason.
 */

// A quoted list literal of n integers. A literal is read once and `quote` returns the
// datum on eval — it is NOT re-materialized through to_array or the dispatch, so building
// it charges NOTHING (proven by the "bare literal" control below). A vector literal is
// self-evaluating, same property.
const lit = (n: number) => `'(${Array.from({ length: n }, (_, i) => i).join(" ")})`;
const vlit = (n: number) => `#(${Array.from({ length: n }, (_, i) => i).join(" ")})`;
const run = (code: string, heapBudget: number) =>
  exec(code, { env: inferenceEnv.inherit("heap-seq"), heapBudget });

describe("heap budget — term-delegated sequence ops charge the per-run allocation meter", () => {
  it("(map …) over a large list trips a tight budget", async () => {
    await expect(run(`(map (lambda (x) x) ${lit(500)})`, 100)).rejects.toThrow(/heap budget exceeded/);
  });

  it("(filter …) over a large list trips a tight budget", async () => {
    await expect(run(`(filter (lambda (x) #t) ${lit(500)})`, 100)).rejects.toThrow(/heap budget exceeded/);
  });

  it("(reduce …) over a large list trips a tight budget (element-first fn)", async () => {
    await expect(run(`(reduce (lambda (x acc) acc) 0 ${lit(500)})`, 100)).rejects.toThrow(
      /heap budget exceeded/,
    );
  });

  it("(map …) over a large VECTOR trips too — AVector charges by __vector__.length", async () => {
    await expect(run(`(map (lambda (x) x) ${vlit(500)})`, 100)).rejects.toThrow(/heap budget exceeded/);
  });

  it("the bare list literal does NOT trip the same tight budget — so the trips above are the OP's charge", async () => {
    // Same 500-element literal, same 100 budget, no sequence op: stays under budget,
    // proving construction is free and the charge above comes from map/filter/reduce.
    await expect(run(`(begin ${lit(500)} #t)`, 100)).resolves.toBeDefined();
  });

  it("a small map stays well under a generous budget (no false positive)", async () => {
    await expect(run(`(map (lambda (x) x) ${lit(3)})`, 1000)).resolves.toBeDefined();
  });
});
