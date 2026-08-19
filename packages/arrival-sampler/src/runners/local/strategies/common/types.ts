// strategies/types.ts — STRATEGY layer contracts (pure types).
//
// Contracts for policies that compose kernel + backend. Greedy, rollback, passthrough etc. share
// the descent types.
//
// Node-only decode runtime (the `DecodeBackend` it references drives node-llama-cpp), so it lives in
// `src/decode/` and is excluded from the published browser `.` entry.

import type { Token } from "node-llama-cpp";

import type { ToolCallProfile } from "../../../../mask-compiler.js";
import type { OracleScanner, OracleState } from "../../../../oracle-types.js";
import type { StepExplain } from "../../../../step-explain.js";
import type { DecodeBackend } from "../../backends/common/types.js";
import type { StepMetric } from "../../pick-constrained.js";

/**
 * The context a {@link DecodeStrategy} decodes within: the backend to drive, the constraint inputs, the
 * decode knobs, and the live telemetry + taps. Carries exactly the closure state the inline loop threaded
 * by hand — so the lift is a relocation, not a rewrite. The `telemetry` object is MUTATED in place (the
 * inline loop did `telemetry.generatedTokens++`); `decode` returns that same reference.
 */
export interface DecodeContext<Id extends number = Token> {
  /** The backend to drive — the model+sequence as data, prefilled to the first decode distribution. The
   *  shared descent uses only the abstract {@link DecodeBackend} ops (distribution / detokenize / commit /
   *  rewind / position / eosIds) PLUS the `model`/`seq` escape hatches the verbatim greedy lift keeps
   *  (force-emit + the explain bucketer). A model-free strategy test supplies a scripted backend. */
  readonly backend: DecodeBackend<Id>;
  /** The accepted prefix the decode extends (the prefill string — `(` by default). The strategy grows it. */
  readonly prefix: string;
  /** Whether to enforce the oracle constraint. `false` ⇒ plain greedy argmax (the unconstrained control). */
  readonly constrained: boolean;
  /** The Σ-live oracle scanner. Required when {@link constrained}; `undefined` on the unconstrained control. */
  readonly scanner: OracleScanner | undefined;
  /** Decode-step cap (the `maxNewTokens`). */
  readonly maxNewTokens: number;
  /** Top-K candidates to walk per step before the widen fallback. */
  readonly topK: number;
  /** Widened K tried once when none of the top-K are feasible. */
  readonly wideK: number;
  /** Decode temperature over the feasible set. 0 ⇒ greedy first-feasible; >0 ⇒ sample among feasible. */
  readonly temperature: number;
  /** Sampling PRNG (consulted only when {@link temperature} > 0). */
  readonly rng: () => number;
  /** OPT-IN kwargs / positional-keyed profile, threaded UNCHANGED into every liveness check. */
  readonly profile: ToolCallProfile | undefined;
  /** Per-step metric tap (the StepMetric the onnx run records). */
  readonly onStep?: (m: StepMetric) => void;
  /** Per-step explain tap (the StepExplain built via buildStepExplain). */
  readonly onExplain?: (e: StepExplain) => void;
  /** How many prob-sorted ids to walk per step for {@link onExplain} (the lazy omitted/chosen/tail walk). */
  readonly explainTopK: number;
  /** OPT-IN: forwarded to `buildStepExplain`'s `nucleusMass` — switches `onExplain` from the lazy-only
   *  record to ALSO classifying the whole prob-mass nucleus (`StepExplain.nucleus`). Omitted (the default)
   *  ⇒ byte-identical to today's lazy-only explain record; no cost when `onExplain` itself is unset. */
  readonly explainNucleusMass?: number;
  /** Cooperative stop check, polled once per decode step BEFORE the model is advanced. */
  readonly shouldStop?: () => boolean;
  /** TAIL-PICK threshold (default 0.05): a constrained step whose COMMITTED token had a PRE-MASK model
   *  probability below this counts as a tail-forced event (`telemetry.tailPicks`/`tailMass`). The harm of
   *  constrained decode concentrates in tail picks — a token from inside the model's own uncertainty
   *  nucleus is ordinary sampling variance (on-policy); a token forced from the <5% pool makes the model
   *  condition on text it considers implausible. A validity-mirroring gate shows ~zero tail events; a
   *  style gate shows constant tail-forcing on confident models. */
  readonly tailThreshold?: number;
  /** The live telemetry object — MUTATED in place across the decode (generatedTokens / overruledSteps /
   *  forcedSlots), exactly as the inline loop did. {@link DecodeResult.telemetry} is this same reference. */
  readonly telemetry: DecodeTelemetry;
}

