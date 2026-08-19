// pick-constrained.ts — the per-step constrained pick + its StepMetric record, in the shared decision layer.
//
// WHY THIS MODULE EXISTS: `pickConstrained` is the per-step feasibility decision (it wraps the shared
// `selectConstrainedStep`), and `StepMetric` is the per-step record both the runner and the metrics
// harness write. BOTH the runner (`llama-cpp-generate.ts`) and the strategy (`decode-strategy.ts`) need
// them. Defining them in the runner inverted the architecture's one-way dependency (kernel ← strategy →
// backend): the strategy imported the pick from the runner while the runner imported the strategy's
// `GreedyStrategy`/`PassthroughStrategy` — a cycle. They live HERE, the neutral layer both import DOWN
// into, so the strategy never reaches back up to the runner.
//
// It still touches the model's detokenize surface (`model.detokenize` to turn token ids into strings) — its
// MINIMAL {@link ForceEmitModel} slice, not the full node-llama handle — so it lives in `src/decode/`
// (Node-only decode runtime) rather than the substrate-free `src/` core.

import type { Token } from "node-llama-cpp";

import type { ForceEmitModel } from "../../force-emit.js";
import type { ToolCallProfile } from "../../mask-compiler.js";
import type { OracleScanner, OracleState } from "../../oracle-types.js";
import { tempSample } from "../../sampling.js";
import { selectConstrainedStep } from "../../select-constrained-step.js";

/** Per-step record, mirroring the StepMetric the onnx metrics harness would record. `preferStr` is the
 *  UNCONSTRAINED argmax (what the model wanted); the constraint may overrule it. */
export interface StepMetric {
  /** The accepted generated prefix this step extends (before the chosen token) — lets the harness
   *  rebuild its richer StepMetric (3-way classify, attempted-atom, arity) with the same oracle calls. */
  readonly prefix: string;
  /** The unconstrained argmax token string (the model's top pick before the oracle). */
  readonly preferStr: string;
  /** How the unconstrained argmax classifies against the oracle: would it have been feasible? */
  readonly preferKind: "feasible" | "infeasible";
  /** The probability of the unconstrained argmax. */
  readonly preferProb: number;
  /** Probability GAP between the top-1 and top-2 tokens (the prob analogue of the logit top2Margin —
   *  NOTE the axis change: a probability difference in [0,1], not a logit margin). */
  readonly top2Margin: number;
  /** How many candidates we walked (in prob-descending order) before the first feasible one. `1` ⇒
   *  the unconstrained argmax was already feasible (the oracle did not overrule the model). */
  readonly iterationsUntilFeasible: number;
  /** Whether the program is closeable (EOS-admissible) at this prefix. */
  readonly closeable: boolean;
  /** The token string actually chosen (the constrained argmax, or EOS). */
  readonly chosenStr: string;
}

/**
 * The constrained pick. With `temperature <= 0` it is the greedy constrained-argmax: walk the
 * prob-descending distribution and return the FIRST feasible candidate (keepN=1), exactly as
 * the reference path does over the full vocab — fast, early-return, no extra oracle calls.
 *
 * With `temperature > 0` it COLLECTS the feasible candidates in the top-K (widening to `wideK` if none),
 * then samples one with {@link tempSample}. Sampling stays inside the feasible set, so the program is
 * valid by construction at any temperature. `iterations` always reports the rank of the FIRST feasible
 * candidate (the model-preference-vs-feasibility metric), independent of which candidate was sampled.
 *
 * EOS is a valid candidate iff the prefix is closeable. If even the widened scan finds nothing feasible,
 * returns EOS when closeable, else throws (the genuine over-constrained state).
 *
 * EXPORTED so the loop-parity test can drive the OLD `evaluateWithMetadata` generator stepping through
 * the IDENTICAL pick — isolating the stepping mechanism (generator vs controlledEvaluate) as the only
 * variable under test. Reusing this function (not a re-implementation) is what makes the parity test
 * prove behavior-preservation of the rewrite rather than the test's own fidelity.
 */
