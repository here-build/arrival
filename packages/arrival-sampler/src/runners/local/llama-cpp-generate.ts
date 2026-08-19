// llama-cpp-generate.ts — node-llama-cpp + Metal backend (core of primitive 2: on-demand LLM wiring).
//
// Minimal surface for primitive 2: LlamaModelHandle + llamaCppGenerator (default: constrained greedy)
// + server-generate.ts + ModelManager + the OpenAI server surface.
//
// Advanced decode strategies (lookahead/branch/rollback) and fc-envelope are research surfaces
// behind explicit options. The default greedy path + OpenAI compat is what BFCL and basic use need.
//
// THE NON-NEGOTIABLE CONSTRAINT: this harness reads the model's FULL per-token probability
// distribution every decode step — to record metrics AND to mask with our JS oracle. The gating
// question (answered empirically, see runner-benchmark.md) is whether node-llama-cpp's low-level
// `evaluateWithMetadata(tokens, { probabilities: true })` returns the FULL vocab distribution
// (~150k for Qwen-family tokenizers) or a truncated top-N. It returns the FULL vocab (map.size ===
// the tokenizer vocab, sorted by probability descending), with NO native sampler applied. So the
// approach is viable: we get real numbers per step, run the SAME oracle, pick the constrained argmax.
//
// WHAT WE REUSE (no logic forked):
//   • buildMessages / buildSystemPrompt / extractSchemeForm — the prompt framing + scheme extraction.
//   • isCandidateLive (mask-compiler.ts) — the EXACT per-candidate liveness predicate the shipping
//     the shared kernel (structural feasibility ∩ the Σ bound-symbol gate). The constraint algorithm
//     here is the same as the reference path: top-K walk in score order → keep first feasible (greedy
//     keepN=1 = constrained argmax). Probability is a monotone transform of logits — same ordering.
//   • OracleScanner — the injected `makeOracle(grantEnv)` scanner.
//
// The decode loop: llama.cpp's low-level API hands us the full distribution every step; we apply
// the shared oracle predicate (`isCandidateLive` / `selectConstrainedStep`) and feed the chosen
// token back. The decisions are the same as the kernel reference path.
//
// This is Node-only decode runtime (node-llama-cpp is a native addon), so it lives in `src/decode/`
// and is excluded from the published browser `.` entry (see tsconfig.json `exclude`); it ships via
// `dist-server` (the `./server` subpath).

import { type ControlledEvaluateInputItem, type LlamaContextSequence, type Token } from "node-llama-cpp";
import invariant from "tiny-invariant";

import { CHAT_TEMPLATES, type ChatTemplateFamily, detectChatTemplate, renderPrompt } from "../chat-template.js";
import { type ToolCallProfile } from "../../mask-compiler.js";
import { mulberry32 } from "../../rng.js";
import { type GenerateOptions, type SchemeGenerator } from "../generate.js";
import { type StepExplain } from "../../step-explain.js";
import { LlamaDecodeBackend, makeBranchStrategy, makeLookaheadStrategy } from "./backends/index.js";
import { buildEosTokens, LlamaModelHandle } from "./backends/llama/LlamaModelHandle.js";
import type { BranchResolver, LlamaGenTelemetry } from "./backends/llama/types.js";
import { generateFcEnvelope } from "./fc-generate.js";
import { maybeOpenFence } from "./fence-preamble.js";
import { runThinkPhase } from "./think-phase.js";
import { type StepMetric } from "./pick-constrained.js";
import {
  GreedyStrategy,
  makeRollbackStrategy,
  PassthroughStrategy,
  type DecodeContext,
  type DecodeStrategy,
} from "./strategies/index.js";

