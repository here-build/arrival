// runner-benchmark — llama.cpp-Metal (GPU) throughput on the 14 apple-intent tasks, constrained.
//
// THE MEASUREMENT: per task, wall-clock + tokens/sec, the produced program, and the StepMetric
// distribution — for the gguf backend under the JS oracle constraint (isCandidateLive). The headline is
// backend THROUGHPUT (decode tok/s, prefill/decode split) and the oracle overrule pattern.
//
// Per `.claude/rules/tests.md` this is `__benchmarks__/`: a perf measurement, opt-in (`pnpm
// benchmarks`), never in default CI. It writes a report to `__research-output__/runner-benchmark.md`.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeOracle } from "@inhuman.tools/arrival/oracle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeDeviceSim } from "../../src/runners/fixtures/apple-intents/sim.js";
import { TASKS } from "../../src/runners/fixtures/apple-intents/tasks.js";
import { resolveGguf } from "../../src/runners/gguf/lmstudio.js";
import { runAndScore, type Category } from "../harness/score.js";
import { llamaCppGenerator, LlamaModelHandle, type StepMetric } from "../../src/runners/local/llama-cpp-generate.js";
import type { OracleScanner } from "../../src/oracle-types.js";
import type { SchemeGenerator } from "../../src/runners/generate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GGUF_PATH = resolveGguf("essentialai/rnj-1"); // LM Studio source of truth (null ⇒ not downloaded)
const OUT_DIR = path.join(here, "__research-output__");

interface BackendRun {
  readonly label: string;
  readonly perTask: TaskTiming[];
  readonly totalMs: number;
  readonly totalGenTokens: number;
  readonly systemPromptTokens?: number;
  readonly overruledSteps?: number;
  /** Prefill vs decode split (llama path only; the onnx generate() doesn't expose it). */
  readonly prefillMs?: number;
  readonly decodeMs?: number;
}

interface TaskTiming {
  readonly taskId: string;
  readonly prompt: string;
  readonly program: string;
  readonly category: Category;
  readonly ms: number;
  readonly genTokens: number;
  readonly steps: StepMetric[];
}

let SCANNER: OracleScanner;

beforeAll(async () => {
  const probe = await makeDeviceSim();
  SCANNER = makeOracle(probe.grant);
});

/** Drive one generator over all 14 tasks, constrained, scoring each. `tapSteps` collects StepMetrics
 *  (only the llama backend exposes the onStep tap; the onnx run leaves it empty). */
async function runBackend(
  label: string,
  gen: SchemeGenerator,
  collectedSteps: Map<string, StepMetric[]>,
): Promise<BackendRun> {
  const perTask: TaskTiming[] = [];
  let totalMs = 0;
  let totalGenTokens = 0;

  for (const task of TASKS) {
    const sim = await makeDeviceSim();
    const t0 = performance.now();
    const program = await gen.generate(task.prompt, { constrained: true, scanner: SCANNER, maxNewTokens: 96 });
    const ms = performance.now() - t0;
    const scored = await runAndScore(program, task, sim);
    // Read the step tap AFTER generation (the map entry is populated during gen.generate).
    const steps = collectedSteps.get(task.id) ?? [];
    const genTokens = steps.length > 0 ? steps.length : estimateTokens(program);
    totalMs += ms;
    totalGenTokens += genTokens;
    perTask.push({ taskId: task.id, prompt: task.prompt, program, category: scored.category, ms, genTokens, steps });
  }

  const tel = (
    gen as {
      telemetry?: { systemPromptTokens: number; overruledSteps: number; prefillMs: number; decodeMs: number };
    }
  ).telemetry;
  return {
    label,
    perTask,
    totalMs,
    totalGenTokens,
    systemPromptTokens: tel?.systemPromptTokens,
    overruledSteps: tel?.overruledSteps,
    prefillMs: tel?.prefillMs,
    decodeMs: tel?.decodeMs,
  };
}

/** Rough token count when no StepMetric tap is available (onnx path) — chars/4, a stable proxy for the
 *  tokens/sec denominator. The llama path uses real step counts. */
function estimateTokens(program: string): number {
  return Math.max(1, Math.round(program.length / 4));
}

const runs: BackendRun[] = [];

