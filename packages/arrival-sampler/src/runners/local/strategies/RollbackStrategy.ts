// rollback-strategy.ts — regret-driven backtracking strategy over the constrained substrate.
//
// Allows the system to explore higher-total-logprob valid paths when greedy commits to a locally-feasible
// but globally-suboptimal choice. Part of the substrate's strategic search toolkit. See llama-cpp-generate.ts.
//
// THE ALGORITHM (greedy spine + backtrack on regret):
//   • greedyDescend (the SHARED descent from ./greedyDescend.ts) walks the greedy constrained pick from the
//     backend's CURRENT state to EOS/cap, tracking the path's TOTAL LOG-PROB and RECORDING a CHOICE POINT at
//     each step where the REGRET `p(best_masked) − p(best_feasible)` clears θ AND ≥2 feasible arms exist —
//     i.e. where the model strongly preferred a token the oracle overruled, and a real alternative exists.
//   • PASS 0: greedyDescend from the prompt → the BASELINE completion {prefix, totalLogprob, endedAtEos} (the
//     greedy floor) + the choice points.
//   • BACKTRACK PASSES (≤ K): take the recorded choice point with the HIGHEST regret that still has an UNTRIED
//     feasible alternative; `rewind` the backend to its position; commit that arm's next untried feasible from
//     the CACHED distribution (never re-evaluating the model at the rewound node); greedyDescend onward → a new
//     completion (+ new downstream choice points, merged into the pool).
//   • RETURN the VALID completion with the highest total log-prob. Greedy is the FLOOR — rollback ties or
//     beats it (a complete/closeable completion is preferred over an incomplete one; among equally-valid
//     completions the higher total log-prob wins).
//
// K=0 ≡ GREEDY EXACTLY: with no backtrack budget only pass 0 runs, and pass 0's COMMITTED stream is the
// greedy stream (the choice-point hook only OBSERVES — it never changes the pick). So `RollbackStrategy` at
// K=0 produces the byte-identical program `GreedyStrategy` does. Rollback is ADDITIVE: a non-rollback run
// (greedy/passthrough, or rollback K=0) is unchanged.
//
// TESTABILITY: rollback drives only the ABSTRACT `DecodeBackend` (distribution / detokenize / commit /
// rewind / position) — so its whole search is exercised model-free by a SCRIPTED backend (a canned
// position/prefix → ranked distribution map). See `../backends/ScriptedDecodeBackend.ts` + rollback-strategy.test.ts.
//
// Node-only decode runtime (the `DecodeContext` it decodes within wraps the node-llama-cpp backend in
// production), so it lives in `src/decode/` and is excluded from the published browser `.` entry.

import { greedyDescend } from "./common/greedyDescend.js";
import type { ChoicePoint, DecodeContext, DecodeResult, DescentResult, IdPolyDecodeStrategy } from "./common/types.js";
import { extractSchemeForm } from "../../generate.js";

/** The rollback telemetry — the search's cost + payoff. Surfaced beside the `DecodeResult` for a runner /
 *  test to read (the runner folds these into its `LlamaGenTelemetry` superset). */
export interface RollbackTelemetry {
  /** How many backtracks were spent (≤ K). Each is one rewind + one alternative-arm onward descent. */
  backtracksUsed: number;
  /** How many full completions were explored (1 baseline + one per backtrack). */
  completionsExplored: number;
  /** Whether a backtrack completion BEAT the greedy baseline (a more-complete or higher-log-prob valid
   *  program replaced the pass-0 floor). False ⇒ greedy was already the best (rollback tied — never worse). */
  improvedOverGreedy: boolean;
}

/**
 * THE RANKING (greedy is the floor; rollback ties or beats it). A complete/closeable completion
 * (`endedAtEos` — the descent chose to stop at a legal end) is ALWAYS preferred over an incomplete one (a
 * valid program beats an invalid one regardless of log-prob); among completions of EQUAL completeness the
 * higher total log-prob wins. Returns true iff `cand` should REPLACE `best`.
 */
function beats(cand: DescentResult, best: DescentResult): boolean {
  if (cand.endedAtEos !== best.endedAtEos) return cand.endedAtEos;
  return cand.totalLogprob > best.totalLogprob;
}

/**
 * ROLLBACK — the greedy spine with backtracking on regret. `K` (the per-program backtrack budget) and θ
 * (the regret threshold) are threaded from the runner's options via {@link makeRollbackStrategy}; the
 * default `K=3`, `θ=0.25` are the confirmed params. The strategy returns the standard {@link DecodeResult};
 * its {@link RollbackTelemetry} is exposed via the factory's `lastTelemetry` getter for the runner/tests.
 */
