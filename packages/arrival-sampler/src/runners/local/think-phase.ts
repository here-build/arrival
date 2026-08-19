// think-phase.ts — the REASONING-BUDGET phase, shared by the FC-envelope and the NON-FC constrained Scheme
// decode. A heavy-reasoning model (glm-4.x, the Nemotrons) emits a `<think>…</think>` block BEFORE its answer;
// if the constrained decode starts straight at `(` the model has no room to reason and either rambles into
// reasoning-space the oracle silently admits or dies after ~3 tokens. This phase gives it a bounded budget:
// force-open the family's `<think>` opener (the chat template's enable_thinking prefill — the model does NOT
// emit it itself), let it reason FREELY up to the budget, then transition with a soft ramp + a hard backstop
// so an answer ALWAYS follows.
//
// THE SEAM (mirrors {@link maybeOpenFence}): the reasoning tokens are committed to the BACKEND KV (the model's
// post-think distribution is conditioned on them) but they are NOT the oracle's prefix. The caller keeps its
// constraint prefix at the answer start (`(` for Scheme, the forced JSON for FC), so the constrained walk only
// ever sees the answer — the reasoning lives ONLY in the KV. This module owns NONE of that bookkeeping; it just
// reasons over the backend and returns the `<think>…</think>` text for observability.
//
// PURE module: node-llama-cpp is imported as a TYPE ONLY (the backend contract is `DecodeBackend<Id>`), so it
// loads without the native addon and runs in the default `__tests__` gate over a `ScriptedDecodeBackend`.

import type { Token } from "node-llama-cpp";

import type { DecodeBackend } from "./backends/common/types.js";

// Reasoning-budget ramp: begin nudging `</think>` at 60% of budget; near budget, multiply its prob by up to
// (1+THINK_RAMP_MAX) so it wins if the model surfaces it at all (the hard backstop covers the rest).
const THINK_RAMP_START = 0.6;
const THINK_RAMP_MAX = 50;

function thinkRampStrength(n: number, budget: number): number {
  const start = budget * THINK_RAMP_START;
  if (n <= start || budget <= start) return 0;
  return ((n - start) / (budget - start)) * THINK_RAMP_MAX;
}

/** Argmax over `dist` with `target`'s probability multiplied by `(1 + strength)` — the soft-ramp pick. */
function argmaxBiased<Id extends number>(dist: ReadonlyMap<Id, number>, target: Id, strength: number): Id {
  let best: Id | undefined;
  let bestP = -1;
  for (const [id, p] of dist) {
    const pp = id === target ? p * (1 + strength) : p;
    if (pp > bestP) {
      bestP = pp;
      best = id;
    }
  }
  return best ?? target;
}

/** Inputs to {@link runThinkPhase}. `thinkBudget`/`thinkOpen` GATE the phase (both required for it to fire);
 *  `shouldStop` is the cooperative abort polled per think token. */
export interface ThinkPhaseOptions {
  /** Max think tokens before the forced transition. 0 ⇒ no think phase (the model goes straight to the
   *  answer). >0 ⇒ reason FREELY up to this many tokens, then a soft ramp biases `</think>` past 60% of
   *  budget and a hard backstop FORCES it at budget so an answer always follows. */
  readonly thinkBudget: number;
  /** The family's reasoning-block OPENER (e.g. `"<think>\n"`) — what the chat template prefills on the
   *  enable_thinking path. The CALLER prefills it (the model does not emit it itself); this is recorded for
   *  display only. `undefined` ⇒ the family has no `<think>`-style control, so the phase no-ops. */
  readonly thinkOpen: string | undefined;
  /** How to resolve the think-CLOSE token id, when the family's close is NOT ordinary text. Omitted (the
   *  default): resolve by tokenizing the literal text `"</think>"` (`model.tokenize("</think>", false)`) —
   *  correct when `</think>` is genuine VOCABULARY TEXT (qwen3's `chatml`, GLM's `glm`/`glm-think`). Some
   *  families (Nemotron's `nemotron_h` arch) have `<think>`/`</think>` as SPECIAL/control tokens instead —
   *  text-tokenizing with `specialTokens:false` can never produce the real id (it resolves to some OTHER,
   *  wrong id), so the true close is swallowed as ordinary reasoning content and the hard backstop then
   *  force-commits the WRONG id, double-emitting `</think>`. Set this to the family's known special close id
   *  (mirrors `chat-template.ts`'s `FamilyDef.thinkCloseSpecialToken`) to bypass the text-tokenize path
   *  entirely. */
  readonly thinkCloseSpecialToken?: number;
  /** Cooperative abort (e.g. an AbortSignal), polled before each think token is generated. */
  readonly shouldStop?: () => boolean;
}

