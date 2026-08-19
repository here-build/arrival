// step-explain.ts — the SHARED, pure per-decode-step EXPLAIN record + bucketing (primitive 1 kernel).
//
// WHAT THIS IS. The transparency record for the constrained decode: per step, "what did the model WANT vs
// what did the constraint ALLOW". It mirrors the decode's LAZY probability-reduction walk — descend the
// model's prob-ranked tokens, reject (omit) the masked ones until the FIRST feasible token (the chosen), then
// stop. So the record is exactly:
//   • `omitted` — the tokens the model preferred OVER the chosen that the constraint VETOED, each tagged with
//     the decisive {@link VetoReason} code (the catalog RuleId, or base `"structural"`/`"sigma"`). This IS the
//     over-masking signal AND the per-rule attribution in one — a sweep aggregates `omitted[].reason`.
//   • `chosen` — the first feasible token (the committed pick).
//   • `tail` — ONE peek at the highest-prob token PAST chosen that the lazy walk never examined.
//   • `rank` — how deep the constraint reached = `omitted.length` (0 ⇒ the model's argmax was already valid).
//   • `entropy` — ALWAYS computed: `-Σ p·log(p)` over the tracked top-K window (the model's raw uncertainty
//     this step, independent of the constraint).
//
// By DEFAULT it is NOT a whole-top-K classification (the old `alsoValid`/`noGo` shape was — it tested every
// candidate, work the lazy decoder never does): `buildStepExplain` walks only up to the chosen token + one
// tail peek. An OPT-IN non-lazy mode exists for a sweep that wants the richer trace: pass `nucleusMass` (e.g.
// `0.95`) and the walk ALSO cumulates probability mass over `topIds` to that threshold, classifying every
// candidate in the nucleus (`grammarOK`/`typeOK`/`feasible`) — `StepExplain.nucleus`. Omitted (the default)
// ⇒ byte-identical cost/output to the lazy-only record; this is the substrate for the mechanistic-divergence
// story (comparing where two decode paths' nuclei diverge), not something the shipping greedy loop pays for.
//
// `buildStepExplain` takes PLAIN DATA only (no Tensor, no node-llama-cpp Token, no tokenizer object) so it
// stays browser-safe and node-safe alike, and threads the step's `slotState`/`profile` so the veto reasons
// cover the type-derived + profile rules (not just grammar/Σ).

import { classifyCandidate, type ToolCallProfile } from "./mask-compiler.js";
import type { OracleScanner, OracleState } from "./oracle-types.js";
import { GRAMMAR_RULE_IDS, TYPE_STRUCTURE_RULE_IDS, type RuleId } from "./rules.js";

/** Why a candidate was vetoed: the most specific catalog {@link RuleId} (e.g. `R-HEAD-IS-SYMBOL`) when a rule
 *  was decisive, else the base reason — `"structural"` (the grammar/balance reject `scanner.feasible` made,
 *  not a catalog rule) or `"sigma"` (a generic unbound-symbol Σ mask with no catalog rule). */
export type VetoReason = RuleId | "structural" | "sigma";

/** One token the constraint MASKED on the way to the chosen token — a token the model ranked ABOVE the pick
 *  that was vetoed. Carries the model probability (the over-masking weight) and the decisive {@link VetoReason}. */
export interface OmittedToken {
  /** The decoded token chunk. */
  readonly token: string;
  /** The model's probability for this token (its score in the prob-desc walk). */
  readonly probability: number;
  /** The decisive veto code — the catalog RuleId, or base `"structural"`/`"sigma"`. */
  readonly reason: VetoReason;
}

/** A token with its model probability — the `chosen` pick and the `tail` peek (no veto reason: chosen was
 *  admitted, tail was never tested). */
export interface TokenPick {
  /** The decoded token chunk (`""` for an EOS / special committed token). */
  readonly token: string;
  /** The model's probability for this token. */
  readonly probability: number;
}

/** One candidate in the NON-LAZY nucleus classification (opt-in — see {@link BuildStepExplainArgs.nucleusMass}):
 *  a token from the prob-mass-`nucleusMass` nucleus, classified via the SAME {@link classifyCandidate} the
 *  lazy walk uses, but reporting the TWO-AXIS verdict rather than a single veto reason. `grammarOK` is false
 *  iff a {@link GRAMMAR_RULE_IDS} rule fired OR the candidate failed the base structural/balance check
 *  (`scanner.feasible` — a grammar-level reject with no catalog rule); `typeOK` is false iff a
 *  {@link TYPE_STRUCTURE_RULE_IDS} rule fired. A candidate rejected on a THIRD axis this pair doesn't cover
 *  (Σ symbol-binding, or an opt-in kwargs/positional-keyed profile shape) reports both `true` with
 *  `feasible: false` — the two booleans are a partition of the catalog's grammar/type groups, not the whole
 *  verdict space; read `feasible` for the ground truth. */
