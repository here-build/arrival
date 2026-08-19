// backends/llama/lookahead.ts — Tier-A (1-step expected-future) lookahead implementation.
//
// Reversible probe + EFG-weighted pick at contested steps. Part of the lookahead strategy.

import { type Token } from "node-llama-cpp";

import { isContentStr } from "./branching.js";
import type { LlamaGenTelemetry } from "./types.js";
import type { ForceEmitModel, ForceEmitSequence } from "../../../../force-emit.js";
import { isCandidateLive, type ToolCallProfile } from "../../../../mask-compiler.js";
import type { OracleScanner, OracleState } from "../../../../oracle-types.js";

// --- the reversible-probe primitive (the shared core both Tier A lookahead and branching call) ------

/**
 * REVERSIBLE successor probe (research lookahead): evaluate `tok` into
 * the sequence to read its successor distribution, then ROLL THE KV BACK so the sequence is left EXACTLY
 * as found. One forward eval + one erase.
 *
 * Mechanics: capture `base = seq.nextTokenIndex`; `controlledEvaluate([[tok,{generateNext:{probabilities:
 * true}}]])` commits `tok` and yields the next-token distribution; `eraseContextTokenRanges([{start: base,
 * end: seq.nextTokenIndex}])` erases the just-committed token(s) so `nextTokenIndex` returns to `base`.
 * Measured clean (plan §2): re-probing after rollback returns the identical distribution and the index is
 * restored — no drift on this path (the earlier flakiness was the generator + prefix-reuse path, not this).
 *
 * Tier A calls this per candidate at a contested step; branching calls it to score frontier extensions.
 * It does NOT mutate the accepted prefix — it only reads what the successor distribution WOULD be after a
 * hypothetical `tok`, leaving the real decode state untouched. The returned Map is full-vocab, prob-desc
 * sorted (same shape as the decode loop's per-step distribution).
 *
 * @throws if the underlying `controlledEvaluate` fails. On a failure AFTER the commit advanced the KV, the
 *   sequence is rolled back to `base` before rethrowing (G3: a probe must never leave a dirty KV behind).
 */
export async function probeSuccessor(
  seq: ForceEmitSequence,
  tok: Token,
): Promise<ReadonlyMap<Token, number> | undefined> {
  const base = seq.nextTokenIndex;
  try {
    const out = await seq.controlledEvaluate([[tok, { generateNext: { probabilities: true } }]]);
    return out[0]?.next.probabilities;
  } finally {
    // ALWAYS roll back to the pre-probe boundary — whether the eval succeeded (the normal path) or threw
    // after advancing the KV (the G3 dirty-KV guard). The erase is a no-op when nothing advanced.
    if (seq.nextTokenIndex > base) {
      await seq.eraseContextTokenRanges([{ start: base, end: seq.nextTokenIndex }]);
    }
  }
}

// --- Tier A: 1-step expected-future lookahead (probe-scored) -----------------------------------------

/** How many of the SUCCESSOR distribution's prob-desc ids `liveMass` scans when weighting a candidate's
 *  expected-future grammaticality. The successor live mass concentrates in the head of the distribution
 *  (constrained decode keeps the model's own high-prob continuations), so a bounded head captures it; the
 *  long tail is sub-threshold probability whose grammaticality barely moves the score. 64 mirrors the
 *  explain bucketer's default window — wide enough for the alsoValid mass, cheap on oracle calls. */
const LOOKAHEAD_PROBE_TOPK = 64;
/** How many top feasible CONTENT tokens join the candidate set C alongside the greedy pick (m≈3 per the
 *  plan §4). Each adds one `probeSuccessor` forward eval at the contested step. */
const LOOKAHEAD_CONTENT_M = 3;

/** Collect the top-`m` feasible CONTENT tokens (prob-desc, skipping EOS/closers) within the scan window —
 *  the content half of Tier A's candidate set C. Generalizes {@link pickBestFeasibleContent} (which is the
 *  m=1 case) to return up to `m` distinct candidates with their step probabilities for EFG scoring. */
function topFeasibleContent(
  scanner: OracleScanner,
  prefix: string,
  probabilities: ReadonlyMap<Token, number>,
  eosTokens: ReadonlySet<Token>,
  model: ForceEmitModel,
  m: number,
  limit: number,
  profile?: ToolCallProfile,
  slotState?: OracleState,
): { token: Token; str: string; prob: number }[] {
  const out: { token: Token; str: string; prob: number }[] = [];
  let rank = 0;
  for (const [tok, prob] of probabilities) {
    if (++rank > limit) break;
    if (eosTokens.has(tok)) continue; // EOS is a closer
    const str = model.detokenize([tok]);
    if (str === "" || !isContentStr(str)) continue;
    if (isCandidateLive(scanner, prefix, str, profile, slotState)) {
      out.push({ token: tok, str, prob });
      if (out.length >= m) break;
    }
  }
  return out;
}