/** The subset of the runner's telemetry a strategy's decode loop writes. The runner passes its full
 *  telemetry object (a superset); this names the fields the greedy path increments. */
export interface DecodeTelemetry {
  generatedTokens: number;
  overruledSteps: number;
  forcedSlots: number;
  /** Constrained steps whose COMMITTED token had a pre-mask model probability below the tail threshold
   *  ({@link DecodeContext.tailThreshold}, default 0.05) — the off-policy-contamination counter. Force-
   *  emitted slots are excluded (tracked as `forcedSlots`; they are constraint-determined, not picks). */
  tailPicks: number;
  /** Σ of the pre-mask probability of every tail-picked token — the cumulative tail mass. Low `tailPicks`
   *  with near-zero `tailMass` = the mask only ever forced tokens the model itself found implausible. */
  tailMass: number;
}

/** What a strategy's decode produces. `program` is the extracted Scheme form (the return value). `rawDecode`
 *  is the UN-EXTRACTED prefix (prefill + every committed token, including any prose/trailing/unclosed text)
 *  — the runner records it as `telemetry.rawDecode` for the generation log, exactly as the inline loop did
 *  (the inline tail set `rawDecode = prefix`, then returned `extractSchemeForm(prefix)`). `telemetry` is the
 *  (mutated) context telemetry object, returned for the design's `{ program, telemetry }` shape — the runner
 *  reads its own reference, so this field is informational. */
export interface DecodeResult {
  readonly program: string;
  readonly rawDecode: string;
  readonly telemetry: DecodeTelemetry;
}

/**
 * THE STRATEGY CONTRACT — `decode(ctx)` runs the whole decode loop and returns the program. Greedy's is a
 * per-step first-feasible loop; passthrough's is argmax-no-filter; rollback's (Phase 3) is a DFS over the
 * backend's `rewind`. The runner selects exactly one and calls `decode`. Generic over the id brand `Id`
 * (default `Token`): the Token-locked tier strategies (proxy/lookahead/branch) are a plain `DecodeStrategy`
 * (= `<Token>`); the cross-backend strategies are an {@link IdPolyDecodeStrategy}.
 */
export interface DecodeStrategy<Id extends number = Token> {
  decode(ctx: DecodeContext<Id>): Promise<DecodeResult>;
}

/**
 * A strategy POLYMORPHIC over the id brand `Id` — usable at `Token` (the llama backend) AND `number` (the
 * scripted test double) via a GENERIC `decode` method. The strategies that drive ONLY the abstract backend
 * (greedy / passthrough / rollback) are this, so the scripted backend can exercise their whole search
 * model-free; the type is assignable to `DecodeStrategy<Token>` (the runner's slot) by specializing `Id`. The
 * Token-locked tier strategies, which reach the concrete sequence probes, stay a plain {@link DecodeStrategy}.
 */
export interface IdPolyDecodeStrategy {
  decode<Id extends number = Token>(ctx: DecodeContext<Id>): Promise<DecodeResult>;
}

// ── THE SHARED DESCENT contracts — greedy's per-step walk, reused by rollback ─────────────────────────

/** A feasible candidate at a choice point: its token id, decoded string, and step probability. The
 *  prob-DESCENDING order of the ranked array IS the model's preference (index 0 = greedy pick). */
export interface FeasibleCand<Id extends number = Token> {
  readonly token: Id;
  readonly str: string;
  readonly prob: number;
}

/**
 * A recorded CHOICE POINT — a decode step where the model's preferred token was overruled and the regret
 * `p(best_masked) − p(best_feasible)` cleared the trigger threshold θ AND ≥2 feasible candidates existed.
 * Rollback backtracks to the highest-regret choice point with an untried alternative, restores `prefix`,
 * and commits the next untried feasible from the CACHED `ranked` (never re-evaluating the model at the
 * rewound node — the cached distribution is the ground truth at that position).
 */