describe("runner benchmark: llama.cpp-Metal vs onnx-CPU (constrained, 14 apple tasks)", () => {
  it("llama.cpp-Metal (Rnj-1 Q4_K_M)", async () => {
    if (GGUF_PATH === null) {
      console.warn("[benchmark] rnj-1 GGUF not present in LM Studio; skipping llama.cpp run. Download it there first.");
      return;
    }
    const handle = await LlamaModelHandle.load(GGUF_PATH, 2048);
    const stepsByTask = new Map<string, StepMetric[]>();
    let currentTask = "";
    const gen = llamaCppGenerator(handle, {
      onStep: (m) => {
        const arr = stepsByTask.get(currentTask) ?? [];
        arr.push(m);
        stepsByTask.set(currentTask, arr);
      },
    });
    // Wrap generate to track the current task id for the step tap.
    const tracking: SchemeGenerator = {
      ...gen,
      generate: (prompt, opts) => {
        currentTask = TASKS.find((t) => t.prompt === prompt)?.id ?? prompt;
        return gen.generate(prompt, opts);
      },
    };
    runs.push(await runBackend("llama.cpp-Metal (Rnj-1 8B Q4_K_M)", tracking, stepsByTask));
    await gen.dispose?.();
  }, 1_200_000);
});

afterAll(() => {
  if (runs.length === 0) return;
  mkdirSync(OUT_DIR, { recursive: true });
  const md = renderReport(runs);
  writeFileSync(path.join(OUT_DIR, "runner-benchmark.md"), md, "utf8");

  console.log(`\n${md}`);

  // A soft assertion: the gguf run produced throughput (the headline number is the report itself).
  const llama = runs.find((r) => r.label.startsWith("llama.cpp"));
  if (llama) expect(llama.totalGenTokens, "the llama.cpp run generated tokens").toBeGreaterThan(0);
});

function tps(run: BackendRun): number {
  return run.totalGenTokens / (run.totalMs / 1000);
}

function renderReport(backendRuns: BackendRun[]): string {
  const lines: string[] = [
    "# Runner Benchmark — llama.cpp-Metal throughput\n",
    "Constrained decoding (the JS oracle `isCandidateLive`) over the 14 apple-intent tasks, gguf/Metal.\n",

    "## Summary\n",
    "`decode tok/s` excludes the per-task prefill re-pay (the KV state is cleared between tasks), so it is " +
      "the honest backend decode throughput. `wall tok/s` is total tokens over total wall (prefill + decode + oracle).\n",
    "| backend | total wall (s) | gen tokens | wall tok/s | decode tok/s | prefill ms | decode ms | sys-prompt toks | oracle overrules |",
    "|---|---|---|---|---|---|---|---|---|",
  ];

  for (const r of backendRuns) {
    const decodeTps = r.decodeMs && r.decodeMs > 0 ? r.totalGenTokens / (r.decodeMs / 1000) : undefined;
    lines.push(
      `| ${r.label} | ${(r.totalMs / 1000).toFixed(2)} | ${r.totalGenTokens} | ${tps(r).toFixed(2)} | ` +
        `${decodeTps ? decodeTps.toFixed(2) : "—"} | ${r.prefillMs ? r.prefillMs.toFixed(0) : "—"} | ` +
        `${r.decodeMs ? r.decodeMs.toFixed(0) : "—"} | ${r.systemPromptTokens ?? "—"} | ${r.overruledSteps ?? "—"} |`,
    );
  }
  const llama = backendRuns.find((r) => r.label.startsWith("llama.cpp"));

  for (const r of backendRuns) {
    lines.push(
      `\n## ${r.label} — per task\n`,
      "| task | category | ms | gen tokens | program |",
      "|---|---|---|---|---|",
    );
    for (const t of r.perTask) {
      const prog = t.program.replaceAll("|", String.raw`\|`).slice(0, 80);
      lines.push(`| ${t.taskId} | ${t.category} | ${t.ms.toFixed(0)} | ${t.genTokens} | \`${prog}\` |`);
    }
  }

  // StepMetric distribution (llama path only — the tap is on that backend).
  if (llama) {
    const allSteps = llama.perTask.flatMap((t) => t.steps);
    if (allSteps.length > 0) {
      const overruled = allSteps.filter((s) => s.preferKind === "infeasible").length;
      const avgIters = allSteps.reduce((a, s) => a + s.iterationsUntilFeasible, 0) / allSteps.length;
      const avgPreferProb = allSteps.reduce((a, s) => a + s.preferProb, 0) / allSteps.length;
      const avgMargin = allSteps.reduce((a, s) => a + s.top2Margin, 0) / allSteps.length;
      lines.push(
        "\n## StepMetric distribution (llama.cpp path)\n",
        `- steps recorded: ${allSteps.length}`,
        `- oracle overruled the model (preferKind=infeasible): ${overruled} ` +
          `(${((100 * overruled) / allSteps.length).toFixed(1)}%)`,
        `- avg iterationsUntilFeasible: ${avgIters.toFixed(2)}`,
        `- avg preferProb (unconstrained-argmax confidence): ${avgPreferProb.toFixed(3)}`,
        `- avg top2Margin (prob gap, NOT logit margin): ${avgMargin.toFixed(3)}`,
      );
    }
  }

  lines.push("\n_Generated by `pnpm benchmarks` (src/__benchmarks__/runner-benchmark.test.ts)._\n");
  return lines.join("\n");
}
