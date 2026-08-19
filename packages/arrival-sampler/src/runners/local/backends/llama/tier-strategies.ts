// backends/llama/tier-strategies.ts — llama-specific implementations of lookahead and branching tiers.
//
// These provide the reversible probes and fork machinery for the corresponding strategies. Ride the
// shared descent so the per-step spine (force-emit, taps, etc.) stays in one place.
//
// Node-only decode runtime (drives node-llama-cpp through the descent + the concrete seq), so it ships via
// dist-server and is excluded from the published browser `.` entry.

import type { Token } from "node-llama-cpp";

import { branchTrigger, decodeArm, isCloserStr, isContentStr, reachKey, type ForkArm } from "./branching.js";
import { pickLookahead } from "./lookahead.js";
import type { BranchCandidate, BranchResolver, LlamaGenTelemetry } from "./types.js";
import { extractSchemeForm } from "../../../generate.js";
import { greedyDescend } from "../../strategies/common/greedyDescend.js";
import type {
  ContestedPickArgs,
  DecodeContext,
  DecodeResult,
  DecodeStrategy,
  ForkArgs,
} from "../../strategies/common/types.js";

// ── lookahead: the contested-step OVERRIDE strategy ───────────────────────────────────────────────────

/**
 * The `onContestedPick` hook for the lookahead tier. {@link greedyDescend} fires it post-pick at τ≤0; it
 * recomputes the CONTESTED condition (the model's masked top pick was CONTENT, yet the constrained greedy
 * collapsed to a CLOSER — the label-bias case) and, when contested, replaces the pick with the EFG-weighted
 * argmax over {greedy pick} ∪ {top-m feasible content}, scored by one reversible `probeSuccessor` per
 * candidate on `backend.seq`. Owns its tier telemetry (contestedSteps / lookaheadOverrides / probes).
 * Returns the replacement `{token, str}` or null (keep greedy's pick) — always oracle-feasible at `prefix`.
 */
function contestedHook(
  telemetry: LlamaGenTelemetry,
): (args: ContestedPickArgs) => Promise<{ token: Token; str: string } | null> {
  return async (a) => {
    // The contested trigger: the model WANTED content (its masked argmax was content) but greedy chose a
    // closer. The lookahead tier engages ONLY here — 0 probes on the ~95% confident steps.
    const contested = a.preferKind === "infeasible" && isContentStr(a.preferStr) && isCloserStr(a.greedyStr);
    if (!contested) return null;
    telemetry.contestedSteps++;
    const { backend } = a;

    // TIER A — 1-step expected-future lookahead: the EFG-weighted choice (P(c)·liveMass), one reversible
    // probe per candidate on the live sequence.
    const best = await pickLookahead(
      backend.seq,
      a.scanner,
      a.prefix,
      a.probabilities,
      backend.eosIds,
      a.closeable,
      backend.model,
      a.greedyTok,
      a.greedyStr,
      a.wideK,
      telemetry,
      a.profile,
      a.slotState,
    );
    if (best && best.token !== a.greedyTok) {
      telemetry.lookaheadOverrides++;
      return best;
    }
    return null;
  };
}

/**
 * The lookahead STRATEGY: greedy's descent plus the {@link contestedHook} probe-scored override at a contested
 * step. Greedy-base only (the hook is gated to τ≤0 in the descent); on the confident ~95% of steps the hook
 * returns null and the output is greedy's. `telemetry` is the runner's `LlamaGenTelemetry` the hook increments
 * live (no fold-in needed).
 */
export function makeLookaheadStrategy(telemetry: LlamaGenTelemetry): DecodeStrategy {
  const onContestedPick = contestedHook(telemetry);
  return {
    async decode(ctx: DecodeContext): Promise<DecodeResult> {
      const { prefix } = await greedyDescend(ctx, ctx.prefix, 0, 0, { onContestedPick });
      return { program: extractSchemeForm(prefix), rawDecode: prefix, telemetry: ctx.telemetry };
    },
  };
}

// ── branch: the uncertainty-fork strategy ─────────────────────────────────────────────────────────────

/** The fork the `onFork` hook captured: the fork prefix + backend position, the arms to decode, the step
 *  budget remaining (each arm's onward decode is bounded by `maxNewTokens - step`), and the fork step + its
 *  distribution (so the all-pruned corner can re-descend greedy from the fork). */
interface CapturedFork {
  readonly forkPrefix: string;
  readonly forkPosition: number;
  readonly arms: readonly ForkArm[];
  readonly remaining: number;
  readonly forkStep: number;
  readonly forkDist: ReadonlyMap<Token, number>;
}

/**
 * The branch STRATEGY (B1 uncertainty branching): greedy's descent until an intent fork, then a depth-first
 * decode of the fork arms + a resolver verdict. Without a `resolver` the request-blind loop can't rank arms,
 * so NO fork is ever committed and the strategy decodes greedy exactly (the old `branchEnabled` gate). With
 * one: the `onFork` hook (fired pre-pick at τ≤0) runs the four-gate trigger; on a fork it captures the fork +
 * STOPS the descent, then this strategy decodes each arm to completion on `backend.seq` (rewinding between
 * arms via `backend.rewind`), hands the completed programs to the resolver, and returns the winner. Budget is
 * `branchBudget` forks per program (V0: 1). `telemetry` is incremented live (branchesOpened/Pruned/Overrides).
 */
