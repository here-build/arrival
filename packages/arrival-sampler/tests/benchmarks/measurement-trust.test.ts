// measurement-trust.test.ts — STAGE 0 of the naming-scheme A/B pipeline: qualify the METRIC before
// optimizing against it. Produces three numbers that gate everything downstream:
//
//   1. A/A test — two independent sampled runs of the SAME scheme, scored per-task, fed to the paired
//      A/B gate. It MUST come back inconclusive. If the gate "finds" a winner between identical arms,
//      the harness manufactures false differences and no A/B result can be trusted.
//   2. Gage R&R — fix each scheme, re-measure it REPEATS times under independent sampling, and
//      decompose the per-scheme mean-correctness variance into between-scheme (the signal we want to
//      resolve) vs run-to-run (measurement noise). %R&R = noise / total. Six-Sigma rule of thumb:
//      <10% good, >30% the gauge cannot resolve the differences we're chasing → reduce noise (more
//      tasks, lower τ, majority-vote) before any optimization. (operator=seed, part=scheme.)
//   3. pass^k — per scheme, the reliability curve over REPEATS trials (right-on-average vs consistent).
//
// This is a BENCHMARK (it emits numbers to compare, not a pass/fail gate on model quality), node-only
// (node-llama-cpp), opt-in via `pnpm benchmarks`. Sampling τ>0 is the whole point — it is the noise
// source A/A and Gage R&R decompose; every emitted program is still oracle-valid by construction.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { makeOracle } from "@inhuman.tools/arrival/oracle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TASKS } from "../../src/runners/fixtures/apple-intents/tasks.js";
import { runAndScore } from "../harness/score.js";
import { abVerdict } from "../research/ab-stats.js";
import { buildNamespacedApplePrompt, makeNamespacedDeviceSim, type Scheme } from "../../src/runners/apple-namespaced.js";
import { gageRR } from "../research/gage-rr.js";
import { llamaCppGenerator, LlamaModelHandle } from "../../src/runners/local/llama-cpp-generate.js";
import { passAtK } from "../../src/sampling.js";

const GGUF_PATH = fileURLToPath(new URL("../../src/../../src/models/EssentialAI_rnj-1-instruct-Q4_K_M.gguf", import.meta.url));

const SCHEMES = (process.env.MT_SCHEMES ?? "bdei,die,bang").split(",") as Scheme[];
const REPEATS = Number(process.env.MT_REPEATS ?? 3);
const TEMP = Number(process.env.MT_TEMP ?? 0.7);
const MAX_TASKS = Number(process.env.MT_MAX_TASKS ?? 0); // 0 = all
const TASK_SET = MAX_TASKS > 0 ? TASKS.slice(0, MAX_TASKS) : TASKS;

// G2 noise-reduction lever — majority-vote-of-k (self-consistency). For each (scheme, task, repeat) we
// sample VOTE_K programs at the SAME τ and reduce them to one correctness by majority vote. This shrinks
// run-to-run variance WITHOUT touching τ. VOTE_K=1 (default) is byte-for-byte identical to the prior
// harness: one draw, no reduction.
//
// Why NOT lower τ as the lever: τ=0 → greedy → deterministic → run-to-run var → 0 → %R&R → 0 TRIVIALLY,
// but the gauge would no longer measure the product's actual sampling distribution (the noise we ship).
// Majority-vote keeps τ fixed, so the thing we qualify is still the thing we ship.
const VOTE_K = Math.max(1, Number(process.env.MT_VOTE_K ?? 1));

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const variance = (xs: number[]): number => {
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
};