/**
 * The expected-future grammaticality MASS of a one-token extension `prefix·candStr`, given that
 * extension's already-probed SUCCESSOR distribution `succ`. This is the inner `liveMass(p)` of the EFG
 * score (plan §4): the LLM-weighted fraction of the successor distribution that keeps the program live —
 *
 *   liveMass(p) = Σ over the top-K of `succ` of  prob(t)·[isCandidateLive(p, t.str)]
 *               + (analyze(p).closeable ? Σ prob(eos in succ) : 0)
 *
 * i.e. how much probability mass the model puts on continuations that are STILL grammatical at `p`, plus
 * the mass on ending here when ending is legal. A candidate whose successor mass is mostly feasible scores
 * high; one that leads into a dead end (most successors masked) scores low — the exact label-bias signal
 * per-step decoding is blind to. Content tokens are gated by the oracle at `p`; EOS mass is gated by `p`'s
 * closeability (EOS has no string continuation — it is the "end here" event, not an `isCandidateLive` arg).
 */
function liveMass(
  scanner: OracleScanner,
  pAfter: string,
  succ: ReadonlyMap<Token, number>,
  eosTokens: ReadonlySet<Token>,
  model: ForceEmitModel,
  probeTopK: number,
  profile?: ToolCallProfile,
): number {
  // The slot state at `pAfter` (a DIFFERENT prefix than the current step's) — computed HERE, not threaded
  // from the caller, so the structure gate uses the post-extension slot. Reused for the EOS-mass gate too.
  const stateAfter = scanner.analyze(pAfter);
  const closeableAfter = stateAfter.closeable;
  let mass = 0;
  let scanned = 0;
  for (const [tok, prob] of succ) {
    if (++scanned > probeTopK) break;
    if (eosTokens.has(tok)) {
      // EOS contributes ONLY when ending is legal at `pAfter` (the program is complete-able there).
      if (closeableAfter) mass += prob;
      continue;
    }
    const str = model.detokenize([tok]);
    if (str === "") continue;
    if (isCandidateLive(scanner, pAfter, str, profile, stateAfter)) mass += prob;
  }
  return mass;
}

/**
 * TIER A — pick the candidate that maximizes one-step expected-future grammaticality. Builds the
 * candidate set `C = {greedy pick} ∪ {top-m feasible content tokens}`, scores each `c` by
 * `P(c)·liveMass(prefix·c)` using ONE reversible {@link probeSuccessor} per candidate, and returns the
 * argmax (with its step probability for the caller's compare). Each probe is counted in `telemetry.probes`.
 *
 * `P(c)·liveMass` is ASAp's EFG recursion truncated to depth 1: P(c) is the immediate token mass, liveMass
 * is the one-step lookahead at the binary-oracle base case. The greedy pick (a closer) is always in C, so
 * the lookahead can only UPGRADE the choice when a content candidate's expected future genuinely beats
 * closing — never picks an infeasible token (every member of C is oracle-feasible at `prefix`). Returns
 * `null` if C is just the greedy pick (no content candidate to weigh — nothing to probe, 0 evals spent).
 *
 * The sequence `s` is left EXACTLY as found: every probe rolls its own token back (probeSuccessor's
 * contract), so after scoring the accepted KV still matches `prefix` and the real commit proceeds normally.
 */
export async function pickLookahead(
  s: ForceEmitSequence,
  scanner: OracleScanner,
  prefix: string,
  probabilities: ReadonlyMap<Token, number>,
  eosTokens: ReadonlySet<Token>,
  closeable: boolean,
  model: ForceEmitModel,
  greedyTok: Token,
  greedyStr: string,
  limit: number,
  telemetry: LlamaGenTelemetry,
  profile?: ToolCallProfile,
  slotState?: OracleState,
): Promise<{ token: Token; str: string } | null> {
  const content = topFeasibleContent(
    scanner,
    prefix,
    probabilities,
    eosTokens,
    model,
    LOOKAHEAD_CONTENT_M,
    limit,
    profile,
    slotState,
  );
  // No content rival to the greedy closer → nothing to weigh; spend no probes (the |C|=0 degenerate).
  if (content.length === 0) return null;

  // C = {greedy pick} ∪ {top-m feasible content}. The greedy pick is the closer the loop already chose;
  // include it so closing remains a live option and the lookahead can only upgrade, never regress.
  const C: { token: Token; str: string }[] = [{ token: greedyTok, str: greedyStr }];
  for (const c of content) if (c.token !== greedyTok) C.push({ token: c.token, str: c.str });

  let best: { token: Token; str: string } | null = null;
  let bestScore = -1;
  for (const c of C) {
    const pc = probabilities.get(c.token) ?? 0; // P(c) — the immediate token mass from THIS step.
    let lm: number;
    if (eosTokens.has(c.token)) {
      // EOS has no successor distribution — it IS the "end here" event. Its expected-future mass is the
      // terminal grammaticality: 1 when ending is legal at this prefix (the program completes), else 0.
      // (Reaching here means the greedy pick was EOS — rare: it requires `closeable` to already hold. We
      // do NOT probe an EOS token, which would commit end-of-sequence.)
      lm = closeable ? 1 : 0;
    } else {
      const succ = await probeSuccessor(s, c.token); // one forward eval + rollback (reversible).
      telemetry.probes++;
      if (succ === undefined) continue; // no successor distribution (shouldn't happen mid-program) — skip.
      lm = liveMass(scanner, prefix + c.str, succ, eosTokens, model, LOOKAHEAD_PROBE_TOPK, profile);
    }
    const score = pc * lm;
    if (process.env.LOOKAHEAD_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(
        `[lookahead-debug] prefix=${JSON.stringify(prefix)} cand=${JSON.stringify(c.str)} P=${pc.toExponential(3)} liveMass=${lm.toFixed(4)} score=${score.toExponential(3)}`,
      );
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}