/** What the think phase produced. `think` is the `<think>…</think>` block (the opener + the reasoning + the
 *  forced close), or `""` when the phase no-opped (no budget / no opener). The reasoning itself is in the
 *  backend KV — this string is observability only (the constraint prefix never contains it). */
export interface ThinkPhaseResult {
  readonly think: string;
}

/**
 * Run the reasoning-budget phase on a backend whose `stepDistribution()` is the FIRST post-`<think>` token's
 * distribution (the caller has already PREFILLED the family's `thinkOpen` as part of the prompt — the model
 * does not emit `<think>` itself). Let the model reason FREELY up to `thinkBudget` tokens; past 60% of budget a
 * soft ramp biases the `</think>` close if the model surfaces it; at budget a hard backstop FORCES `</think>`.
 * Every think token (and the close) is committed to the backend KV, so the model's subsequent distribution is
 * conditioned on the reasoning. Returns the `<think>…</think>` text (observability).
 *
 * NO-OPS (returns `{ think: "" }`, commits nothing) when `thinkBudget <= 0` or `thinkOpen` is undefined — a
 * non-reasoning family / `no-think` cell, so the caller's decode is byte-identical to having no think phase.
 *
 * THE CLOSE ID resolves via `opts.thinkCloseSpecialToken` when the family declares one (a SPECIAL/control
 * token close, e.g. Nemotron's `nemotron_h`), else by tokenizing the literal text `"</think>"` (qwen3/glm,
 * whose close is ordinary vocabulary text) — see {@link ThinkPhaseOptions.thinkCloseSpecialToken}.
 *
 * Greedy (τ=0): each think token is the model's argmax (the soft ramp is the only override). This is the SHARED
 * mechanism the FC envelope and the non-FC Scheme decode both drive — extracted verbatim from the FC inline
 * phase so both paths reason identically.
 */
export async function runThinkPhase<Id extends number = Token>(
  backend: DecodeBackend<Id>,
  opts: ThinkPhaseOptions,
): Promise<ThinkPhaseResult> {
  const { thinkBudget, thinkOpen, thinkCloseSpecialToken } = opts;
  // No budget or no opener ⇒ a non-reasoning cell: commit nothing, the caller's decode is byte-identical.
  if (!(thinkBudget > 0) || thinkOpen === undefined) return { think: "" };

  const { eosIds } = backend;
  // The chat prompt PREFILLED the family's reasoning opener (the caller sets prefill = thinkOpen — the model
  // does not emit `<think>` itself). Record it for display only; do NOT commit it again (that would
  // double-open the block). Let the model reason FREELY up to the budget from here.
  let think = thinkOpen;
  // Resolve the close id: a family-declared SPECIAL token (nemotron_h — text-tokenize can never produce it,
  // see ThinkPhaseOptions' doc) wins when present; else fall back to tokenizing the literal text (qwen3/glm's
  // `</think>` is ordinary text, so this path is UNCHANGED for them — the cast mirrors the existing `as Id`
  // idiom this file already uses for other backend-branded ids, e.g. the argmax read below).
  const thinkCloseIds: Id[] =
    thinkCloseSpecialToken === undefined
      ? backend.model.tokenize("</think>", false)
      : [thinkCloseSpecialToken as Id];
  const thinkCloseId = thinkCloseIds.at(0);
  let closed = false;
  for (let n = 0; n < thinkBudget && !closed; n++) {
    if (opts.shouldStop?.()) break;
    const dist = backend.stepDistribution();
    if (dist === undefined) break;
    let top1 = dist.keys().next().value as Id | undefined;
    if (top1 === undefined) break;
    // soft ramp: bias `</think>` past 60% of budget if the model surfaces it (let it take a natural exit).
    if (thinkCloseId !== undefined && n >= thinkBudget * THINK_RAMP_START && dist.has(thinkCloseId)) {
      top1 = argmaxBiased(dist, thinkCloseId, thinkRampStrength(n, thinkBudget));
    }
    if (top1 === thinkCloseId) {
      await backend.commit([top1]);
      think += "</think>";
      closed = true;
      break;
    }
    if (eosIds.has(top1)) break; // model ended mid-think (unexpected) — fall to the backstop
    await backend.commit([top1]);
    think += backend.detokenize(top1);
  }
  if (!closed) {
    await backend.commit(thinkCloseIds); // hard backstop — didn't close within budget; an answer must follow
    think += "</think>";
  }
  return { think };
}