export interface ChoicePoint<Id extends number = Token> {
  /** The backend cursor `position()` at this step — the fork point rollback `rewind`s back to. */
  readonly position: number;
  /** The descent step index at this point — the onward descent after a backtrack resumes at `step + 1`
   *  (the alternative arm IS this step's token), so a backtrack completion stays within `maxNewTokens`. */
  readonly step: number;
  /** The accepted prefix at this step (BEFORE the chosen token). Restored verbatim on a backtrack; also
   *  the pool key (one choice point per distinct prefix — same prefix ⇒ same distribution ⇒ same arms). */
  readonly prefix: string;
  /** The ABSOLUTE total log-probability of the path from the prompt to this prefix (EXCLUSIVE of this
   *  step's chosen token) — the descent's running total at record time. A backtrack completion through arm
   *  `a` has total `logprobBefore + log(p(a)) + onwardDescent.totalLogprob`, so all completions are
   *  comparable on one absolute scale. */
  readonly logprobBefore: number;
  /** The feasible candidates at this step, prob-DESCENDING (index 0 = the greedy pick taken this pass).
   *  Rollback commits the next UNTRIED index on a backtrack — the cached arms, never re-derived. */
  readonly ranked: readonly FeasibleCand<Id>[];
  /** The regret `p(best_masked) − p(best_feasible)` at this step (the backtrack-priority key — highest
   *  regret first). `best_masked` is the unconstrained argmax; `best_feasible` is `ranked[0]`. */
  readonly regret: number;
  /** How many of `ranked` have been committed across passes (starts at 1 — the greedy pick). The next
   *  backtrack at this point commits `ranked[tried]`, then increments. Exhausted when `tried >= ranked.length`. */
  tried: number;
}

/** What {@link greedyDescend} produces: the grown prefix, the path's TOTAL log-probability (the sum of
 *  log-probs of every committed token — the value rollback maximizes across completions), and whether the
 *  descent ended by choosing EOS (a closeable completion) vs hitting the step cap. */
export interface DescentResult {
  /** The accepted prefix after the descent (prefill + every committed token this descent appended). */
  readonly prefix: string;
  /** Σ over committed tokens of `log(prob(token))` — the path's total log-probability over the model's FREE
   *  choices. Greedy is the floor; rollback's backtracks tie or beat it. Force-emitted slots contribute 0
   *  (they are constraint-determined, not model choices — identical across all completions through a prefix,
   *  so rollback's ranking is unaffected). */
  readonly totalLogprob: number;
  /** True iff the descent terminated by committing EOS at a closeable prefix (a complete program). False
   *  if it hit `maxNewTokens` or ran out of distribution — the completion is whatever extracts from `prefix`. */
  readonly endedAtEos: boolean;
}

/**
 * The per-step context a {@link DescentHooks.onContestedPick} hook reads to decide whether to OVERRIDE the
 * constrained pick at a CONTESTED step (the model's masked top pick was content, yet the constrained greedy
 * collapsed to a closer). This is the seam the `proxy` (prob-only content pick) and `lookahead` (probe-scored
 * EFG pick) tiers ride — the only place the committed token is changed by a non-greedy policy. The hook reads
 * `preferStr`/`preferKind`/`greedyStr` to recompute the contested condition, then picks a replacement using
 * the backend's `model`/`seq` (the proxy walks the dist; the lookahead probes via `backend.seq`). Greedy
 * passes no hook ⇒ this is never assembled ⇒ byte-identical to today's greedy walk. */
export interface ContestedPickArgs<Id extends number = Token> {
  /** The backend — the hook reaches `backend.model`/`backend.seq`/`backend.eosIds` for the content walk /
   *  reversible probes (the same llama escape hatches the verbatim greedy lift keeps). */
  readonly backend: DecodeBackend<Id>;
  readonly scanner: OracleScanner;
  /** The accepted prefix at this step (before the chosen token). */
  readonly prefix: string;
  /** The prob-descending full-vocab distribution at this step. */
  readonly probabilities: ReadonlyMap<Id, number>;
  /** Whether the prefix is closeable (the lookahead's EOS-mass gate). */
  readonly closeable: boolean;
  /** The widened scan window (`ctx.wideK`) the content walk / candidate gather bounds itself by. */
  readonly wideK: number;
  /** The opt-in kwargs / positional-keyed profile, threaded into the override's liveness checks. */
  readonly profile: ToolCallProfile | undefined;
  /** The once-per-step value-slot state, threaded into the override's liveness checks (never re-analyzed). */
  readonly slotState: OracleState | undefined;
  /** The constrained pick this step (greedy's first-feasible) — the override's baseline; the lookahead's
   *  candidate set C always includes it so closing stays a live option (the override can only upgrade). */
  readonly greedyTok: Id;
  readonly greedyStr: string;
  /** The model's unconstrained argmax string + its feasibility — the contested condition reads both. */
  readonly preferStr: string;
  readonly preferKind: "feasible" | "infeasible";
}

