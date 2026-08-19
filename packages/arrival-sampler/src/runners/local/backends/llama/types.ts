// backends/llama/types.ts — types for branching (B1) and telemetry in the llama backend.
//
// Used by the corresponding strategies. 

/**
 * One completed branch arm at a fork — a full candidate program plus the fork context the resolver needs.
 * The depth-first wrapper (B1) decodes each arm to completion and hands the set to the injected
 * {@link BranchResolver}. Arms are ordered PROB-DESCENDING (index 0 = the greedy/highest-probability arm),
 * so a resolver that can't separate them returns 0 (tie-goes-to-the-model, the §2a weak-monotonicity guard).
 */
export interface BranchCandidate {
  /** The full extracted Scheme program this arm decoded to (the resolver's `exec` input). */
  readonly program: string;
  /** The distinct lexer-entity this arm forked on (the operator/arg symbol, e.g. `set-brightness`) — the
   *  human-legible fork label for telemetry; NOT used to rank (only the executed outcome ranks). */
  readonly symbol: string;
  /** This arm's first-token probability at the fork (P(c) — the model's own confidence in this entity).
   *  Lets a resolver log override-rate vs margin (design §10) without re-deriving it. */
  readonly forkProb: number;
}

/**
 * THE RESOLUTION SEAM (B2 lives on the OTHER side of this — `examples/intent-eval`). The decode loop is
 * REQUEST-BLIND (it knows only the grammar Σ, never the user's intent — design §3/§6), so it structurally
 * cannot pick `set-brightness` over `set-volume` when both are grammatical. It defers that choice to an
 * INJECTED resolver that DOES see intent: in V0 the lexicographic cascade R0→R1→R3 that `exec`s each arm
 * against the device sim and ranks by the state-assertion outcome (the only criterion that compares the
 * program's *effect* to the *request*).
 *
 * Contract: given the completed arms (prob-descending), return the WINNER's index. Returning 0 keeps the
 * greedy arm (the tie / no-strict-improvement default — never a regression). The sampler does NOT know how
 * the winner was chosen; it only commits the returned program. This injection is what keeps the resolver's
 * ground-truth dependency (the sim's assertion — design §5a) OUT of the sampler, so the sampler stays a
 * deployable decoder and the eval-only "ceiling" resolver lives where the ground truth does.
 *
 * @returns the index into `candidates` of the winning arm. MUST be in `[0, candidates.length)`.
 */
export type BranchResolver = (candidates: readonly BranchCandidate[]) => number | Promise<number>;