export interface NucleusToken {
  /** The decoded token chunk. */
  readonly token: string;
  /** The model's probability for this token. */
  readonly probability: number;
  /** Would the constraint admit this token overall (`classifyCandidate(...) === "feasible"`)? */
  readonly feasible: boolean;
  /** False iff the decisive veto was a tool-call GRAMMAR tightening ({@link GRAMMAR_RULE_IDS}) or the base
   *  structural/balance reject (no catalog rule — `scanner.feasible` failed outright). */
  readonly grammarOK: boolean;
  /** False iff the decisive veto was a TYPE-DERIVED structure gate ({@link TYPE_STRUCTURE_RULE_IDS}). */
  readonly typeOK: boolean;
}

/** One decode step's explanation, mirroring the lazy probability-reduction walk. */
export interface StepExplain {
  /** 0-based decode step. */
  readonly index: number;
  /** The accepted generated prefix this step extends. */
  readonly prefixBefore: string;
  /** How deep the constraint reached before the chosen token = `omitted.length`. 0 ⇒ the model's argmax was
   *  already feasible (the constraint was passive this step). */
  readonly rank: number;
  /** The tokens the model preferred OVER the chosen that the constraint VETOED — in prob-descending order,
   *  each with its decisive {@link VetoReason}. The over-masking signal AND the per-rule attribution. */
  readonly omitted: OmittedToken[];
  /** The first feasible token — the one actually committed. */
  readonly chosen: TokenPick;
  /** A single peek at the highest-prob token PAST chosen the lazy walk never examined (untested ⇒ no reason).
   *  `undefined` when chosen was the last tracked token. */
  readonly tail: TokenPick | undefined;
  /** Shannon entropy (nats), `-Σ p·log(p)` over `topIds` (the tracked top-K window BEFORE the constraint) —
   *  the model's raw uncertainty this step. ALWAYS computed (one extra pass over the already-fetched
   *  `topIds`; cheap, and `onExplain` itself is the opt-in gate for the whole record). Entries with
   *  `p <= 0` contribute 0 (NaN-safe). Note: meaningful only when `getLogit` returns true probabilities
   *  (the llama/node decode path) — a caller passing raw logits gets the same formula over the wrong axis,
   *  an existing ambiguity in {@link BuildStepExplainArgs.getLogit}'s dual contract, not introduced here. */
  readonly entropy: number;
  /** NON-LAZY nucleus classification: every candidate in the prob-mass-`nucleusMass` nucleus (not just the
   *  ones up to `chosen`), each tagged `grammarOK`/`typeOK`/`feasible`. `undefined` unless the caller passed
   *  {@link BuildStepExplainArgs.nucleusMass} (opt-in; the default lazy walk never computes this). */
  readonly nucleus: NucleusToken[] | undefined;
}

/** Plain-data inputs to {@link buildStepExplain} — no Tensor, no Token, no tokenizer object, so BOTH the
 *  browser path and the node llama.cpp path can call it with their own primitives. `Id` carries the caller's
 *  id BRAND through the boundary; the OUTPUT {@link StepExplain} is plain serializable data. */
export interface BuildStepExplainArgs<Id extends number = number> {
  /** 0-based decode step. */
  readonly index: number;
  /** The accepted generated prefix this step extends. */
  readonly prefixBefore: string;
  /** The top-K ids the model considered, in DESCENDING score (logit/probability) order. */
  readonly topIds: readonly Id[];
  /** The committed token id (the constrained pick). An id absent from `topIds` (or `< 0`) ⇒ no committed
   *  token in the tracked window (a forced close / fallback): `chosen` is the empty pick and `rank` is -1. */
  readonly chosenId: Id;
  /** id → score (raw logit on the browser path; probability on the llama path — same ordering). */
  readonly getLogit: (id: Id) => number;
  /** id → decoded chunk string. Ids that decode to `""`/undefined (special/EOS) are skipped as candidates. */
  readonly decode: (id: Id) => string | undefined;
  /** The oracle scanner — `makeOracle(grantEnv)` (Σ-live) or `makeOracle()` (structural). */
  readonly scanner: OracleScanner;
  /** The step's VALUE-SLOT state (the rebased `slotState` the decode loop computed) — threaded so the veto
   *  reasons cover the type-derived structure rules (R-ARRAY-REJECTS-SCALAR, …), not just grammar/Σ. Omit on
   *  the unconstrained/structural-only path (the structure rules stay inert). */
  readonly slotState?: OracleState;
  /** The opt-in kwargs / positional-keyed profile — threaded so the profile rules (R-KWARGS-*, R-POSKEYED-*)
   *  attribute. Omit when no profile is active. */
  readonly profile?: ToolCallProfile;
  /** OPT-IN non-lazy nucleus mode: when set, ALSO cumulate probability mass over `topIds` (already
   *  prob-descending) up to this threshold (e.g. `0.95`) and classify EVERY token in that nucleus via
   *  {@link classifyCandidate} — not just the tokens up to `chosen`+1 tail. Adds an O(nucleus-size)
   *  classification pass on top of the lazy walk's O(rank); omitted (the default) ⇒ identical cost/output
   *  to today's lazy-only record (`StepExplain.nucleus` is `undefined`). If the tracked `topIds` window
   *  doesn't reach `nucleusMass` cumulative probability, the nucleus is simply as much of it as `topIds`
   *  covers (not an error — the caller controls the window size via its own top-K knob). */
  readonly nucleusMass?: number;
}

