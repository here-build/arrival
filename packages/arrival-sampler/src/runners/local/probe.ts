// probe.ts — reusable probe for inspecting what the model wants at a given point and how it branches.
//
// Used for analysis of strategic behavior under the substrate. 
//
// We keep asking this: at a given prefix (prompt + partial output), what is the model's distribution, and
// what does greedy decoding do next? (the fence-language check, the failure-point walk, "what does glm want
// after `(call`"). This wraps the generator's existing per-step EXPLAIN tap (the same one that feeds
// `--log-omitted`) into one call: run a short constrained decode from `prefill`, and return the per-step
// {@link StepExplain} stream — step 0 is the distribution AT the point, steps 1.. are the BRANCH.
//
// Σ choice is the CALLER'S: pass `makeOracle(grantEnv)` to see the bound-symbol surface, or `makeOracle()`
// for structural-only. probe.ts stays oracle-import-free so it's a pure decode utility.

import type { OracleScanner } from "../../oracle-types.js";
import type { StepExplain } from "../../step-explain.js";
import type { LlamaModelHandle } from "./llama-cpp-generate.js";
import { llamaCppGenerator } from "./llama-cpp-generate.js";

export interface ProbePoint {
  /** The user/task prompt. */
  readonly prompt: string;
  /** Optional system prompt (the domain framing). */
  readonly systemPrompt?: string;
  /** The prefix UP TO the decode point — what the model has "already generated" (e.g. `"(call"`). The
   *  distribution returned at step 0 is the model's next-token distribution right AFTER this. */
  readonly prefill?: string;
  /** How many greedy steps to continue past the point — the BRANCH (where the model goes). Default 12. */
  readonly branchSteps?: number;
  /** Top-K tokens to surface per step. Default 24. */
  readonly topK?: number;
  /** The oracle — the caller's choice of surface: `makeOracle(grantEnv)` (Σ over the real bindings) or
   *  `makeOracle()` (structural-only). The decode is lightly constrained by it so the explain classifies. */
  readonly scanner: OracleScanner;
}

export interface ProbeResult {
  /** Per-step explain. `steps[0]` is the distribution AT the point (after `prefill`); `steps[1..]` the branch. */
  readonly steps: StepExplain[];
  /** The greedy continuation text from the point. */
  readonly text: string;
}

/** Probe a (already-loaded) model at one decode point. Frees only its own sequence — the handle stays live
 *  for the next probe (so a caller can probe several points / several prefills on one load). */
export async function probeModel(handle: LlamaModelHandle, point: ProbePoint): Promise<ProbeResult> {
  const steps: StepExplain[] = [];
  const gen = llamaCppGenerator(handle, {
    onExplain: (e) => steps.push(e),
    explainTopK: point.topK ?? 24,
  });
  try {
    const text = await gen.generate(point.prompt, {
      constrained: true,
      scanner: point.scanner,
      maxNewTokens: point.branchSteps ?? 12,
      ...(point.systemPrompt !== undefined ? { systemPrompt: point.systemPrompt } : {}),
      ...(point.prefill !== undefined ? { prefill: point.prefill } : {}),
    });
    return { steps, text };
  } finally {
    await gen.disposeSequence();
  }
}

/** One readable line per step: what was picked (+ how deep the constraint reached, `rank`), a peek at the
 *  untested `tail`, and the masked-but-wanted tokens — each with its veto REASON (the catalog RuleId, or base
 *  `structural`/`sigma`). The omitted list IS the over-masking signal and the per-rule attribution. */
export function formatStep(s: StepExplain): string {
  const masked = s.omitted
    .slice(0, 8)
    .map((o) => `${JSON.stringify(o.token)}@${o.probability.toFixed(2)}/${o.reason}`)
    .join("  ");
  const tail = s.tail ? `  tail=${JSON.stringify(s.tail.token)}@${s.tail.probability.toFixed(2)}` : "";
  const head = `  step${s.index} rank=${s.rank} picked=${JSON.stringify(s.chosen.token)}@${s.chosen.probability.toFixed(2)}${tail}`;
  return head + (masked ? `\n     omitted(wanted): ${masked}` : "");
}
