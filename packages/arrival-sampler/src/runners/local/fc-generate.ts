// fc-generate.ts — the FC-envelope decode loop: drive the explicit {@link fc-envelope} FSM over a
// {@link DecodeBackend}, so a model riding its NATIVE tool-call pathway emits a guaranteed-valid Scheme
// program in the `expr` slot. The structural JSON is FORCE-EMITTED (the zimmerframe); `intent` is a free
// JSON string; `expr` is masked by the existing Scheme oracle (`pickConstrained`), the closing quote
// admitted only when the program is `closeable`.
//
// v1 (observe-first): JSON-escape hazards inside `expr` (a literal newline or quote that should be `\n`/`\"`)
// are NOT blocked — they are LOGGED via {@link FcEnvelopeResult.hazards}, to size the future oracle
// "rewrite-strategy" capability. Round-trip failures of a forced literal and premature EOS are likewise
// recorded, never silently swallowed — this loop exists to SHOW what breaks on the first real run.

import type { Token } from "node-llama-cpp";

import type { DecodeBackend } from "./backends/common/types.js";
import { EXECUTE_SCHEME_TOOL, type ExprHazard, HERMES_FRAME, type ToolCallFrame } from "./fc-envelope.js";
import { pickConstrained } from "./pick-constrained.js";
import { runThinkPhase } from "./think-phase.js";
import type { OracleScanner } from "../../oracle-types.js";

export interface FcEnvelopeOptions {
  readonly maxNewTokens: number;
  readonly topK?: number;
  readonly wideK?: number;
  readonly rng?: () => number;
  /** Cooperative abort (e.g. an AbortSignal). */
  readonly shouldStop?: () => boolean;
  /** Force `(` at expr-start so the model writes a call (default true). Set false for the abstention probe
   *  — the model may emit an empty expr on an irrelevant prompt instead of a hallucinated call. */
  readonly forceOpenParen?: boolean;
  /** The tool-call FRAME (hermes JSON | glm xml). Default {@link HERMES_FRAME}. The decode loop owns the
   *  machinery and consults the frame for the per-family syntax (decide, terminator, special-token mode). */
  readonly frame?: ToolCallFrame;
  /** REASONING BUDGET: max think tokens before the forced envelope. 0/undefined ⇒ no think phase (the model
   *  is forced straight into the call — `no-think`). >0 ⇒ FORCE-open `thinkOpen` and let the model reason
   *  FREELY up to this many tokens, then transition: a soft ramp biases `</think>` past 60% of budget, and a
   *  hard backstop FORCES `</think>` at budget so an answer always follows. No-ops without `thinkOpen`. */
  readonly thinkBudget?: number;
  /** The family's reasoning-block OPENER (e.g. `"<think>\n"`) — what the chat template prefills on the
   *  enable_thinking path. The model does NOT emit it itself, so the budget phase force-emits it. Undefined ⇒
   *  the family has no `<think>`-style reasoning control (the think phase no-ops even if thinkBudget>0). */
  readonly thinkOpen?: string;
  /** How to resolve the think-CLOSE id when it is a SPECIAL/control token rather than ordinary text (e.g.
   *  Nemotron's `nemotron_h`) — forwarded verbatim to {@link runThinkPhase}'s `ThinkPhaseOptions`. Omitted ⇒
   *  the default text-tokenize path (unchanged for qwen3/glm/glm-think). */
  readonly thinkCloseSpecialToken?: number;
}

/** What the FC run produced + everything that went sideways (the point of a "see what breaks" run). */
export interface FcEnvelopeResult {
  /** The full generated text — the reasoning block (if any) THEN the tool-call envelope. */
  readonly text: string;
  /** The `<think>…</think>` reasoning block, if a think phase ran (else ""). Observability for the budget. */
  readonly think: string;
  /** The `expr` value as generated (raw Scheme — possibly with unescaped newlines/quotes). */
  readonly expr: string;
  /** Did the FSM reach DONE (a complete, closed envelope)? */
  readonly closed: boolean;
  /** JSON-escape hazards observed inside `expr` (newline/quote/etc.) — the rewrite-strategy targets. */
  readonly hazards: ExprHazard[];
  /** Forced-literal round-trip failures: a literal whose tokenization did NOT detokenize back to itself
   *  (a node-llama leading-space/merge artifact that desyncs the envelope). Each is a breakage to inspect. */
  readonly roundTripMisses: { readonly bytes: string; readonly got: string }[];
  /** Why the loop stopped: clean close, the model ended a generated slot early (EOS), or the step cap. */
  readonly stop: "done" | "eos-in-slot" | "cap" | "no-distribution" | "aborted";
}

/**
 * Run the FC envelope to completion (or the step cap) on a backend already PREFILLED with the prompt
 * (its `stepDistribution()` is the first generated token's distribution). Returns the generated envelope
 * plus a breakage report. Greedy (τ=0): each generated slot takes the model's first feasible token. The
 * per-family syntax comes from `opts.frame` (default {@link HERMES_FRAME}); this loop owns the machinery.
 */