/**
 * Build one {@link StepExplain} from plain per-step data, mirroring the decode's LAZY walk. Descend `topIds`
 * (prob-descending); each token BEFORE the chosen one is classified once via {@link classifyCandidate} (the
 * SAME oracle path the mask uses, now with `slotState`/`profile` so every rule attributes) — a masked token
 * joins `omitted` with its decisive {@link VetoReason}; the chosen token is recorded and the walk STOPS, with
 * one `tail` peek at the next untested token. `rank = omitted.length`.
 *
 * The reason capture: `classifyCandidate` fires `onRuleHit` for the decisive rule; we keep the last MASKED
 * rule id (a forgive `admitted` hit like R-ATOM-STAYS-OPEN is not a veto reason). When no catalog rule fired
 * (a base feasibility reject or a generic unbound-symbol Σ mask), the reason falls back to the candidate class.
 */
export function buildStepExplain<Id extends number = number>(args: BuildStepExplainArgs<Id>): StepExplain {
  const { index, prefixBefore, topIds, chosenId, getLogit, decode, scanner, slotState, profile, nucleusMass } = args;

  const omitted: OmittedToken[] = [];
  let chosen: TokenPick = { token: "", probability: Number.NaN };
  let tail: TokenPick | undefined;
  let found = false;

  for (let i = 0; i < topIds.length; i++) {
    const id = topIds[i];
    if (id === chosenId) {
      chosen = { token: decode(id) ?? "", probability: getLogit(id) };
      found = true;
      // tail — the first DECODABLE token past chosen the lazy walk never examined (no reason: untested).
      for (let j = i + 1; j < topIds.length; j++) {
        const ts = decode(topIds[j]);
        if (ts !== undefined && ts !== "") {
          tail = { token: ts, probability: getLogit(topIds[j]) };
          break;
        }
      }
      break; // LAZY: the decode stops at the first feasible token; so does the explanation.
    }
    const str = decode(id);
    if (str === undefined || str === "") continue; // a special/EOS non-chosen id — not a classifiable candidate.
    // Classify this preferred-over-chosen candidate; capture the decisive MASKING rule (ignore forgive admits).
    let ruleId: RuleId | null = null;
    const klass = classifyCandidate(scanner, prefixBefore, str, profile, slotState, (hit) => {
      if (hit.decision === "masked") ruleId = hit.ruleId;
    });
    // In the greedy walk every token before the chosen is masked. A feasible-but-not-chosen token (a
    // non-greedy strategy passed it over) is neither omitted nor chosen — it is simply not listed.
    if (klass !== "feasible") omitted.push({ token: str, probability: getLogit(id), reason: ruleId ?? klass });
  }

  // rank = how deep the constraint reached. With chosen found in the window it is exactly the count of
  // masked-preferred tokens (`omitted.length`); if the committed token is outside the tracked window
  // (a forced close / fallback) there is no in-window depth → -1.
  const rank = found ? omitted.length : -1;

  // ENTROPY — always computed (cheap: one more pass over the already-fetched topIds; onExplain itself is
  // the opt-in gate for the whole record). -Σ p·log(p) over the tracked top-K window, p<=0 skipped.
  let entropy = 0;
  for (const id of topIds) {
    const p = getLogit(id);
    if (p > 0) entropy -= p * Math.log(p);
  }

  // NUCLEUS — opt-in NON-LAZY classification: cumulate probability mass over topIds (prob-descending) up
  // to `nucleusMass`, classifying EVERY decodable candidate along the way (not just up to `chosen`).
  let nucleus: NucleusToken[] | undefined;
  if (nucleusMass !== undefined) {
    nucleus = [];
    let cum = 0;
    for (const id of topIds) {
      if (cum >= nucleusMass) break;
      const p = getLogit(id);
      cum += p > 0 ? p : 0;
      const str = decode(id);
      if (str === undefined || str === "") continue; // non-decodable (EOS/special) — mass counted, not classified.
      let ruleId: RuleId | null = null;
      const klass = classifyCandidate(scanner, prefixBefore, str, profile, slotState, (hit) => {
        if (hit.decision === "masked") ruleId = hit.ruleId;
      });
      const feasible = klass === "feasible";
      // grammarOK: false iff a catalog GRAMMAR rule fired, OR a base structural/balance reject fired with NO
      // catalog rule at all (ruleId null under klass "structural" — scanner.feasible failed outright).
      const grammarOK = feasible || !(klass === "structural" && (ruleId === null || GRAMMAR_RULE_IDS.has(ruleId)));
      // typeOK: false iff a catalog TYPE-DERIVED structure rule fired.
      const typeOK = feasible || !(ruleId !== null && TYPE_STRUCTURE_RULE_IDS.has(ruleId));
      nucleus.push({ token: str, probability: p, feasible, grammarOK, typeOK });
    }
  }

  return { index, prefixBefore, rank, omitted, chosen, tail, entropy, nucleus };
}
