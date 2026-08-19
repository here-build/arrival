// strategies/greedyDescend.ts — shared per-step descent for constrained greedy (minimal path).
//
// Core for primitive 2 default. Research strategies hook for advanced behavior (rollback etc.).
// Node-only.
//
// Node-only decode runtime (drives the node-llama-cpp backend), so it lives in `src/decode/` and is
// excluded from the published browser `.` entry.

import type { Token } from "node-llama-cpp";

import type { DecodeContext, DescentHooks, DescentResult, FeasibleCand } from "./types.js";
import { tryForceEmitSingleton } from "../../../../force-emit.js";
import { isCandidateLive, type ToolCallProfile } from "../../../../mask-compiler.js";
import type { OracleScanner, OracleState } from "../../../../oracle-types.js";
import { selectConstrainedStep } from "../../../../select-constrained-step.js";
import { buildStepExplain } from "../../../../step-explain.js";
import { hasPrefill } from "../../../../typed-scanner-async.js";
import type { DecodeBackend } from "../../backends/common/types.js";
import { pickConstrained } from "../../pick-constrained.js";

/** log(p) with a finite floor for p=0 (a committed token always has p>0 in practice, but force-emit's
 *  leading-token prob can be absent from the cached dist — guard so totalLogprob stays a real number and
 *  comparisons never see NaN/-Infinity propagate silently). */
function logProb(p: number | undefined): number {
  return p !== undefined && p > 0 ? Math.log(p) : -1e9;
}

/** Collect the feasible candidates at `prefix`, prob-DESCENDING, over the model's top-K (widening to
 *  wideK if the top-K had none) — the ranked arms a choice point caches. Reuses the SHARED
 *  `selectConstrainedStep` (via `pickConstrained`'s sibling layer) so the verdict + ordering match the
 *  greedy pick exactly (greedy's `kept[0]` is this array's `[0]`). EOS competes in the walk (closeable ⇒ a
 *  feasible "end here" arm with str ""). */
function collectFeasibleRanked<Id extends number = Token>(
  scanner: OracleScanner,
  prefix: string,
  probabilities: ReadonlyMap<Id, number>,
  eosTokens: ReadonlySet<Id>,
  closeable: boolean,
  topK: number,
  wideK: number,
  backend: DecodeBackend<Id>,
  profile: ToolCallProfile | undefined,
  slotState: OracleState,
): FeasibleCand<Id>[] {
  const rankedIds = (limit: number): Iterable<Id> => {
    let n = 0;
    const out: Id[] = [];
    for (const tok of probabilities.keys()) {
      if (n++ >= limit) break;
      out.push(tok);
    }
    return out;
  };
  // Token-typed callbacks ⇒ `selectConstrainedStep` infers `Id = Token`; `kept` is `Token[]`, all cast-free.
  const { kept } = selectConstrainedStep({
    scanner,
    prefix,
    rankedIds,
    idToString: (id) => {
      const str = backend.detokenize(id);
      return str === "" ? undefined : str;
    },
    allIds: () => probabilities.keys(),
    slotState,
    closeable,
    keepN: Infinity,
    topK,
    wideK,
    eos: { isEos: (id) => eosTokens.has(id) },
    profile,
  });
  return kept.map((tok) => {
    const isEos = eosTokens.has(tok);
    return { token: tok, str: isEos ? "" : backend.detokenize(tok), prob: probabilities.get(tok) ?? 0 };
  });
}

/**
 * THE SHARED PER-STEP DESCENT — greedy's constrained walk, run from the backend's CURRENT state until EOS
 * or the step cap, growing `startPrefix` and accumulating the path's total log-probability. This is the
 * spine BOTH `GreedyStrategy` (no hooks → byte-identical to the inline loop) and `RollbackStrategy` (with
 * an `onChoicePoint` hook → records regret choice points) drive, so force-emit / warm-up / EOS / commit /
 * the taps exist in ONE place. The pick is always the first feasible (`pickConstrained` keepN=1 on the
 * unhooked path; `collectFeasibleRanked`[0] — the identical token — on the hooked path), so the COMMITTED
 * stream is the same with or without hooks; the hook only OBSERVES the ranked alternatives.
 *
 * `startStep` lets rollback resume a descent partway against the `maxNewTokens` cap (the warm-up +
 * slotState are recomputed from `startPrefix` each entry, so a fresh call from a rewound state is self-
 * contained). `baseLogprob` is the ABSOLUTE log-prob already accumulated before `startPrefix` (0 for pass 0;
 * the path-to-fork + alternative-arm log-prob for a backtrack onward-descent) — the running total starts
 * there, so the returned `totalLogprob` and every recorded choice point's `logprobBefore` are ABSOLUTE and
 * comparable across passes. The backend must already carry the successor distribution for `startPrefix`
 * (the prefill, or the dist after the last committed/restored token) — the descent reads
 * `backend.stepDistribution()` first thing.
 */
