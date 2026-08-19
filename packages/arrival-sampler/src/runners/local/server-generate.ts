// server-generate.ts — the NODE-only server-side constrained-generation entry for the explain-stream.
//
// Runs llama.cpp + Metal over Rnj-1 with the SAME oracle constraint as the shipping browser path, and
// streams one {@link StepExplain} per decode token via `onExplain` — so a WebSocket server can push live
// constrained generation to the browser explain-UI. It REUSES the existing constrained-decode loop
// (`llamaCppGenerator`): that loop already has the prob-sorted top-K, the chosen token under the
// constraint, the oracle, and the accepted prefix at each step; this module just arms its `onExplain`
// hook (which builds the record through the shared {@link buildStepExplain}) and drives one task.
//
// node-llama-cpp is a native addon, so this module is NODE-ONLY. It is NOT in the package's `.` entry
// (the browser bundle imports only StepExplain TYPES from `.`); it is reached via the `./server` subpath.

import { makeOracle, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import invariant from "tiny-invariant";

import type { ToolCallProfile } from "../../mask-compiler.js";
import type { OracleScanner } from "../../oracle-types.js";
import type { StepExplain } from "../../step-explain.js";
import { narrowByTypeAsync, type AsyncTypeLens } from "../../typed-scanner-async.js";
import {
  llamaCppGenerator,
  LlamaModelHandle,
  type BranchResolver,
  type ChatTemplateFamily,
  type LlamaGenTelemetry,
} from "./llama-cpp-generate.js";

// The public `./server` surface, re-exported FROM SOURCE so the eval/bench side imports these from the one
// subpath without reaching into the node-only modules directly. (Symbols also used internally are imported
// above as well; these statements are the exposed surface.)
//   • the B1 branching seam types + chat-template family + telemetry shape + the model-handle class — so the
//     eval side can build a BranchResolver (the R0→R1→R3 cascade, decodeStrategy:"branch"), declare a roster
//     entry's family, type its onTelemetry sink, and load the GGUF ONCE (LlamaModelHandle.load):
export {
  LlamaModelHandle,
  type BranchCandidate,
  type BranchResolver,
  type ChatTemplateFamily,
  type LlamaGenTelemetry,
} from "./llama-cpp-generate.js";

/** Arguments to {@link generateWithExplain}. The grant env (the tool surface) is the Σ source — its
 *  bound names are exactly what the model is allowed to call; an unbound operator is ungeneratable. */
export interface GenerateWithExplainArgs {
  /** The user's task (e.g. "Set a timer for 5 minutes."). */
  readonly prompt: string;
  /** Run the decode loop CONSTRAINED (oracle/scanner gate) or plain argmax. Default true. When false,
   *  `grantEnv`/`asyncTypeLens` are ignored — this is the unconstrained control (BFCL default + scheme). */
  readonly constrained?: boolean;
  /** The live grant {@link OracleEnvΣ} — the tool surface. `makeOracle(grantEnv)` becomes the Σ-live
   *  scanner the decode loop constrains against. Required when `constrained` (the default). */
  readonly grantEnv?: OracleEnvΣ;
  /** When provided AND constrained, the Σ oracle is narrowed by this ASYNC type lens (Σ∩T) — the loop
   *  awaits `scanner.prefill` each step so the current arg slot is type-filled. The lens is PER-ENTRY
   *  (built by the caller over that function's typed prelude). Omit for Σ-only (grammar). */
  readonly asyncTypeLens?: AsyncTypeLens;
  // eslint-disable-next-line no-secrets/no-secrets -- a GGUF filename in a doc comment, not a secret.
  /** Path to the GGUF (e.g. `models/EssentialAI_rnj-1-instruct-Q4_K_M.gguf`). */
  readonly ggufPath: string;
  /** Called once per decode token with the live {@link StepExplain} — the wire payload for the WS stream.
   *  Optional: a batch runner that only wants the final program (e.g. BFCL) can omit it. */
  readonly onExplain?: (e: StepExplain) => void;
  /** Cap on generated tokens. Default 96 (a complete device-intent program fits comfortably). */
  readonly maxNewTokens?: number;
  /** REASONING BUDGET (the non-FC constrained Scheme path) — max think tokens before the forced answer.
   *  0/undefined ⇒ no think phase (byte-identical decode). >0 lets a `<think>`-opening family (e.g. glm-4.x,
   *  the Nemotrons — `CHAT_TEMPLATES[family].thinkOpen`) reason FREELY up to N tokens (soft-ramp +
   *  hard-backstop on `</think>`), committed to the KV ONLY; the Scheme decode then starts at the clean `(`.
   *  No-ops when the resolved family has no `thinkOpen`. Forwarded to {@link llamaCppGenerator}. */
  readonly thinkBudget?: number;
  /** Abort the generation (stops at the next step boundary; the partial program is discarded). */
  readonly signal?: AbortSignal;
  /** The system prompt framing the task. Omitted => empty system prompt (the caller owns the domain). */
  readonly systemPrompt?: string;
  /** Decoder prefill seeding the assistant turn so output starts inside a form. Default `"("`. */
  readonly prefill?: string;
  /** How many prob-sorted ids to walk per step for the explain record (the lazy omitted/chosen/tail walk).
   *  Default 64. */
  readonly explainTopK?: number;
  /** OPT-IN non-lazy nucleus mode — forwarded to `buildStepExplain`'s `nucleusMass` (via `llamaCppGenerator`):
   *  ALSO classifies every candidate in the prob-mass nucleus (`StepExplain.nucleus`), not just up to
   *  `chosen`+tail. Omitted (the default) ⇒ byte-identical to today's lazy-only explain record. */
  readonly explainNucleusMass?: number;
  /** An already-loaded model handle to reuse across calls (skips per-call load/dispose). When omitted,
   *  the GGUF is loaded for this call and disposed before returning. */
  readonly handle?: LlamaModelHandle;
  /** Sampling PRNG seed forwarded to {@link llamaCppGenerator}. Greedy/τ=0 IGNORES it (deterministic
   *  first-feasible pick); a temperature>0 strategy draws from it (so a sampled run is reproducible from the
   *  recorded seed). Omitted ⇒ the generator's own default. Recorded by the BFCL sweep on every line. */
  readonly seed?: number;
  /** DECODE STRATEGY — strategic search policy (greedy default). Advanced policies (branch etc.)
   *  are part of the substrate for exploring LLM strategy under guarantees. */
  readonly decodeStrategy?: "greedy" | "lookahead" | "branch";
  /** Branch resolver and budget for uncertainty branching policy (part of substrate options). */
  readonly branchResolver?: BranchResolver;
  readonly branchBudget?: number;
  /** CHAT-TEMPLATE FAMILY for prompt rendering, forwarded to {@link llamaCppGenerator} (`"llama3"` |
   *  `"chatml"`). Omit to AUTO-DETECT from the GGUF metadata (defaults to `"llama3"` if inconclusive,
   *  so Rnj-1 is unchanged). Set explicitly to override (e.g. a roster entry declaring its family). */
  readonly chatTemplate?: ChatTemplateFamily;
  /** OPT-IN KWARGS PROFILE (the `grammar-kwargs` mode) — `{requiredCount, optionalKeywords}` for THIS call's
   *  function. When present, the constrained decode loop enforces the positional→kwargs invocation shape on
   *  top of Σ (required args positional + forced present; optional args as `:keyword value` narrowed to the
   *  profile's keyword set). Forwarded UNCHANGED to {@link llamaCppGenerator}. Omitted ⇒ byte-identical decode
   *  (the positional `grammar` path). Only meaningful with `constrained` (the default). */
  readonly toolCallProfile?: ToolCallProfile;
  /** Fired ONCE after generation completes with THIS call's {@link LlamaGenTelemetry} (contested steps,
   *  overrides, generated tokens, …). ADDITIVE — the return type is unchanged; callers that don't pass
   *  it are unaffected. A batch runner (e.g. the BFCL sweep) uses it to populate the telemetry columns
   *  (contested% / override%) without re-implementing the decode loop. */
  readonly onTelemetry?: (t: LlamaGenTelemetry) => void;
}

/**
 * Run server-side constrained generation over Rnj-1 (llama.cpp/Metal), streaming a {@link StepExplain}
 * per decode token through `onExplain`. The decode loop, oracle gate, and prompt framing are the
 * harness's — nothing about generation is re-implemented here; only the explain tap is armed and one
 * task is driven. Honors `signal` (stops at the next step boundary). Resolves when generation ends (EOS,
 * `maxNewTokens`, or abort). Loads/disposes the GGUF itself unless a `handle` is supplied. Returns the
 * extracted Scheme program (the first balanced form) so a batch runner can score it without onExplain.
 */
export async function generateWithExplain(args: GenerateWithExplainArgs): Promise<string> {
  const {
    prompt,
    grantEnv,
    asyncTypeLens,
    ggufPath,
    onExplain,
    maxNewTokens = 96,
    signal,
    systemPrompt,
    prefill,
    explainTopK = 64,
    explainNucleusMass,
    decodeStrategy,
    branchResolver,
    branchBudget,
    chatTemplate,
    toolCallProfile,
    onTelemetry,
    seed,
    thinkBudget,
  } = args;
  const constrained = args.constrained ?? true;

  if (signal?.aborted) return ""; // already aborted — nothing to do.
  invariant(!constrained || grantEnv, "generateWithExplain: constrained generation requires a grantEnv");

  const handle = args.handle ?? (await LlamaModelHandle.load(ggufPath));
  const ownsHandle = args.handle === undefined;

  // Constrained → Σ oracle, optionally narrowed by the async type lens (Σ∩T). The loop awaits the
  // AsyncTypedScanner's `prefill` each step (feature-detected) so arg slots are type-filled from token 1.
  const scanner: OracleScanner | undefined = constrained
    ? asyncTypeLens
      ? narrowByTypeAsync(makeOracle(grantEnv), asyncTypeLens)
      : makeOracle(grantEnv)
    : undefined;

  const gen = llamaCppGenerator(handle, {
    onExplain,
    explainTopK,
    ...(explainNucleusMass === undefined ? {} : { explainNucleusMass }),
    shouldStop: () => signal?.aborted ?? false,
    // SEED forwarded only when set (greedy ignores it; τ>0 draws from it). Omitted ⇒ the generator default.
    ...(seed === undefined ? {} : { seed }),
    // exactOptionalPropertyTypes: only forward decodeStrategy when set (never pass explicit undefined).
    // When set, decodeStrategy is the canonical decode-strategy selector in llamaCppGenerator (greedy when omitted).
    ...(decodeStrategy === undefined ? {} : { decodeStrategy }),
    // B1 branching seam: forward the resolver + budget only when set (the loop treats absent resolver as
    // "branching inert" → greedy passthrough).
    ...(branchResolver === undefined ? {} : { branchResolver }),
    ...(branchBudget === undefined ? {} : { branchBudget }),
    // Chat-template family: forward only when explicitly set (omitted ⇒ the loop auto-detects from the
    // GGUF metadata). exactOptionalPropertyTypes: never pass an explicit undefined.
    ...(chatTemplate === undefined ? {} : { chatTemplate }),
    // Kwargs profile (the grammar-kwargs mode): forward only when set (omitted ⇒ byte-identical decode).
    ...(toolCallProfile === undefined ? {} : { toolCallProfile }),
  });

  try {
    const program = await gen.generate(prompt, {
      constrained,
      scanner,
      maxNewTokens,
      systemPrompt,
      prefill,
      // REASONING BUDGET → the non-FC think phase (no-ops at 0/undefined, or when the family has no thinkOpen).
      thinkBudget,
    });
    // Surface THIS call's telemetry once (additive; the return value is still the program string). `gen`
    // is freshly built per call, so `gen.telemetry` is this generation's cumulative counts — not shared.
    onTelemetry?.(gen.telemetry);
    return program;
  } finally {
    // ownsHandle: we loaded the model for this call → full teardown (context.dispose frees the sequence
    // too). Otherwise the caller owns the model handle (e.g. a server reusing it across requests) → free
    // ONLY this call's sequence slot, keeping the shared model+context alive for the next generation.
    await (ownsHandle ? gen.dispose?.() : gen.disposeSequence());
  }
}