export function makeBranchStrategy(
  resolver: BranchResolver | undefined,
  branchBudget: number,
  telemetry: LlamaGenTelemetry,
): DecodeStrategy {
  return {
    async decode(ctx: DecodeContext): Promise<DecodeResult> {
      // No resolver ⇒ a fork could never be RESOLVED, so we never fork: plain greedy (matches the old gate
      // `branchEnabled = strategy==="branch" && branchResolver!==undefined`). The unconstrained control (no
      // scanner) also has nothing to fork on.
      if (resolver === undefined || ctx.scanner === undefined) {
        const { prefix } = await greedyDescend(ctx, ctx.prefix, 0, 0);
        return { program: extractSchemeForm(prefix), rawDecode: prefix, telemetry: ctx.telemetry };
      }

      const { backend, scanner, profile, topK, wideK } = ctx;
      let forksUsed = 0;
      // A mutable holder, not a bare `let`: the `onFork` closure writes the captured fork, but TS can't see
      // that across the `await greedyDescend` and would narrow a bare `let` read to `null`. A property on a
      // const object has its narrowing reset across the call, so the read below keeps the union.
      const captured: { value: CapturedFork | null } = { value: null };

      // The fork hook: run the four-gate trigger; on a real intent fork, capture it + STOP the descent (this
      // strategy owns the decode from the fork onward). Returns false on the overwhelming majority of steps.
      const onFork = (a: ForkArgs): boolean => {
        if (forksUsed >= branchBudget) return false;
        const arms = branchTrigger(
          a.scanner,
          a.prefix,
          a.probabilities,
          backend.eosIds,
          backend.model,
          a.closeable,
          a.topK,
          a.profile,
          a.slotState,
        );
        if (arms === null) return false;
        forksUsed++;
        telemetry.branchesOpened++;
        captured.value = {
          forkPrefix: a.prefix,
          forkPosition: backend.position(),
          arms,
          remaining: a.maxNewTokens - a.step,
          forkStep: a.step,
          forkDist: a.probabilities,
        };
        return true;
      };

      const { prefix } = await greedyDescend(ctx, ctx.prefix, 0, 0, { onFork });
      const fork = captured.value; // a const read of the holder — the null-guard below narrows it cleanly.
      if (fork === null) {
        // No fork fired across the whole decode — the greedy descent IS the program.
        return { program: extractSchemeForm(prefix), rawDecode: prefix, telemetry: ctx.telemetry };
      }

      // Decode each arm DEPTH-FIRST from the fork on the live sequence, rewinding the KV back to the fork
      // between arms (the §2 in-memory rewind — `backend.rewind`). V0's branch base carries no proxy, so the
      // arms decode greedily (proxyInArm=false), byte-identical to what the main greedy loop would emit had it
      // taken each arm's first token.
      const completed: BranchCandidate[] = [];
      for (const arm of fork.arms) {
        const { program } = await decodeArm(
          backend.seq,
          scanner,
          fork.forkPrefix,
          arm.token,
          arm.str,
          backend.eosIds,
          backend.model,
          false,
          topK,
          wideK,
          fork.remaining,
          profile,
        );
        // R0/type prune (§2a): an arm that could not complete a valid (non-empty) program is dropped before
        // resolution. Essentially never hit under V0 (we only fork among oracle-feasible entities).
        if (program.trim() === "") telemetry.branchesPruned++;
        else completed.push({ program, symbol: reachKey(arm.reach), forkProb: arm.prob });
        // Rewind the WHOLE arm range [forkPosition, live) the arm just committed — read the live position so
        // the erase is correct by construction.
        await backend.rewind(fork.forkPosition, backend.position());
      }

      if (completed.length === 0) {
        // Corner-1 (all arms pruned): the fork never happened. The arms decode on the raw seq (not via
        // backend.commit), so the backend's cached dist still IS the fork dist; re-adopt it explicitly and
        // decode greedy onward from the fork — exactly the single-path decode the inline loop fell through to
        // at this step. (V0 budget=1: faithful. A budget≥2 re-fork after an all-pruned corner is not
        // reproduced — this re-descend is plain greedy — but the corner itself never fires under V0.)
        backend.adoptDistribution(fork.forkDist);
        const { prefix: greedyPrefix } = await greedyDescend(ctx, fork.forkPrefix, fork.forkStep, 0);
        return { program: extractSchemeForm(greedyPrefix), rawDecode: greedyPrefix, telemetry: ctx.telemetry };
      }

      // RESOLVE (§4): ask the injected resolver. Index 0 is the greedy/highest-prob arm, so a 0 (or out-of-
      // range) verdict keeps greedy (tie-goes-to-the-model — weakly monotone). The resolved arm IS the full
      // program (decoded from the fork to EOS), so it is both the returned program and the raw decode.
      const verdictRaw = await resolver(completed);
      const verdict = Number.isInteger(verdictRaw) && verdictRaw >= 0 && verdictRaw < completed.length ? verdictRaw : 0;
      if (verdict !== 0) telemetry.branchOverrides++;
      const resolvedProgram = completed[verdict].program;
      return { program: resolvedProgram, rawDecode: resolvedProgram, telemetry: ctx.telemetry };
    },
  };
}
