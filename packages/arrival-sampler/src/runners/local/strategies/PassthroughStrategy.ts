// strategies/PassthroughStrategy.ts — unconstrained passthrough (raw model argmax, no oracle).
//
// Useful as a baseline to measure the effect of the substrate. Demonstrates the seam accepts policies
// that ignore constraints. Node-only.

import type { DecodeContext, DecodeResult, IdPolyDecodeStrategy } from "./common/types.js";
import { extractSchemeForm } from "../../generate.js";

/**
 * PASSTHROUGH — the model's raw argmax each step, NO feasible filter, commit until EOS / cap. The
 * PLUGGABILITY PROOF for the strategy seam: a second `DecodeStrategy` that shares the runner's route and
 * Backend but composes NEITHER the kernel nor the oracle. It is what the model wanted, unconstrained —
 * structurally the inline control path (`!opts.constrained`) generalized to a strategy, but it never gates
 * even when a scanner is present. Its output is NOT guaranteed to be valid Scheme (it can emit prose, an
 * unbalanced form, anything the base model prefers) — that is precisely the point: the seam accepts a
 * strategy that decodes differently from greedy, so a richer search (rollback/beam) plugs in the same way.
 *
 * Fires `onStep` (preferKind always "feasible" — no oracle overrules; iterationsUntilFeasible always 1) so a
 * smoke can observe the picks; skips `onExplain` (which needs the scanner's bucket classification). EOS ends
 * the program; the extracted form is whatever `extractSchemeForm` lifts out of the raw decode (possibly the
 * empty string when no balanced form exists — a faithful signal that passthrough wandered off-grammar).
 */
export const PassthroughStrategy: IdPolyDecodeStrategy = {
  async decode<Id extends number>(ctx: DecodeContext<Id>): Promise<DecodeResult> {
    const { backend, scanner, maxNewTokens, telemetry } = ctx;
    const { model, eosIds: eosTokens } = backend;
    let prefix = ctx.prefix;

    for (let step = 0; step < maxNewTokens; step++) {
      const dist = backend.stepDistribution();
      if (dist === undefined) break; // no successor distribution — stop.
      if (ctx.shouldStop?.()) break; // cooperative abort.

      // The model's raw argmax — the first (highest-prob) entry. No oracle, no widen, no fallback.
      const top1: [Id, number] | undefined = dist.entries().next().value;
      if (top1 === undefined) break;
      const chosenTok = top1[0];
      const preferProb = top1[1];
      const chosenStr = model.detokenize([chosenTok]);

      ctx.onStep?.({
        prefix,
        preferStr: chosenStr,
        preferKind: "feasible", // no constraint — the model's pick is taken as-is.
        preferProb,
        top2Margin: 0,
        iterationsUntilFeasible: 1, // argmax is always taken at rank 1.
        closeable: scanner ? scanner.analyze(prefix).closeable : true,
        chosenStr,
      });

      if (eosTokens.has(chosenTok)) break;

      prefix += chosenStr;
      telemetry.generatedTokens++;
      await backend.commit([chosenTok]);
    }

    return { program: extractSchemeForm(prefix), rawDecode: prefix, telemetry };
  },
};
