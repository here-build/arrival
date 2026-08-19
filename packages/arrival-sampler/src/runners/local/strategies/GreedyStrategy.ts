// strategies/GreedyStrategy.ts — baseline constrained greedy (first feasible under the oracle).
//
// One policy over the substrate. Other strategies (in this dir) provide alternative strategic search
// (backtracking, branching) within the same guarantees. Shared descent. Node-only.

import { greedyDescend } from "./common/greedyDescend.js";
import type { DecodeContext, DecodeResult, IdPolyDecodeStrategy } from "./common/types.js";
import { extractSchemeForm } from "../../generate.js";

/**
 * GREEDY — today's constrained greedy argmax, lifted VERBATIM from the inline loop (the parity baseline).
 *
 * Per step (in {@link greedyDescend}, with NO hooks): read the backend's distribution; the unconstrained
 * argmax (preferStr) for the metric; the Σ∩T warm-up; the once-per-step slot state; the singleton force-
 * emit fast path; then the constrained pick via `pickConstrained` (first-feasible walk + widen + structural-
 * fallback, all inside `selectConstrainedStep`) or the plain argmax on the unconstrained control; the
 * `onStep` + `onExplain` taps; the EOS break; and the single-token commit. The proxy / lookahead / branch
 * tiers are NOT part of greedy and are absent — for `"greedy"` they are inert in the inline loop too, so
 * output is token-identical (gate: loop-parity). Greedy never forks, so the single-path prefix IS the
 * whole decode (no resolved-arm short-circuit).
 */
export const GreedyStrategy: IdPolyDecodeStrategy = {
  async decode<Id extends number>(ctx: DecodeContext<Id>): Promise<DecodeResult> {
    const { prefix } = await greedyDescend(ctx, ctx.prefix, 0, 0);
    return { program: extractSchemeForm(prefix), rawDecode: prefix, telemetry: ctx.telemetry };
  },
};