export function pickConstrained<Id extends number = Token>(
  scanner: OracleScanner,
  prefix: string,
  probabilities: ReadonlyMap<Id, number>,
  eosTokens: ReadonlySet<Id>,
  closeable: boolean,
  topK: number,
  wideK: number,
  model: ForceEmitModel<Id>,
  temperature: number,
  rng: () => number,
  profile?: ToolCallProfile,
  slotState?: OracleState,
): { token: Id; str: string; iterations: number } {
  // THE shared per-step feasibility decision. It walks the
  // model's prob-descending tokens, keeps the live ones (collecting up to keepN — 1 for greedy, ∞ for
  // sampling), widens once, and structural-falls-back. EOS competes in the walk (the distribution carries
  // it) via `isEos`. `slotState` threads the type-derived list-structure gate identically to the lazy
  // path — the gate that was DEAD here before this unification. The mask substrate's `keepSet` is unused
  // (we read the ORDERED `kept` to pick/sample); `addId` is omitted (EOS already competes in `kept`).
  const rankedIds = (limit: number): Iterable<Id> => firstNKeys(probabilities, limit);
  // The `Id`-typed callbacks make `selectConstrainedStep` infer that same `Id`, so `kept` comes back
  // `Id[]` and every id flows through cast-free (no `id as Token` membrane on this caller).
  const { kept } = selectConstrainedStep({
    scanner,
    prefix,
    rankedIds,
    idToString: (id) => detokenizeNonEmpty(model, id),
    allIds: () => probabilities.keys(),
    slotState: slotState ?? scanner.analyze(prefix),
    closeable,
    keepN: temperature <= 0 ? 1 : Infinity,
    topK,
    wideK,
    eos: { isEos: (id) => eosTokens.has(id) },
    profile,
  });

  // Structural fallback admitted nothing AND closeable (selectConstrainedStep returns empty `kept`): end.
  // (When NOT closeable it would have thrown inside selectConstrainedStep — the over-constrained state.)
  if (kept.length === 0) return { token: [...eosTokens][0], str: "", iterations: wideK };

  // `iterations` = the model-rank of the FIRST feasible token = its 1-based position in the prob-desc
  // distribution (counting EOS / empty entries it skipped past), preserving the old scan/collect metric.
  const firstRank = rankOf(probabilities, kept[0]);

  if (temperature <= 0) {
    // Greedy: the constrained argmax is the first feasible token.
    const tok = kept[0];
    return { token: tok, str: strOfPick(model, tok, eosTokens), iterations: firstRank };
  }

  // Sampling: draw among the feasible `kept` weighted by each token's step probability.
  const probs = kept.map((id) => probabilities.get(id) ?? 0);
  const idx = tempSample(probs, temperature, rng);
  const tok = kept[idx];
  return { token: tok, str: strOfPick(model, tok, eosTokens), iterations: firstRank };
}

/** The first `limit` keys of a prob-descending Map (the model's top-`limit` ranked token ids). */
function* firstNKeys<Id extends number = Token>(probabilities: ReadonlyMap<Id, number>, limit: number): Iterable<Id> {
  let n = 0;
  for (const tok of probabilities.keys()) {
    if (n++ >= limit) break;
    yield tok;
  }
}

/** `model.detokenize([id])`, mapped to `undefined` for the empty string so the shared walk skips it (an
 *  EOS/control id detokenizes to "" — gated out-of-band via `isEos`, never as a string candidate). */
function detokenizeNonEmpty<Id extends number = Token>(model: ForceEmitModel<Id>, id: Id): string | undefined {
  const str = model.detokenize([id]);
  return str === "" ? undefined : str;
}

/** The string a chosen token contributes: "" for an EOS (the "end here" sentinel), else its detokenization. */
function strOfPick<Id extends number = Token>(model: ForceEmitModel<Id>, tok: Id, eosTokens: ReadonlySet<Id>): string {
  return eosTokens.has(tok) ? "" : model.detokenize([tok]);
}

/** The 1-based position of `id` in the prob-descending Map (matching the old scan/collect `iterations`,
 *  which incremented for EVERY entry visited — including EOS/empty — up to the first feasible). */
function rankOf<Id extends number = Token>(probabilities: ReadonlyMap<Id, number>, id: Id): number {
  let rank = 0;
  for (const tok of probabilities.keys()) {
    rank++;
    if (tok === id) return rank;
  }
  return rank || 1;
}