export function makeRollbackStrategy(
  maxBacktracks: number,
  theta: number,
): IdPolyDecodeStrategy & { readonly lastTelemetry: RollbackTelemetry } {
  let lastTelemetry: RollbackTelemetry = {
    backtracksUsed: 0,
    completionsExplored: 0,
    improvedOverGreedy: false,
  };

  return {
    get lastTelemetry(): RollbackTelemetry {
      return lastTelemetry;
    },

    async decode<Id extends number>(ctx: DecodeContext<Id>): Promise<DecodeResult> {
      const { backend } = ctx;
      // The choice-point pool, keyed by PREFIX (one entry per distinct accepted prefix — same prefix ⇒ same
      // cached distribution ⇒ same arms, with a SHARED `tried` counter). A descent records into here via the
      // `onChoicePoint` hook; a backtrack's onward descent merges its new downstream points the same way.
      const pool = new Map<string, ChoicePoint<Id>>();
      const record = (cp: ChoicePoint<Id>): void => {
        // Same prefix already pooled ⇒ keep the existing entry (its `tried` counter is the live one). Two
        // passes through one prefix yield identical arms, so the first record is canonical.
        if (!pool.has(cp.prefix)) pool.set(cp.prefix, cp);
      };
      const hooks = { onChoicePoint: record, regretTheta: theta };

      // PASS 0 — greedy from the prompt. The committed stream IS the greedy stream (the hook only observes),
      // so at K=0 this is the entire decode and equals GreedyStrategy byte-for-byte.
      let best: DescentResult = await greedyDescend(ctx, ctx.prefix, 0, 0, hooks);
      let completionsExplored = 1;
      let backtracksUsed = 0;
      let improvedOverGreedy = false;

      // BACKTRACK PASSES — up to K. Each takes the highest-regret choice point with an untried alternative,
      // rewinds to it, commits the next untried feasible arm from the CACHE, and descends onward.
      while (backtracksUsed < maxBacktracks) {
        const cp = highestRegretUntried(pool);
        if (cp === undefined) break; // every recorded choice point is exhausted — nothing left to try.

        const alt = cp.ranked[cp.tried]; // the next untried feasible arm (tried ≥ 1 ⇒ this is an alternative).
        cp.tried++;
        backtracksUsed++;

        // REWIND the backend to the fork: erase every committed token after `cp.position`. After this the
        // cursor is back at the fork; the cached `cp.ranked` IS the distribution there (we never re-evaluate
        // the model at a rewound node — the cache is the ground truth, the §rollback contract).
        await backend.rewind(cp.position, backend.position());

        // The absolute log-prob of the path THROUGH this alternative arm (path-to-fork + this arm's mass) —
        // the base the onward descent accumulates from, so all completions compare on one scale.
        const armLogprob = cp.logprobBefore + safeLog(alt.prob);

        let completion: DescentResult;
        if (alt.str === "") {
          // The alternative arm is the EOS/"end here" event — the completion IS `cp.prefix`, closed at EOS.
          // No token to commit, no onward descent: the program completes at the fork.
          completion = { prefix: cp.prefix, totalLogprob: armLogprob, endedAtEos: true };
        } else {
          // Commit the alternative's first token from the fork (advancing the KV + producing the successor
          // distribution the onward descent reads), then greedyDescend onward from `cp.prefix + alt.str`.
          await backend.commit([alt.token]);
          completion = await greedyDescend(ctx, cp.prefix + alt.str, cp.step + 1, armLogprob, hooks);
        }

        completionsExplored++;
        if (beats(completion, best)) {
          best = completion;
          improvedOverGreedy = true; // a backtrack replaced the greedy baseline.
        }
      }

      lastTelemetry = { backtracksUsed, completionsExplored, improvedOverGreedy };

      const prefix = best.prefix;
      return { program: extractSchemeForm(prefix), rawDecode: prefix, telemetry: ctx.telemetry };
    },
  };
}

/** The recorded choice point with the HIGHEST regret that still has an UNTRIED feasible alternative
 *  (`tried < ranked.length`). Linear over the pool (small — ≤ one entry per decode step). Undefined when
 *  every point is exhausted. */
function highestRegretUntried<Id extends number>(
  pool: ReadonlyMap<string, ChoicePoint<Id>>,
): ChoicePoint<Id> | undefined {
  let best: ChoicePoint<Id> | undefined;
  for (const cp of pool.values()) {
    if (cp.tried >= cp.ranked.length) continue; // exhausted — no untried arm.
    if (best === undefined || cp.regret > best.regret) best = cp;
  }
  return best;
}

/** log(p) with a finite floor for p≤0 — a feasible arm always has p>0 in practice, but a cached prob can be
 *  0 if the arm came from the structural fallback (not the distribution); guard so the scale stays real. */
function safeLog(p: number): number {
  return p > 0 ? Math.log(p) : -1e9;
}