// Pure modules: no node-llama-cpp runtime dep — re-exported so existing consumers (loop-parity tests,
// benchmarks) are byte-unchanged (they import from this file and continue to work).
export type { ChatTemplateFamily } from "../chat-template.js";
export { renderPrompt } from "../chat-template.js";
// `pickConstrained` + `StepMetric` now live in the neutral decision layer; re-exported so existing
// consumers (loop-parity / benchmark / misprediction tests) that import them from this file are unchanged.
export { pickConstrained, type StepMetric } from "./pick-constrained.js";
// The GGUF substrate (model handle + stop-token set) and the pure backend types now live under
// `backends/llama/`; re-exported here so this file stays the entry — consumers (server-generate, the
// benchmarks, the dist-server deep-import `mod.LlamaModelHandle.load`) import them unchanged.
export { buildEosTokens, LlamaModelHandle } from "./backends/llama/LlamaModelHandle.js";
export type { BranchCandidate, BranchResolver, LlamaGenTelemetry } from "./backends/llama/types.js";
// `probeSuccessor` (the reversible Tier-A/branch probe) now lives in the lookahead module; re-exported so
// the loop-parity test (which imports it from this file to drive its reference stepping) is unchanged.
export { probeSuccessor } from "./backends/llama/lookahead.js";

/**
 * Build a {@link SchemeGenerator} over a loaded GGUF, using node-llama-cpp + Metal. The KV state is
 * cleared between tasks (cross-task prefix reuse proved unreliable — see the generate() body), so each
 * task re-prefills the system prompt; on Metal that cost is small relative to constrained decode.
 *
 * For `constrained: true` the manual decode loop runs the SAME oracle constraint as the shipping lazy
 * processor: walk the full prob-sorted distribution, keep the first candidate that is `isCandidateLive`
 * at the current prefix (greedy keepN=1 = constrained argmax); admit EOS iff the prefix is closeable.
 * For `constrained: false` it is plain greedy argmax (the control).
 *
 * `onStep`, when given, receives a {@link StepMetric} per decode step (the metrics tap).
 */