export async function greedyDescend<Id extends number = Token>(
  ctx: DecodeContext<Id>,
  startPrefix: string,
  startStep: number,
  baseLogprob: number,
  hooks?: DescentHooks<Id>,
): Promise<DescentResult> {
  const { backend, scanner, constrained, maxNewTokens, topK, wideK, temperature, rng, profile, telemetry } = ctx;
  const { model, eosIds: eosTokens } = backend;
  const recordChoicePoints = hooks?.onChoicePoint !== undefined;
  const theta = hooks?.regretTheta ?? 0.25;

  let prefix = startPrefix;
  let totalLogprob = baseLogprob;
  let endedAtEos = false;

  // id→string + prob helpers for the explain bucketer (the inline loop's `decodeId` / `probOf`). EOS
  // decodes to "" and is gated out-of-band by the bucketer; the "logit" axis carries the probability.
  let stepProbs: ReadonlyMap<Id, number> | null = null;
  const decodeId = (id: Id): string | undefined => {
    if (eosTokens.has(id)) return ""; // EOS — gated out-of-band by the bucketer.
    const str = model.detokenize([id]);
    return str === "" ? undefined : str;
  };
  const probOf = (id: Id): number => stepProbs?.get(id) ?? Number.NaN;

  for (let step = startStep; step < maxNewTokens; step++) {
    const dist = backend.stepDistribution();
    if (dist === undefined) break; // no successor distribution (generator-`done` analogue) — stop.
    if (ctx.shouldStop?.()) break; // cooperative abort (e.g. an AbortSignal from the WS server).
    const probabilities = dist; // Map<Token, number>, prob-desc sorted (full vocab, no native sampler).
    stepProbs = probabilities;

    // Unconstrained argmax = the first (highest-prob) entry — the model's preference.
    const iter = probabilities.entries();
    const top1: [Id, number] | undefined = iter.next().value;
    if (top1 === undefined) break;
    const top2: [Id, number] | undefined = iter.next().value;
    const preferTok = top1[0];
    const preferProb = top1[1];
    const preferStr = model.detokenize([preferTok]);
    const top2Margin = preferProb - (top2 ? top2[1] : 0);

    // Σ∩T warm-up: if the scanner is an AsyncTypedScanner (exposes prefill), await its slot fill for the
    // CURRENT prefix BEFORE the candidate walk, so the whole token sees the narrowed Σ∩T set.
    if (scanner && constrained && hasPrefill(scanner)) {
      await scanner.prefill(prefix);
    }

    // The VALUE-SLOT state, computed ONCE this step (after the Σ∩T warm-up) and threaded into every
    // liveness check below. Never re-analyzed per candidate. `undefined` on the unconstrained control.
    //
    // VALUE-OPEN BOUNDARY: a single model token routinely CLOSES the current atom and OPENS the next
    // argument's value in one step (the ` '` / ` major` token: the space closes `4`, the rest opens
    // progression_type). At such a step `analyze(prefix)` sits MID-ATOM in the PREVIOUS slot (its type
    // stamp is the prior arg's), so the type-derived gates (structure + scalar-string Σ exemption) would
    // read the wrong slot. When the prefix is mid-atom at an ARGUMENT, re-analyze at the boundary the value
    // opens in (`prefix + " "` force-closes the atom) so `slotIsArray`/`slotIsStringy`/`arrayReturningHeads`
    // describe the slot the NEXT value lands in. This now ALSO re-bases the OPERATOR-transition (the head is
    // being typed and the next token closes it + opens the first value — `(get_route` → the boundary
    // `(get_route ` is the scalar arg-0 slot, where the type-reachability gate masks a glued `(list …)`).
    // `closeable` stays from the true cursor (whitespace can't close a paren).
    const prefixState = scanner ? scanner.analyze(prefix) : undefined;
    const slotState =
      scanner &&
      prefixState &&
      prefixState.midToken &&
      (prefixState.position === "argument" || prefixState.position === "operator")
        ? scanner.analyze(`${prefix} `)
        : prefixState;
    const closeable = prefixState ? prefixState.closeable : true;

    // SINGLETON FORCE-EMIT — at a slot where the oracle+profile admit exactly ONE symbol, skip the model
    // and emit that symbol's remaining tokens directly. Gated to constrained + a profile + τ≤0; the round-
    // trip guard inside makes it byte-safe. On success commit the forced string, take the successor
    // distribution, and resume. Never fires on the no-profile path, so loop-parity is untouched. A forced
    // slot contributes 0 to totalLogprob (constraint-determined, NOT a model choice — see below).
    if (constrained && scanner !== undefined && profile !== undefined && temperature <= 0) {
      const forced = await tryForceEmitSingleton(scanner, prefix, profile, model, backend.seq);
      if (forced !== null) {
        prefix += forced.committed;
        telemetry.generatedTokens++;
        telemetry.forcedSlots++;
        // A FORCED slot is constraint-determined, NOT a model choice — it contributes log(1)=0 to the path
        // log-prob, so nothing is added here. (Crediting `preferProb` — the model's *argmax* — was a bug:
        // the forced leading token need not be the argmax, so the path was credited the wrong token's mass.)
        // totalLogprob is the model's preference over its FREE choices; a slot the oracle forced adds none.
        // Forced slots are identical across all completions through this prefix, so rollback's completion
        // ranking is unaffected — this only stops a misleading prob from entering the sum.
        backend.adoptDistribution(forced.dist);
        continue; // the forced slot is committed — go straight to the next step (no model pick).
      }
    }

    // BACKTICK TOLERANCE (see fence-preamble.ts) — models FRAME tool calls with markdown backticks: a per-call
    // quasiquote ` `( ` (Arch-1.5B), a closing ```` ``` ```` fence (rnj-1), inline code. These are NON-SEMANTIC
    // envelope the scorer/extraction strips. Masking them (R-UNQUOTE-QUASI) fights the model's framing — it
    // force-feeds the model off its own distribution, and after honor-the-stop a per-call ` `( ` looks like
    // "leaving" → under-generation (only the first call survives). Instead, when the model's ARGMAX opens with
    // a backtick at a form boundary, TOLERATE it: commit the token to the KV (the model stays on its trained
    // rails, its post-backtick distribution intact) but STRIP the backtick from the oracle prefix — the
    // `(call)` inside is the program. The per-token analog of the fence preamble; the scored/emitted program
    // stays pure Scheme (the backtick lives only in the KV). Gated to constrained + a NON-mid-atom boundary (a
    // backtick inside a string literal is real content — `prefixState.midToken` excludes it). The stripped
    // remainder must be empty (pure framing, e.g. ```` ``` ````) or itself feasible (e.g. ` `( ` → ` (`), else
    // we DON'T tolerate (fall through to the pick) — never desync the oracle onto an illegal continuation.
    if (constrained && scanner !== undefined && prefixState && !prefixState.midToken && /^\s*`/.test(preferStr)) {
      const rest = preferStr.replace(/^(\s*)`+/, "$1"); // drop the leading backtick run, keep any leading ws
      if (rest.trim() === "" || isCandidateLive(scanner, prefix, rest, profile, slotState)) {
        await backend.commit([preferTok]); // the framing token → KV only (the model's distribution stays conditioned on it)
        prefix += rest; // the oracle/program sees only the stripped remainder
        telemetry.generatedTokens++;
        totalLogprob += logProb(preferProb); // the backtick WAS the model's argmax — credit its mass, like any pick
        continue; // tolerated — skip the pick/D and read the successor distribution
      }
    }

    // FORK (branch tier) — BEFORE the pick, at a constrained step (τ≤0), give an `onFork` hook the chance to
    // detect an intent-uncertainty fork and STOP the descent here (it captures the fork in its closure; the
    // BranchStrategy then decodes + resolves the arms). Greedy/proxy/lookahead pass no `onFork`, so this is
    // skipped entirely — the descent proceeds to the pick below unchanged.
    if (hooks?.onFork && constrained && scanner !== undefined && temperature <= 0) {
      const forked = hooks.onFork({
        backend,
        scanner,
        prefix,
        probabilities,
        closeable,
        topK,
        profile,
        slotState,
        step,
        maxNewTokens,
      });
      if (forked) break; // the strategy owns the rest of the decode from this fork.
    }

    let chosenTok: Id;
    let chosenStr: string;
    let iterationsUntilFeasible = 1;
    let preferKind: "feasible" | "infeasible" = "feasible";
    let chosenProb = preferProb;

    if (!constrained || scanner === undefined) {
      // Control: plain greedy argmax (EOS may win naturally).
      chosenTok = preferTok;
      chosenStr = preferStr;
    } else {
      // Is the model's own pick feasible? (records preferKind without changing the walk.) The kwargs
      // profile AND the value-slot `slotState` (the structure gate) are threaded so the metric agrees
      // with the constrained walk below.
      preferKind = eosTokens.has(preferTok)
        ? closeable
          ? "feasible"
          : "infeasible"
        : isCandidateLive(scanner, prefix, preferStr, profile, slotState)
          ? "feasible"
          : "infeasible";

      // HONOR-THE-STOP — at a CLOSEABLE prefix (the program is already a complete, balanced top-level form),
      // if the model's UNMASKED argmax is itself infeasible, the model is trying to LEAVE Scheme-space —
      // close its markdown fence, write prose, emit a delimiter the grammar bans — i.e. it is signalling DONE.
      // Forcing the best *feasible* token here overrides that stop intent and is the runaway-past-completion
      // bug: a model that frames calls in a ```scheme fence terminates by CLOSING the fence (argmax ``` at
      // p≈1); the oracle masks the backtick (quasiquote) and force-feeds a p≈0 new call, looping to the token
      // cap and breaking the set-match. The grammar's "valid" (no backtick) is NARROWER than the scorer's
      // "correct" (it strips the fence), so masking the close DELETES a correct program. Terminate here, as if
      // the model emitted EOS. SOUND: we stop ONLY when the program is complete AND the model prefers to
      // leave — never mid-form, never when a valid continuation (the next call) is the model's own argmax.
      // (A genuine EOS argmax is already "feasible" at a closeable prefix and wins the pick below; this guard
      // catches the case where the model's stop is expressed as a grammar-illegal envelope token instead.)
      //
      // NON-EMPTY GUARD: only honor the stop once a NON-EMPTY program exists. An EMPTY prefix is "closeable"
      // vacuously (nothing to close ≠ a complete program worth keeping), so without this a model whose VERY
      // FIRST token is infeasible — e.g. Arch-1.5B opens with ` `( ` (quasiquote, masked) — would terminate
      // at step 0 with zero output (outTok=0, raw=""), a catastrophic regression (grammar 50%→0%). Here we
      // defer to the pick, which force-feeds a feasible opener and lets the program start. closeable +
      // non-empty ⟹ the committed prefix IS a complete ≥1-form program, which is exactly when stopping is right.
      if (closeable && preferKind === "infeasible" && !eosTokens.has(preferTok) && prefix.trim() !== "") {
        totalLogprob += logProb(preferProb); // credit the model's stop mass, mirroring the EOS branch.
        endedAtEos = true; // ended cleanly at a complete program (NOT a cap-hit truncation).
        break;
      }

      if (recordChoicePoints) {
        // ROLLBACK's recording path: collect the feasible-RANKED arms (so we can detect ≥2 + cache the
        // untried alternatives). `ranked[0]` is the identical token greedy's keepN=1 walk would pick, so
        // the committed stream is unchanged — the collection only ADDS the alternatives the choice point
        // needs. When even the widened scan finds nothing feasible (the structural-fallback corner),
        // `ranked` is empty and we fall back to the SHARED `pickConstrained` (which carries the closer /
        // over-constrained-throw logic) — that corner is never a multi-arm choice point.
        const ranked = collectFeasibleRanked(
          scanner,
          prefix,
          probabilities,
          eosTokens,
          closeable,
          topK,
          wideK,
          backend,
          profile,
          slotState ?? scanner.analyze(prefix),
        );
        if (ranked.length === 0) {
          const picked = pickConstrained(
            scanner,
            prefix,
            probabilities,
            eosTokens,
            closeable,
            topK,
            wideK,
            model,
            0,
            rng,
            profile,
            slotState,
          );
          chosenTok = picked.token;
          chosenStr = picked.str;
          iterationsUntilFeasible = picked.iterations;
          chosenProb = probabilities.get(picked.token) ?? 0; // pre-mask prob (a fallback closer may carry ~0)
        } else {
          const best = ranked[0];
          chosenTok = best.token;
          chosenStr = best.str;
          chosenProb = best.prob;
          // regret = p(best_masked) − p(best_feasible). best_masked is the unconstrained argmax prob;
          // best_feasible is ranked[0].prob. 0 when the model's own pick was already feasible (preferTok
          // is ranked[0]). RECORD a choice point iff regret clears θ AND a genuine alternative exists.
          const regret = preferProb - best.prob;
          if (regret > theta && ranked.length >= 2) {
            hooks.onChoicePoint({
              position: backend.position(),
              step,
              prefix,
              logprobBefore: totalLogprob, // the running total here EXCLUDES this step's token (added below).
              ranked,
              regret,
              tried: 1, // ranked[0] is committed this pass.
            });
          }
        }
      } else {
        const picked = pickConstrained(
          scanner,
          prefix,
          probabilities,
          eosTokens,
          closeable,
          topK,
          wideK,
          model,
          temperature,
          rng,
          profile,
          slotState,
        );
        chosenTok = picked.token;
        chosenStr = picked.str;
        iterationsUntilFeasible = picked.iterations;
        chosenProb = probabilities.get(picked.token) ?? preferProb;
      }

      // CONTESTED-PICK OVERRIDE (proxy / lookahead) — AFTER the constrained pick, at τ≤0, let an
      // `onContestedPick` hook replace the committed token when the model's masked top pick was content yet
      // greedy collapsed to a closer (the label-bias case). The hook recomputes the contested condition from
      // the args + owns its tier telemetry, returning a replacement or null. Greedy/rollback pass no hook, so
      // this is skipped — byte-identical to today's walk. (The replacement is still oracle-feasible: the hook
      // only ever returns a token the constraint admits at `prefix`.)
      if (hooks?.onContestedPick && temperature <= 0) {
        const repl = await hooks.onContestedPick({
          backend,
          scanner,
          prefix,
          probabilities,
          closeable,
          wideK,
          profile,
          slotState,
          greedyTok: chosenTok,
          greedyStr: chosenStr,
          preferStr,
          preferKind,
        });
        if (repl !== null) {
          chosenTok = repl.token;
          chosenStr = repl.str;
          chosenProb = probabilities.get(repl.token) ?? chosenProb;
        }
      }

      if (chosenTok !== preferTok) telemetry.overruledSteps++;

      // TAIL-PICK TELEMETRY — the off-policy-contamination counter. Drift INSIDE the model's uncertainty
      // is free (any token the model itself considered plausible is ordinary sampling variance); the harm
      // concentrates in TAIL picks — committing a token from the model's <threshold probability pool makes
      // it condition on text it considers implausible. Record the PRE-MASK probability of the token
      // actually committed; count + accumulate when it falls below the threshold. Constrained path only
      // (the control's pick IS the argmax); force-emit/backtick-tolerance steps `continue` above and are
      // never counted here (forced slots are constraint-determined, tracked as `forcedSlots`).
      const tailThreshold = ctx.tailThreshold ?? 0.05;
      if (chosenProb < tailThreshold) {
        telemetry.tailPicks++;
        telemetry.tailMass += chosenProb;
      }
    }

    ctx.onStep?.({
      prefix,
      preferStr,
      preferKind,
      preferProb,
      top2Margin,
      iterationsUntilFeasible,
      closeable,
      chosenStr,
    });

    // EXPLAIN tap — same StepExplain shape built via the SHARED
    // buildStepExplain. topIds = the top-`explainTopK` ids of the prob-desc distribution; chosenId =
    // the constrained pick. `scanner` is present on the constrained path; on the control there is none.
    if (ctx.onExplain && scanner) {
      const topIds: Id[] = [];
      for (const [tok] of probabilities) {
        topIds.push(tok);
        if (topIds.length >= ctx.explainTopK) break;
      }
      ctx.onExplain(
        buildStepExplain<Id>({
          index: step,
          prefixBefore: prefix,
          topIds,
          chosenId: chosenTok,
          getLogit: probOf,
          decode: decodeId,
          scanner,
          // Thread the step's value-slot state + profile so the omitted veto reasons cover the type-derived
          // structure rules + the profile rules, not just grammar/Σ.
          ...(slotState !== undefined ? { slotState } : {}),
          ...(profile !== undefined ? { profile } : {}),
          // OPT-IN non-lazy nucleus mode (a sweep's `--log-nucleus`) — omitted ⇒ StepExplain.nucleus stays
          // undefined, byte-identical to today's lazy-only record.
          ...(ctx.explainNucleusMass !== undefined ? { nucleusMass: ctx.explainNucleusMass } : {}),
        }),
      );
    }

    if (eosTokens.has(chosenTok)) {
      // EOS chosen at a closeable prefix — the program completes here. EOS carries no string; its log-prob
      // is the mass the model put on ending (chosenProb), folded in uniformly so a completion's totalLogprob
      // includes the decision to stop.
      totalLogprob += logProb(chosenProb);
      endedAtEos = true;
      break;
    }

    prefix += chosenStr;
    telemetry.generatedTokens++;
    totalLogprob += logProb(chosenProb);

    // ADVANCE: commit the chosen token into the KV and read the successor distribution for the next step.
    // The backend carries the same G3 restore-or-abort guard the inline loop had (a failed commit that
    // advanced the KV is rolled back to the pre-commit boundary before the error propagates).
    await backend.commit([chosenTok]);
  }

  return { prefix, totalLogprob, endedAtEos };
}