describe("Stage 0 — measurement trust (Rnj-1, llama.cpp/Metal)", () => {
  let handle: LlamaModelHandle;

  beforeAll(async () => {
    handle = await LlamaModelHandle.load(GGUF_PATH);
  }, 120_000);

  afterAll(async () => {
    await handle?.context.dispose?.();
  });

  it("A/A is inconclusive; Gage R&R %R&R + pass^k reported", async () => {
    // ONE generator instance: a single seeded rng advances across every (scheme, repeat, task), so
    // repeats are independent draws from one reproducible stream — and we touch the single KV lane once.
    const gen = llamaCppGenerator(handle, { temperature: TEMP, seed: 0xa_11_ab });

    // runs[scheme][repeat] = per-task 0/1 correctness vector.
    const runs: Record<string, number[][]> = {};

    for (const scheme of SCHEMES) {
      const sim = await makeNamespacedDeviceSim(scheme);
      const scanner = makeOracle(sim.grant);
      const systemPrompt = buildNamespacedApplePrompt(scheme);
      runs[scheme] = [];
      for (let r = 0; r < REPEATS; r++) {
        const perTask: number[] = [];
        for (const task of TASK_SET) {
          // Sample VOTE_K programs at the same τ; each scored to a 0/1, reduced by majority vote
          // (> half correct → 1). VOTE_K=1 collapses to a single draw — identical to before.
          let votes = 0;
          for (let v = 0; v < VOTE_K; v++) {
            const program = await gen.generate(task.prompt, {
              constrained: true,
              scanner,
              systemPrompt,
              prefill: "(",
              maxNewTokens: 96,
            });
            const res = await runAndScore(program, task, sim);
            votes += res.category === "ok" ? 1 : 0;
          }
          perTask.push(votes > VOTE_K / 2 ? 1 : 0);
        }
        runs[scheme].push(perTask);
      }
    }

    // ── A/A: two independent runs of the FIRST scheme, paired per task → must be inconclusive ──────
    const aa = SCHEMES[0];
    const aaVerdict = abVerdict(runs[aa][0], runs[aa][1], { seed: 0xaa });

    // ── Gage R&R: per-scheme mean-correctness per repeat; between-scheme vs run-to-run variance ────
    // The decomposition + the pair-separability rule live in the pure `gageRR` (unit-tested model-free).
    const schemeRepeatMeans: Record<string, number[]> = {};
    for (const scheme of SCHEMES) schemeRepeatMeans[scheme] = runs[scheme].map(mean);
    const rr = gageRR(schemeRepeatMeans);
    const betweenVar = rr.betweenVar; // signal: spread of scheme means
    const withinVar = rr.runToRunVar; // noise: run-to-run
    const pctRR = rr.percentRR; // %R&R (variance fraction)

    // ── pass^k per scheme (per task: successes over REPEATS → pass^1 and pass^REPEATS, task-averaged)
    const passK: Record<string, { p1: number; pK: number }> = {};
    for (const scheme of SCHEMES) {
      const nTasks = TASK_SET.length;
      const succ = (t: number): number => runs[scheme].reduce((s, run) => s + run[t], 0);
      const p1 = mean(Array.from({ length: nTasks }, (_, t) => passAtK(succ(t), REPEATS, 1)));
      const pK = mean(Array.from({ length: nTasks }, (_, t) => passAtK(succ(t), REPEATS, REPEATS)));
      passK[scheme] = { p1, pK };
    }

    // ── Verdict + escape hatch (G2) ─────────────────────────────────────────────────────────────
    // The gauge is LICENSED for the naming-scheme A/B DOE iff %R&R<10% AND A/A came back inconclusive.
    // Otherwise the gauge is marginal/poor: fall back to the run-to-run sd rule — only scheme pairs
    // whose mean gap exceeds the pooled run-to-run sd are actionable.
    const gaugeGood = pctRR < 0.1 && !aaVerdict.significant;
    const fmtPair = (p: { a: string; b: string; delta: number }): string => `${p.a}↔${p.b} (Δ=${p.delta.toFixed(3)})`;
    const verdictLines: string[] = gaugeGood
      ? [`VERDICT: GAUGE GOOD — naming-scheme A/B DOE is statistically licensed.`]
      : [
          `VERDICT: GAUGE MARGINAL/POOR (%R&R=${(pctRR * 100).toFixed(1)}%). Escape hatch: only rankings`,
          `         separated by > the run-to-run sd (=${rr.pooledRunToRunSd.toFixed(3)}) are actionable.`,
          `  separable     : ${rr.separablePairs.length > 0 ? rr.separablePairs.map(fmtPair).join("  ") : "(none)"}`,
          `  NOT separable : ${rr.nonSeparablePairs.length > 0 ? rr.nonSeparablePairs.map(fmtPair).join("  ") : "(none)"}`,
        ];

    // ── Report ────────────────────────────────────────────────────────────────────────────────────
    const lines: string[] = [
      `\n=== Stage 0 measurement trust — Rnj-1 (Q4_K_M, llama.cpp/Metal) ===`,
      `schemes=${SCHEMES.join(",")}  repeats=${REPEATS}  τ=${TEMP}  vote-k=${VOTE_K}  tasks=${TASK_SET.length}`,
      ``,
      `A/A (${aa}, run0 vs run1): meanΔ=${aaVerdict.meanDelta.toFixed(3)} ` +
        `CI=[${aaVerdict.ci.lower.toFixed(3)},${aaVerdict.ci.upper.toFixed(3)}] p=${aaVerdict.p.toFixed(3)} ` +
        `→ ${aaVerdict.winner.toUpperCase()}  ${aaVerdict.significant ? "❌ FALSE DIFF" : "✓ inconclusive"}`,
      ``,
      `Gage R&R: between-scheme var=${betweenVar.toFixed(5)}  run-to-run var=${withinVar.toFixed(5)}  ` +
        `%R&R=${(pctRR * 100).toFixed(1)}%  ` +
        `${pctRR < 0.1 ? "✓ resolvable (<10%)" : pctRR < 0.3 ? "△ marginal (10-30%)" : "❌ NOT resolvable (>30%)"}`,
      ``,
      `per-scheme mean correctness ± run-to-run sd:`,
      ...SCHEMES.map(
        (s) =>
          `  ${s.padEnd(6)} ${mean(schemeRepeatMeans[s]).toFixed(3)} ± ${Math.sqrt(variance(schemeRepeatMeans[s])).toFixed(3)}` +
          `   pass^1=${passK[s].p1.toFixed(3)} pass^${REPEATS}=${passK[s].pK.toFixed(3)}`,
      ),
      ``,
      ...verdictLines,
    ];

    console.log(lines.join("\n"));

    // Persist the verdict to an artifact — vitest swallows console.log from passing tests, so the
    // file is the durable record (gitignored __research-output__).
    const outDir = fileURLToPath(new URL("../../src/__research-output__/", import.meta.url));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}measurement-trust.md`, `${lines.join("\n")}\n`);
    writeFileSync(
      `${outDir}measurement-trust.json`,
      JSON.stringify(
        {
          schemes: SCHEMES,
          repeats: REPEATS,
          temperature: TEMP,
          voteK: VOTE_K,
          tasks: TASK_SET.length,
          runs,
          aaVerdict,
          betweenVar,
          withinVar,
          pctRR,
          passK,
          gageRR: rr,
          gaugeGood,
          verdict: verdictLines.join("\n"),
        },
        null,
        2,
      ),
    );

    // The load-bearing assertion: the gate must NOT manufacture a winner between identical-scheme arms.
    expect(aaVerdict.significant).toBe(false);
  }, 1_800_000);
});