/** Diagnostics surfaced after a run — prefill size and constraint activity. */
export interface LlamaGenTelemetry {
  /** Size of the system prompt re-prefilled per task (the KV state is cleared between tasks — see the
   *  generate() comment on why cross-task prefix reuse was abandoned for correctness). */
  systemPromptTokens: number;
  /** Cumulative tokens the model GENERATED across all tasks (the decode-step count). */
  generatedTokens: number;
  /** Decode steps where the oracle OVERRULED the model (the unconstrained argmax was infeasible). */
  overruledSteps: number;
  /** Decode steps that hit the CONTESTED trigger (greedy collapsed to a closer while the model's own
   *  top pick was masked content) — the steps where the lookahead tier engages. The ~5%-of-steps the
   *  probe-spending work is confined to. */
  contestedSteps: number;
  /** Forward evals spent on PROBES — `probeSuccessor` calls the Tier-A lookahead made to score the
   *  candidate set at contested steps. 0 on the greedy path (no probes); ~|C| per contested step under
   *  "lookahead". The honest cost denominator for the EFG decoder. */
  probes: number;
  /** Decode steps where the LOOKAHEAD tier (Tier A) changed the greedy pick to a probe-scored candidate
   *  (the EFG-weighted argmax differed from the greedy closer). */
  lookaheadOverrides: number;
  /** UNCERTAINTY BRANCHING (strategy `"branch"`, B1 frontier). FORKS opened — operator/arg-slot steps that
   *  passed all four §1 gates (margin<δ ∧ ≥2 over the mass-floor ∧ distinct lexer-entities ∧ slot boundary)
   *  and spawned a depth-first fan-out. 0 unless `decodeStrategy:"branch"` and a genuine intent fork fired. */
  branchesOpened: number;
  /** Branch candidates DROPPED before resolution — a fan-out arm the oracle/type gate killed mid-decode (it
   *  could not complete a valid program). Under V0 (we only fork among oracle-feasible operator tokens) this
   *  is essentially always 0; it counts the §2a "all/partly pruned" corner if a deeper infeasibility bites. */
  branchesPruned: number;
  /** Branch RESOLUTIONS where the injected {@link BranchResolver} picked a NON-greedy arm (index ≠ 0 — the
   *  higher-probability arm is always index 0). The branch analogue of `lookaheadOverrides`:
   *  the count of forks where executing the minority branch and keeping the better outcome BEAT greedy. The
   *  V0 headline numerator (branch-override rate = `branchOverrides / branchesOpened`). */
  branchOverrides: number;
  /** SINGLETON FORCE-EMIT (the positional-keyed mode): slots where exactly one symbol was feasible (a forced
   *  required keyword or a Σ value singleton) and the decoder force-emitted it, skipping the model pick. 0
   *  unless a `toolCallProfile` is present and τ≤0. Counts SLOTS (one per forced symbol), not tokens — each
   *  also increments `generatedTokens` once for the committed string. The near-zero-cost win's magnitude. */
  forcedSlots: number;
  /** TAIL PICKS — constrained steps whose COMMITTED token had a PRE-MASK model probability below the tail
   *  threshold (default 0.05). The off-policy-contamination counter: drift inside the model's own
   *  uncertainty nucleus is free (on-policy sampling variance); the harm concentrates in tokens forced from
   *  the tail pool — the model then conditions on text it considers implausible. A validity-mirroring gate
   *  shows ~zero; a style gate shows constant tail-forcing on confident models. Force-emitted slots are
   *  excluded (tracked as `forcedSlots` — constraint-determined, not picks). */
  tailPicks: number;
  /** Σ of the pre-mask probability of every tail-picked token (the cumulative tail mass). */
  tailMass: number;
  /** ROLLBACK (`decodeStrategy:"rollback"`): backtracks spent — regret-driven rewind+re-descend passes (≤ K).
   *  0 on every other strategy (and on `"rollback"` when no choice point cleared θ). The search-cost numerator. */
  backtracksUsed: number;
  /** ROLLBACK: full completions explored = 1 baseline + one per backtrack. 0 off the rollback path. */
  completionsExplored: number;
  /** ROLLBACK: whether a backtrack completion BEAT the greedy baseline (a more-complete or higher-log-prob
   *  valid program replaced the floor). `false` off the rollback path / when greedy was already best. */
  improvedOverGreedy: boolean;
  /** Cumulative wall-clock (ms) spent in PREFILL (the first evaluate to the first distribution). */
  prefillMs: number;
  /** Cumulative wall-clock (ms) spent in the DECODE loop (oracle + token-by-token generation). The
   *  honest tokens/sec denominator — excludes the per-task prefill re-pay. */
  decodeMs: number;
  /** Cumulative INPUT tokens fed across all tasks = the full formatted prompt under THIS model's
   *  tokenizer (system frame + user turn + assistant-open + prefill, `specialTokens:true`) — the token
   *  axis BFCL prices on the input side. `systemPromptTokens` is the system-frame SUBSET; this is the
   *  whole prompt the model actually attends to. For a single-task `generateWithExplain` call it is that
   *  one prompt's length; summed here for the multi-task generator. */
  promptTokens: number;
  /** The UN-EXTRACTED decode of the LAST task — the raw accumulated prefix (prefill + every committed
   *  token) BEFORE {@link extractSchemeForm} lifts the first balanced form out of it. `generate()` returns
   *  the extracted program, so this is the only carrier of the model's literal output (the generation LOG):
   *  it preserves any prose, trailing tokens, or a malformed/unclosed form that extraction would discard.
   *  For a RESOLVED branch fork (B1) the winning arm's program is already extracted, so this equals that
   *  program (the loop never accumulated a single-path prefix). Per task in a multi-task generator it is
   *  OVERWRITTEN — the single-task `generateWithExplain` call (the BFCL path) reads it for that one call. */
  rawDecode: string;
}