export async function generateFcEnvelope<Id extends number = Token>(
  backend: DecodeBackend<Id>,
  scanner: OracleScanner,
  opts: FcEnvelopeOptions,
): Promise<FcEnvelopeResult> {
  const { model, eosIds } = backend;
  const topK = opts.topK ?? 64;
  const wideK = opts.wideK ?? 256;
  const rng = opts.rng ?? Math.random;
  const frame = opts.frame ?? HERMES_FRAME;

  // The slot terminator, as token ids + its string. Match it by ID (GLM's `</arg_value>` is a SPECIAL token
  // that `detokenize` renders as "" on this binding, so a string check can't see it). Single-token for both
  // confirmed frames (hermes `"`, glm `</arg_value>`); `termHead` is its first/only id.
  const termIds = model.tokenize(frame.exprCloseDelimiter, frame.forceSpecialTokens);
  const termStr = frame.exprCloseDelimiter;
  const termHead = termIds[0];

  let text = "";
  let think = "";
  const hazards: ExprHazard[] = [];
  const roundTripMisses: { bytes: string; got: string }[] = [];

  let lastExpr = "";

  // ── THINK PHASE (reasoning budget) ──────────────────────────────────────────────────────────────────
  // The SHARED reasoning-budget phase (see {@link runThinkPhase}, also driven by the non-FC Scheme decode):
  // when thinkBudget>0 AND the family has a `<think>` opener, let the model reason FREELY up to the budget,
  // then fall through to the forced envelope. Soft ramp biases `</think>` past 60% of budget; hard backstop
  // FORCES it at budget. A non-reasoning / no-think cell no-ops. The think tokens are committed to the KV (the
  // model sees them), so the envelope's expr is conditioned on the reasoning; the constraint prefix is
  // untouched (the FSM below drives from the post-think distribution).
  think = (
    await runThinkPhase(backend, {
      thinkBudget: opts.thinkBudget ?? 0,
      thinkOpen: opts.thinkOpen,
      thinkCloseSpecialToken: opts.thinkCloseSpecialToken,
      shouldStop: opts.shouldStop,
    })
  ).think;

  for (let step = 0; step < opts.maxNewTokens; step++) {
    if (opts.shouldStop?.()) return done("aborted");

    const action = frame.decide(text, { forceOpenParen: opts.forceOpenParen });
    if (action.kind === "done") return done("done");

    if (action.kind === "force") {
      // FORCE-EMIT the structural bytes (the tool name folds in here in v1). Round-trip guard like
      // tryForceEmitSingleton: tokenize, commit, but RECORD a mismatch instead of declining (we want to see it).
      // `forceSpecialTokens` so GLM's tags (`<tool_call>`, `<arg_value>`, …) tokenize to their special ids.
      const ids = model.tokenize(action.bytes, frame.forceSpecialTokens);
      const got = model.detokenize(ids);
      if (got !== action.bytes) roundTripMisses.push({ bytes: action.bytes, got });
      await backend.commit(ids);
      text += action.bytes; // trust the intended bytes; a mismatch is recorded above for inspection
      continue;
    }

    const dist = backend.stepDistribution();
    if (dist === undefined) return done("no-distribution");
    const top1 = dist.keys().next().value as Id | undefined;
    if (top1 === undefined) return done("no-distribution");

    if (action.kind === "free") {
      // INTENT: free string — commit the model's unconstrained argmax. The model closes it with the slot
      // terminator. If that terminator is a SPECIAL token (GLM's `</arg_value>` → "" under detokenize),
      // detect it by id and append its STRING so `locate` sees the close; else commit normally.
      if (eosIds.has(top1)) return done("eos-in-slot");
      if (frame.forceSpecialTokens && top1 === termHead) {
        await backend.commit([top1]);
        text += termStr;
        continue;
      }
      const str = backend.detokenize(top1);
      if (str === "") return done("eos-in-slot");
      await backend.commit([top1]);
      text += str;
      continue;
    }

    // SCHEME: mask the expr value to the Scheme oracle on the expr-substring; admit the close ONLY when the
    // program is closeable (a complete top-level boundary, or empty = "none at all").
    const exprPrefix = action.exprPrefix;
    lastExpr = exprPrefix;
    const state = scanner.analyze(exprPrefix);
    const closeable = state.closeable;

    // The model wants to close the expr slot: its argmax IS the slot terminator's first token AND the program
    // is closeable. Force the full terminator (a forced literal). Token-id match (not string) so GLM's special
    // `</arg_value>` is seen even though it detokenizes to "".
    if (closeable && top1 === termHead) {
      await backend.commit(termIds);
      text += termStr;
      continue;
    }

    // Else constrain to valid Scheme. EOS competes only when closeable (handled inside pickConstrained).
    const picked = pickConstrained(scanner, exprPrefix, dist, eosIds, closeable, topK, wideK, model, 0, rng, undefined, state);
    if (picked.str === "") {
      // pickConstrained returned EOS/empty — the model ended expr without a closing terminator. Breakage.
      return done("eos-in-slot");
    }
    const got = frame.wireHazards(picked.str, exprPrefix.length);
    if (got.length) hazards.push(...got);
    await backend.commit([picked.token]);
    text += picked.str;
  }
  return done("cap");

  function done(stop: FcEnvelopeResult["stop"]): FcEnvelopeResult {
    return { text: think + text, think, expr: lastExpr, closed: stop === "done", hazards, roundTripMisses, stop };
  }
}

/** The tool name the envelope forces — re-exported so callers can prompt the model to use it. */
export { EXECUTE_SCHEME_TOOL };