/**
 * The per-step context a {@link DescentHooks.onFork} hook reads to decide whether to FORK the decode at an
 * intent-uncertainty step (the `branch` tier). The hook runs the four-gate branch trigger over the
 * distribution; on a fork it captures the fork point ({@link backend}'s `position()` + this `prefix` + the
 * arms) in its own closure and returns `true` to STOP the descent — the {@link DecodeStrategy} then decodes
 * the arms depth-first and resolves the winner. Returns `false` (no fork) on the overwhelming majority of
 * steps, so the descent proceeds greedily. Greedy/proxy/lookahead pass no `onFork` ⇒ never forks. */
export interface ForkArgs<Id extends number = Token> {
  /** The backend — the hook reads `backend.position()` (the fork point to rewind to) + `backend.model`/
   *  `backend.eosIds` for the trigger's entity scan. */
  readonly backend: DecodeBackend<Id>;
  readonly scanner: OracleScanner;
  /** The accepted prefix at this step (the fork prefix the arms decode from). */
  readonly prefix: string;
  /** The prob-descending full-vocab distribution at this step (the trigger's fan-out source). */
  readonly probabilities: ReadonlyMap<Id, number>;
  /** Whether the prefix is closeable (passed to the trigger for symmetry; ending-here is never a fork arm). */
  readonly closeable: boolean;
  /** The top-K scan window the trigger bounds its entity collection by. */
  readonly topK: number;
  /** The opt-in profile, threaded into the trigger's per-candidate liveness checks. */
  readonly profile: ToolCallProfile | undefined;
  /** The once-per-step value-slot state, threaded into the trigger (never re-analyzed). */
  readonly slotState: OracleState | undefined;
  /** This descent step index (the arms resume against `maxNewTokens - step`). */
  readonly step: number;
  /** The decode-step cap (so the strategy bounds each arm's onward decode by the remaining budget). */
  readonly maxNewTokens: number;
}

/** Optional hooks that switch {@link greedyDescend} from the cheap greedy path to a richer strategy's path.
 *  Each hook is added by exactly ONE strategy family and fires at its own point in the step; greedy passes
 *  NONE, so an unhooked descent is byte-identical to today's greedy walk (the loop-parity gate). The hooks
 *  are mutually exclusive in practice (one strategy wires one), and each is gated so it cannot perturb the
 *  greedy/control path:
 *   • `onChoicePoint` (rollback) — OBSERVE-only: collects the feasible-RANKED set per step so rollback can
 *     detect ≥2 feasible + compute regret. Never changes which token is committed (always the first feasible).
 *   • `onContestedPick` (proxy/lookahead) — POST-pick OVERRIDE at a contested step: may replace the committed
 *     token with a better expected-future content pick. Fired only on the constrained path at τ≤0.
 *   • `onFork` (branch) — PRE-pick FORK: may STOP the descent at an intent fork so the strategy can decode +
 *     resolve arms. Fired only on the constrained path at τ≤0. */
export interface DescentHooks<Id extends number = Token> {
  /** Fired at each step whose regret > θ AND ≥2 feasible candidates exist — the steps rollback may revisit.
   *  Receives a fully-formed {@link ChoicePoint} (tried=1, the greedy pick already counted). The descent
   *  proceeds greedily regardless; the hook only RECORDS. Omit ⇒ greedy's exact (cheaper) walk. */
  readonly onChoicePoint?: (cp: ChoicePoint<Id>) => void;
  /** The regret threshold θ — a choice point is recorded only when `p(best_masked) − p(best_feasible) > θ`.
   *  Required when `onChoicePoint` is set; ignored otherwise. */
  readonly regretTheta?: number;
  /** Fired AFTER the constrained pick each constrained step (τ≤0). Returns a replacement `{token, str}` to
   *  OVERRIDE the commit, or null to keep greedy's pick. The hook itself recomputes the contested condition
   *  from {@link ContestedPickArgs} and owns its tier telemetry. Omit ⇒ greedy's pick stands. */
  readonly onContestedPick?: (args: ContestedPickArgs<Id>) => Promise<{ token: Id; str: string } | null>;
  /** Fired BEFORE the constrained pick each constrained step (τ≤0). Returns `true` to STOP the descent at
   *  this prefix (the hook has captured the fork in its closure for the strategy to decode), or `false` to
   *  proceed greedily. Omit ⇒ the descent never forks. */
  readonly onFork?: (args: ForkArgs<Id>) => boolean;
}