export function llamaCppGenerator(
  handle: LlamaModelHandle,
  hooks: {
    /** Per-step metric tap (the constrained path records the same StepMetric fields as the onnx run). */
    onStep?: (m: StepMetric) => void;
    /** Per-step EXPLAIN tap — the SAME {@link StepExplain} built via {@link buildStepExplain} (used
     *  by the llama decode loop). Bucketed over the top-`explainTopK` of the prob-sorted distribution;
     *  the "logit" axis carries PROBABILITY (monotone transform of the original score axis). */
    onExplain?: (e: StepExplain) => void;
    /** How many of the prob-sorted ids to walk per step for {@link onExplain} (≤ the full vocab; the oracle
     *  is queried once per id, lazily up to the chosen token). Default 64 — enough omitted/tail context. */
    explainTopK?: number;
    /** OPT-IN non-lazy nucleus mode (forwarded to `buildStepExplain`'s `nucleusMass`): ALSO classify every
     *  candidate in the prob-mass nucleus (`StepExplain.nucleus`), not just up to `chosen`+tail. Omitted
     *  (the default) ⇒ byte-identical to today's lazy-only explain record. */
    explainNucleusMass?: number;
    /** Top-K candidates to walk per step before widening. (The full distribution is available; this only
     *  bounds oracle calls.) Default 256. */
    topK?: number;
    /** Widened K tried once when none of the top-K are feasible. */
    wideK?: number;
    /** Decode temperature over the ORACLE-FEASIBLE set. 0 (default) = greedy/deterministic (keepN:1,
     *  fast first-feasible). τ>0 samples among feasible candidates → a measurement-noise source for
     *  A/A + Gage R&R and a per-task outcome distribution for pass^k. Every emitted token is still
     *  feasible, so the program stays valid by construction regardless of τ. */
    temperature?: number;
    /** Seed for the sampling PRNG (only used when temperature>0). Vary it per trial to get independent
     *  draws (the basis of A/A and pass^k); fixed seed → reproducible run. */
    seed?: number;
    /** Cooperative stop check, polled once per decode step BEFORE the model is advanced. Returning true
     *  ends generation early (the partial prefix is returned). Lets a caller wire an AbortSignal. */
    shouldStop?: () => boolean;
    /** TAIL-PICK threshold (default 0.05) for `telemetry.tailPicks`/`tailMass` — a constrained step whose
     *  committed token had a pre-mask probability below this counts as a tail-forced (off-policy) event. */
    tailThreshold?: number;
    /** DECODE STRATEGY — policy for strategic search within the constrained substrate (oracle-enforced
     *  grammar + Σ + types). "greedy" (default) takes the first feasible token. Other strategies explore
     *  alternatives (backtrack on regret, multi-path branching, lookahead) to potentially surface better
     *  strategic choices from the LLM while the substrate guarantees validity. All are part of the system. */
    decodeStrategy?: "greedy" | "passthrough" | "lookahead" | "branch" | "rollback";
    /** Backtrack budget and theta for rollback strategy (part of the substrate's strategic search options). */
    rollbackBacktracks?: number;
    rollbackTheta?: number;
    branchResolver?: BranchResolver;
    branchBudget?: number;
    /** CHAT-TEMPLATE FAMILY for prompt rendering ({@link CHAT_TEMPLATES}). Selects the per-family chat frame
     *  the prompt is built with. When OMITTED, the family is AUTO-DETECTED from the GGUF metadata via
     *  {@link detectChatTemplate} (Qwen/ChatML template ⇒ `"chatml"`, Llama-3 template ⇒ `"llama3"`),
     *  defaulting to `"llama3"` if metadata is inconclusive — so Rnj-1 is unchanged. Set explicitly to
     *  OVERRIDE auto-detection (e.g. a roster entry declaring its family). */
    chatTemplate?: ChatTemplateFamily;
    /** OPT-IN KWARGS PROFILE (the `grammar-kwargs` mode). When present, every per-candidate liveness check
     *  in the decode loop enforces the kwargs invocation shape on top of Σ — required args POSITIONAL (forced
     *  present, in order), optional args as `:keyword value` narrowed to the profile's keyword set; a bare
     *  positional past `requiredCount` is masked. Threaded UNCHANGED into the shared {@link isCandidateLive}
     *  /`pickConstrained` predicate. Omitted (every other mode / strategy) ⇒ the loop is BYTE-IDENTICAL. */
    toolCallProfile?: ToolCallProfile;
  } = {},
): SchemeGenerator & {
  telemetry: LlamaGenTelemetry;
  reset: () => Promise<void>;
  disposeSequence: () => Promise<void>;
} {
  const { model, context, modelPath } = handle;
  const {
    onStep,
    onExplain,
    explainTopK = 64,
    explainNucleusMass,
    topK = 256,
    wideK = 1024,
    temperature = 0,
    seed = 0xc0_ff_ee,
    shouldStop,
    tailThreshold,
    decodeStrategy,
    rollbackBacktracks = 3,
    rollbackTheta = 0.25,
    branchResolver,
    branchBudget = 1,
    chatTemplate,
    toolCallProfile,
  } = hooks;
  const rng = mulberry32(seed);
  // Resolve the EFFECTIVE chat-template family ONCE (the GGUF is fixed for this generator). An explicit
  // `chatTemplate` option wins; otherwise auto-detect from the GGUF metadata. Defaults to "llama3" (so
  // Rnj-1, whose metadata reads llama3, is unchanged whether the field is set or detected).
  const family: ChatTemplateFamily = chatTemplate ?? detectChatTemplate(model);
  // Strategy selection over the substrate. "greedy" is the baseline first-feasible policy.
  const strategy: "greedy" | "passthrough" | "lookahead" | "branch" | "rollback" = decodeStrategy ?? "greedy";
  const eosTokens = buildEosTokens(model, CHAT_TEMPLATES[family].turnTerminator);

  let sequence: LlamaContextSequence | null = null;
  const telemetry: LlamaGenTelemetry = {
    systemPromptTokens: 0,
    generatedTokens: 0,
    overruledSteps: 0,
    contestedSteps: 0,
    probes: 0,
    lookaheadOverrides: 0,
    branchesOpened: 0,
    branchesPruned: 0,
    branchOverrides: 0,
    forcedSlots: 0,
    tailPicks: 0,
    tailMass: 0,
    backtracksUsed: 0,
    completionsExplored: 0,
    improvedOverGreedy: false,
    prefillMs: 0,
    decodeMs: 0,
    promptTokens: 0,
    rawDecode: "",
  };

  /** Lazily acquire the single sequence (one KV lane). */
  function seq(): LlamaContextSequence {
    sequence ??= context.getSequence();
    return sequence;
  }

  return {
    label: `llama.cpp:${modelPath.split("/").pop()}`,
    real: true,
    telemetry,

    generate: async (taskPrompt: string, opts: GenerateOptions): Promise<string> => {
      invariant(!opts.constrained || opts.scanner, "constrained generation requires a scanner");
      const scanner = opts.scanner;
      const maxNewTokens = opts.maxNewTokens ?? 96;

      // FC-envelope mode opens with the tool-call frame (the FSM force-emits `<tool_call>{"name": "…`), so
      // there is NO `(` Scheme prefill — the model is prefilled with the prompt only, then the FSM takes over.
      // EXCEPT a reasoning-budget cell (thinkBudget>0): prefill the family's `<think>` opener so the model
      // reasons first (the think phase reads up to budget, then the FSM / Scheme decode takes over).
      const reasoningBudget = (opts.thinkBudget ?? 0) > 0;
      const fcThinkOpen = opts.fcEnvelope && reasoningBudget ? CHAT_TEMPLATES[family].thinkOpen : undefined;
      // NON-FC reasoning-budget cell: a `<think>`-opening family prefills its reasoning opener INSTEAD of the
      // Scheme `(`; the think phase runs (committing `<think>…</think>` to the KV), then the Scheme prefill is
      // force-emitted into the KV (below) so the constrained walk starts at a clean `(`. Undefined ⇒ no think
      // phase (non-reasoning family or budget 0) ⇒ the prefill is the bare Scheme start, byte-identical to today.
      const nonFcThinkOpen = !opts.fcEnvelope && reasoningBudget ? CHAT_TEMPLATES[family].thinkOpen : undefined;
      // The bare Scheme start the oracle prefix begins at (`(`/`""`), DISTINCT from the prompt prefill: on a
      // non-FC reasoning cell the prompt prefills `<think>` and the Scheme `(` is force-emitted post-think.
      const schemePrefill = opts.prefill ?? "(";
      const prefillStr = opts.fcEnvelope ? (fcThinkOpen ?? "") : (nonFcThinkOpen ?? schemePrefill);
      const { systemText, tailText } = renderPrompt(taskPrompt, opts.systemPrompt, prefillStr, family);
      // specialTokens:true so the family's chat delimiters parse as the real special tokens (Llama-3's
      // `<|start_header_id|>…`, ChatML's `<|im_start|>/<|im_end|>`) — exactly as the onnx
      // apply_chat_template path does, not as literal text.
      const systemTokens = model.tokenize(systemText, true);
      const tailTokens = model.tokenize(tailText, true);
      const promptTokens = [...systemTokens, ...tailTokens];

      const s = seq();
      if (telemetry.systemPromptTokens === 0) telemetry.systemPromptTokens = systemTokens.length;
      // INPUT-token accounting (BFCL's input side): the FULL formatted prompt under this model's
      // tokenizer — system frame + user turn + assistant-open + prefill, all special-token framed. Summed
      // across tasks (one task per generateWithExplain call ⇒ that call's prompt length).
      telemetry.promptTokens += promptTokens.length;

      // Clear the sequence's KV state before each task. We MEASURED that the cross-task prefix-reuse
      // paths node-llama-cpp offers are unreliable here:
      //   • `adaptStateToTokens(promptTokens)` then `evaluate(promptTokens)` → evaluate finds nothing
      //     new and yields `done` on the first `.next()` (0 decode steps);
      //   • a partial `eraseContextTokenRanges` back to the shared system-prefix boundary → the first
      //     task ran but every subsequent task still got 0 steps (the cached leading tokens made
      //     evaluate yield `done`).
      // Both stalled tasks 2..N at `(`. A clean `clearHistory()` per task makes EVERY task generate the
      // full program (verified: 96/96/81 steps on three back-to-back tasks). So we trade the
      // shared-prefix reuse for correctness — the ~1.1k system prompt is re-prefilled per task, which on
      // Metal is cheap relative to decode. (Prefill-reuse can be revisited if a reliable node-llama-cpp
      // idiom is found; correctness first.)
      if (s.nextTokenIndex > 0) await s.clearHistory();

      // The Scheme oracle prefix: the BARE Scheme start, NOT the think opener. On a non-FC reasoning cell the
      // prompt prefilled `<think>` and the Scheme `(` is force-emitted into the KV after the think phase
      // (below), so the oracle prefix is the clean Scheme start either way. (FC ignores `prefix` — it returns
      // early.) On a non-reasoning cell `schemePrefill === prefillStr`, so this is byte-identical to today.
      const prefix = schemePrefill;

      // PREFILL via controlledEvaluate (replaces the evaluateWithMetadata generator's first `.next()`):
      // evaluate every prompt token, but attach `generateNext:{probabilities:true}` ONLY to the LAST one
      // so the call returns the successor distribution at `s.nextTokenIndex` — the same baseline dist the
      // generator's first yield produced. `dist` then carries the live distribution across the loop, set
      // each step from the committed token's controlledEvaluate output (the generator's `.next(tok)` yield).
      // Empty prompts never occur (the system prompt is always present), so `promptTokens` is non-empty.
      const prefillInput: ControlledEvaluateInputItem[] = [
        ...promptTokens.slice(0, -1),
        [promptTokens.at(-1)!, { generateNext: { probabilities: true } }],
      ];
      const prefillT0 = performance.now();
      const prefillOut = await s.controlledEvaluate(prefillInput);
      telemetry.prefillMs += performance.now() - prefillT0;
      const dist: ReadonlyMap<Token, number> | undefined = prefillOut.at(-1)?.next.probabilities;
      const decodeT0 = performance.now();

      // STRATEGY SEAM — the single decode path. The Backend wraps THIS sequence `s` + the live model, seeded
      // with the prefill `dist` so the strategy reads the first decode distribution with zero extra evaluate.
      // ALL SIX strategies route through here: `greedy`/`passthrough`/`rollback` drive the abstract backend;
      // `proxy`/`lookahead`/`branch` are the llama-coupled strategies that ride the SAME shared `greedyDescend`
      // via its hooks, so force-emit / Σ∩T warm-up / taps / EOS / commit live in ONE place — there is no inline
      // decode loop. For `greedy` the path is token-identical to the old generator loop (gate: loop-parity).
      // `rawDecode` is returned UN-EXTRACTED (the raw `prefix`, or a resolved fork's already-extracted program).
      const backend = new LlamaDecodeBackend(model, s, eosTokens, dist);

      // FC-ENVELOPE MODE — drive the explicit execute-scheme FSM over the backend instead of the Scheme
      // strategy: FORCE the JSON structure, free-pick `intent`, Σ-mask `expr`. v1 is observe-first: it logs
      // the breakage report (escape hazards / forced-literal round-trip misses / stop reason), never blocks.
      if (opts.fcEnvelope) {
        invariant(scanner, "fcEnvelope requires a scanner (the Σ oracle for the expr slot)");
        const fc = await generateFcEnvelope(backend, scanner, {
          maxNewTokens,
          topK,
          wideK,
          rng,
          shouldStop,
          forceOpenParen: opts.fcForceOpenParen,
          frame: CHAT_TEMPLATES[family].toolCallFrame,
          thinkBudget: opts.thinkBudget,
          thinkOpen: CHAT_TEMPLATES[family].thinkOpen,
          thinkCloseSpecialToken: CHAT_TEMPLATES[family].thinkCloseSpecialToken,
        });
        telemetry.decodeMs += performance.now() - decodeT0;
        telemetry.rawDecode = fc.text;
        // eslint-disable-next-line no-console
        console.error(
          `[fc-envelope] stop=${fc.stop} closed=${fc.closed} hazards=${fc.hazards.length} ` +
            `roundTripMisses=${fc.roundTripMisses.length}\n  expr=${JSON.stringify(fc.expr)}\n  text=${JSON.stringify(fc.text)}`,
        );
        if (fc.hazards.length) console.error("[fc-envelope] hazards:", fc.hazards.slice(0, 20)); // eslint-disable-line no-console
        if (fc.roundTripMisses.length) console.error("[fc-envelope] roundTripMisses:", fc.roundTripMisses); // eslint-disable-line no-console
        return fc.text;
      }

      // NON-FC REASONING BUDGET — the fix for the constrained Scheme decode. A reasoning cell (thinkBudget>0 +
      // a `<think>`-opening family) prefilled its `<think>` opener instead of `(`. Run the SHARED think phase
      // (the SAME mechanism the FC path uses): the model reasons FREELY up to the budget (soft-ramp +
      // hard-backstop force `</think>`), the reasoning committed to the KV ONLY. THEN force-emit the Scheme
      // prefill (`(`) into the KV so the constrained decode below starts conditioned on `(` exactly like the
      // no-think path — the Scheme oracle `prefix` stays the clean `(`, the reasoning lives ONLY in the KV (the
      // maybeOpenFence seam). A non-reasoning cell ⇒ `nonFcThinkOpen` is undefined ⇒ this block is skipped and
      // decode is byte-identical to today.
      if (nonFcThinkOpen) {
        const thought = await runThinkPhase(backend, {
          thinkBudget: opts.thinkBudget ?? 0,
          thinkOpen: nonFcThinkOpen,
          thinkCloseSpecialToken: CHAT_TEMPLATES[family].thinkCloseSpecialToken,
          shouldStop,
        });
        // eslint-disable-next-line no-console
        console.error(`[think-phase] non-FC budget=${opts.thinkBudget} thinkChars=${thought.think.length}`);
        // Seed the Scheme prefill into the KV (round-trip-guarded like the fence force-emit): the model has now
        // seen `<think>…</think>`; commit `(` so stepDistribution() is the post-`(` distribution and the oracle
        // prefix `(` is consistent with what the model saw. A desync declines (the prefix is authoritative — the
        // constrained walk is still safe). An empty Scheme prefill (`""`) commits nothing (the fence path).
        if (schemePrefill.length > 0) {
          const ids = model.tokenize(schemePrefill, false);
          if (ids.length > 0 && model.detokenize(ids) === schemePrefill) await backend.commit(ids);
        }
      }

      // FENCE PREAMBLE (NON-FC constrained only) — peek the model's first token; if it opens a markdown fence
      // (` ```python … `), steer it into the canonical ` ```scheme\n ` opener instead of letting the oracle mask
      // ` ``` ` and derail the model's plan. The fence is committed to the BACKEND (the model sees it) but NOT
      // to `prefix` — the Scheme decode below starts FRESH at the Scheme prefix, so the scanner never sees the
      // fence (`extractSchemeForm`/the scorer skip a leading ` ```scheme\n ` when unwrapping). A pure addition:
      // a model that does NOT open a fence commits nothing here and decodes byte-identically to today.
      if (opts.constrained) {
        await maybeOpenFence(backend);
      }

      const ctx: DecodeContext = {
        backend,
        prefix,
        constrained: opts.constrained,
        scanner,
        maxNewTokens,
        topK,
        wideK,
        temperature,
        rng,
        profile: toolCallProfile,
        onStep,
        onExplain,
        explainTopK,
        explainNucleusMass,
        shouldStop,
        tailThreshold,
        telemetry,
      };
      // Rollback etc. are alternative strategic search policies the substrate can apply.
      const rollback = strategy === "rollback" ? makeRollbackStrategy(rollbackBacktracks, rollbackTheta) : undefined;
      const chosen: DecodeStrategy =
        rollback ??
        (strategy === "passthrough"
          ? PassthroughStrategy
          : strategy === "lookahead"
            ? makeLookaheadStrategy(telemetry)
            : strategy === "branch"
              ? makeBranchStrategy(branchResolver, branchBudget, telemetry)
              : GreedyStrategy);
      const { program, rawDecode } = await chosen.decode(ctx);
      if (rollback) {
        // Fold the rollback search telemetry into the runner's superset (0 / false on the other strategies).
        telemetry.backtracksUsed = rollback.lastTelemetry.backtracksUsed;
        telemetry.completionsExplored = rollback.lastTelemetry.completionsExplored;
        telemetry.improvedOverGreedy = rollback.lastTelemetry.improvedOverGreedy;
      }
      telemetry.decodeMs += performance.now() - decodeT0;
      telemetry.rawDecode = rawDecode;
      return program;
    },

    reset: async (): Promise<void> => {
      if (sequence) await sequence.clearHistory();
    },

    // Release THIS generator's sequence slot back to the (handle-owned) context without tearing down
    // the shared model/context — so a long-lived server that reuses one model handle across many
    // per-request generators doesn't exhaust the context's sequence budget ("No sequences left").
    disposeSequence: async (): Promise<void> => {
      if (sequence) {
        // LlamaContextSequence.dispose() is typed `void` (sync) — the await is harmless + future-proofs a
        // version that returns a Promise; keeping it (vs dropping the await) avoids a require-await flip.
        // eslint-disable-next-line @typescript-eslint/await-thenable
        await sequence.dispose();
        sequence = null;
      }
    },

    dispose: async (): Promise<void> => {
      await context.dispose();
      await model.dispose();
      await handle.llama.dispose();
    },
  };
}
