# Arrival Sampler — Claim, Eval Design, and Premise Lock

Status: canonical. Everything else (code comments, sibling docs, agent memory) aligns to this.
If any artifact contradicts §1–§2, that artifact is a **drift trigger** and must be corrected.

Author: V + Claude, 2026-07-01.

---

## 0. Why this doc exists

We have repeatedly drifted — a stale sentence in a comment, doc, or memory restates the goal
as something it is not, a later session reads it, and the work bends toward the wrong target.
This doc is the single statement of **what we are proving with arrival-sampler and how**.
§1–§2 are the premise lock. §3–§10 are the design.

---

## 1. The claim (flexible, honest, non-academic)

A constrained-decode harness — **grammar (Σ)** + **type-layer (T)** — **improves agentic
tool-use capability for SOME models.** (A **scheme-for-dummies** prompt scaffold is **out of
scope for the initial ladder**: the scheme-format teaching is held **constant across arms**, not
treated as an ablation axis.)

- We cannot predict which. Could be small models, large models, or both on different axes.
  It is an **empirical question**. Model scheme-fluency is a **covariate, not a filter**.
- Established so far: the constraint helps vs **raw (unconstrained) scheme** on multi-slot tasks.
- NOT yet established: a clean, confound-free magnitude. Every number we currently hold is
  contaminated (see §6). The 3-arm ablation (§5) produces the first honest one.

The audience for this claim is **foundational AI labs and ventures** — it is a credibility
statement (a non-tuned sampler that moves multiple model families), not a product feature.

---

## 2. Premise lock — what we are NOT doing

Each row is a drift trigger seen in the wild. Left = the wrong premise to hunt and delete.
Right = the canon it must be replaced with.

| ❌ Drift trigger (wrong premise) | ✅ Canon |
|---|---|
| "utility model" / "useful tool for end-users" | A **credibility statement to labs/VCs**; a non-tuned sampler proving a scientific point. |
| "beat / minmax / hack BFCL", "improve our BFCL score", "climb the leaderboard" | BFCL is a **convenient test suite, not a target**. We use it to prove the concept, never to optimize for it. |
| goal framed as raw **tool-calling accuracy** | With the constraint, it becomes a **decision-making / intent metric**. Materialization is guaranteed; **strategy is the target**. |
| "default mode = native reference / how BFCL scores it" | Our old `default` mode was a **python text-prompt**, NOT native function-calling. It is a lying baseline. The real reference is native-FC same-quant, or the within-scheme `pure` arm. |
| "arch-1.5b is outperforming" + specific numbers (76.1→80.6, 63.9→77.8, 15.0→47.2) | **Unverifiable** (retired t-layer-sm branch, source file gone). Honest claim: **biggest positive constraint-delta + best validity, on a weak model** — near the bottom in absolute score. |
| "grammar helps all models" / "grammar hurts specialists" as fact | All current deltas are **confounded by the python-baseline bug** (format tax mixed with grammar). **No clean grammar-effect number exists yet.** |
| verification via **trace-match / AST-match** as the goal | **Anti-correlated** with what constrained decode buys — the sampler closes the syntax channel by construction. Use **state-based / answer-based** verification. |
| **single-tool accuracy** as the target | Saturated across models — no headroom. Signal lives in **multi-tool, parallel, multi-step, agentic**. |
| "goldilocks zone" / model-size determinism | We **cannot predict** which models benefit. Fluency is a covariate; the benefit distribution is what we are measuring, not assuming. |

---

## Results — 2026-07-01 (first clean measurement)

The first honest, non-confounded numbers from the 3-arm ladder (pure → grammar → typed), both
non-live and live BFCL categories. Format is astAcc / validity (%).

**hammer2.1-3b (q4) — THE positive case:**

| Category | pure | grammar | typed | Δ (typed−pure) |
|---|---|---|---|---|
| non-live parallel | 67.2 / 91.1 | 74.4 / 95.6 | 79.4 / 96.7 | — |
| non-live multiple | 78.3 / 95.6 | 82.2 / 97.8 | 85.6 / 98.9 | — |
| **non-live overall** | | | | **+9.7pp**, monotonic, validity rising |
| live_multiple (n=180) | 43.3 / 92.2 | 58.3 / 97.2 | 59.4 / 97.8 | — |
| live_parallel (n=16, noisy) | 43.8 / 81.3 | 43.8 / 87.5 | 50.0 / 93.8 | — |
| **live overall** | | | | **+15.3pp — LARGER on live than non-live** |

**arch-agent-1.5b (q4) — the counter-case:**

| Category | pure | grammar | typed | Δ (typed−pure) |
|---|---|---|---|---|
| non-live parallel | 52.8 / 96.1 | 53.9 / 96.1 | 54.4 / 96.1 | — |
| non-live multiple | 53.9 / 65.0 | 48.3 / 58.9 | 50.0 / 59.4 | — |
| **non-live overall** | | | | **−1.1pp** |
| live_multiple | 27.8 / 57.8 | 24.4 / 48.9 | 24.4 / 48.3 | — |
| live_parallel (n=16) | 12.5 flat | 12.5 flat | 12.5 flat | — |
| **live overall** | | | | **−3.1pp** |

**Official python-prompt reference (BFCL v4, via LM Studio):** hammer2.1-3b multiple = 72.5%
(145/200), parallel = 66.7% (partial 26/39, gen-capped run). ⇒ **hammer's constrained-scheme
typed arm (85.6%) beats its own python-prompt baseline (72.5%) by +13pp** on multiple. Hammer
native-FC is **unobtainable**: LM Studio does not surface hammer's `tool_calls` over the
OpenAI-compatible API (returns text in `content`), so every FC-mode entry scores 0 regardless
of call correctness — a platform limitation, not a model or sampler fact. Only the Arch family
maps natively through LM Studio's tools API.

**Key framings:**

1. **The effect is model-dependent** — hammer helped substantially, arch did not. The covariate
   that best explains the split looks like **scheme-form fluency**, not parameter count (arch is
   smaller AND regresses; hammer is bigger AND improves — size alone doesn't predict direction).
2. **Scope: single-turn only.** Both non-live and live single-turn categories are covered here;
   **multi-turn is untested** — no claim is made about it.
3. **arch's `multiple` degradation is a diagnosed fence artifact, not the constraint failing.**
   The constraint forces scheme decoding from token 0; arch's natural behavior is a prose
   preamble followed by a ```scheme-fenced call. 12 of the 13 observed degradations trace to
   this collision, not to the grammar/type narrowing being wrong.
4. **Design decisions locked from this round:**
   - **Gate-cascade defer-on-overconstraint** — a gate never errors; on over-constraint it logs
     and returns the *looser* gate's pick. Monotonicity (pure ⊆ grammar ⊆ typed validity) becomes
     a structural property, not an empirical hope.
   - **Fence-agnostic, content-based engagement** — the sampler engages constrained decode at the
     first `(` whose head is a bound/offered symbol, never at a fence marker (which varies per
     model and is exactly the arch collision in (3)).
   - **Deferral triage by `VetoReason`** — a defer is classified, not a silent fallback.
   - **Self-firing vast reaper** (`inhuman/examples/intent-eval/horde/reaper.ts`) — a detached
     process that guarantees pool teardown even if the driving session dies mid-sweep.
5. **Correction to `docs/working-proposals/arrival-type-layer-rework.md`'s D1:**
   `OracleEnvΣ.signatureOf` is a **sift-shared contract**, not the type-layer lens's own harvest
   path — the harvest goes **direct from `SymbolDef`s** via `assembleHarvestedPrelude`. No
   `OracleEnvΣ` contract change is needed for the type-layer rework; D1 in that doc has been
   corrected in place (§4/§5/§12 no longer route the harvest through `signatureOf`, and no longer
   flag a contract-coordination risk that doesn't exist).

---

## 3. The reframe: materialization vs strategy

Sort every tool-call error into two strata:

- **Materialization** — form (well-formed call) + value (well-typed / in-domain argument).
  **Determinate. Machine-guaranteeable.** The constraint owns this.
- **Strategy** — which function, how many, in what order, which semantically-right value.
  **Genuinely indeterminate.** The LLM owns this — as the expert making a choice.

The constraint's job is to take materialization *away* from the model and leave it only the
strategy — exactly intent-over-materialization applied to the LLM itself. Under this frame,
**BFCL (and any tool-use benchmark) becomes a decision-making capability metric**, because the
structural failure class is removed by construction.

---

## 4. The verification duality

Because the sampler **guarantees structural + bound-symbol validity by construction**, it has
closed the syntax channel. Therefore:

- **Trace-match / AST-match verification is anti-correlated** with the sampler's value — it
  scores the failure class we eliminated, so it reads flat and penalizes valid alternative
  decodings the grammar happily produces.
- The **only** verification that can see our value is **final-world-state** (or verifiable
  answer): given materialization is free, did the model make the **right decision**?

The constraint and the verifier are two halves of one pattern. Choose state-based verifiers.

---

## 5. The measurement design

### 5.1 The 3-arm ladder

```
   grammar+types  (typed)
        |
     grammar
        |
      pure          (= unconstrained SCHEME, not python)
```

The scheme-format teaching stays **constant across all three arms** — it is not an ablation axis.

Reads off:
- **grammar effect** = grammar − pure (finally isolates grammar from format tax — `pure` is scheme)
- **types effect** = (grammar+types) − grammar

`pure+types` is impossible (T ⊂ Σ — you cannot type a stream that does not parse).

### 5.2 Monotonic-first, then boost

- **Σ∩T vs Σ is strictly monotonic per-entry**: typed only drops *provably ill-typed* candidates,
  and a correct call is never ill-typed. A per-entry typed < grammar result is a **DEFECT**
  (wrong type description / gate bug) to root-cause — never noise to average away.
- **grammar vs pure is NOT per-entry monotonic** (masking changes the argmax → trajectory
  divergence). Report it as an aggregate delta, not an invariant.

### 5.3 The two channels

- **Channel 1 (recovery):** the model unconstrained emitted an invalid call that, projected,
  becomes correct. The boost. Shrinks as native validity saturates.
- **Channel 2 (no-harm):** the model already emitted a valid-but-wrong call. Projection can't
  help and (for Σ∩T vs Σ) provably can't hurt. This is where strategy lives — the residual.

### 5.4 Divergence-fork decode + per-token telemetry

At temp 0 the three arms share **one KV lineage** (one prefill — the scheme-format teaching is
constant, so there is no prompt fork):

`pure` → `grammar` (fork at first grammar-masked argmax) → `grammar+types` (fork off grammar at
first type-masked argmax).

Cost per entry ≈ **1 full decode (one prefill) + 2 short fork-tails**, collapsing to
**1 full decode, zero tails** on an already-valid entry (constraint arms come out byte-identical
to their lineage base for free). Implementation: KV-checkpoint-at-fork ideal; llama.cpp
**prefix-cache re-prefill** is the identical-cost fallback if node-llama-cpp lacks mid-sequence
KV save/restore.

**The fork *is* the telemetry.** Forking off a shared prefix makes the arms token-aligned by
construction — which is exactly what "was this token the cartesian diverging?" requires. The
current harness runs arms as separate *unaligned* passes and cannot measure paired divergence.

Per-token trace to persist (machinery mostly exists — `StepExplain.rank`, `omitted[]` + their
`VetoReason`, `chosen`; `StepMetric` top-1/top-2 gap — but is computed lazily and thrown away
because the sweep path never wires `onExplain`):

1. the **95% nucleus** per position, each candidate classified `grammarOK? typeOK?`
   (make `buildStepExplain` non-lazy: cumulate mass to 0.95, classify every nucleus token)
2. per-position **entropy** (−Σ p·log p over top-K — computed nowhere today)
3. the **divergence position** per arm (first masked-argmax — the cheap proxy `rank>0` already exists;
   the *true* paired version falls out of the fork architecture)

Aggregated: the **entropy profile** vs position (the drift/dilution test — does uncertainty grow
with distance from the tool annotation?) and the **divergence map** (do the arms split at
high-entropy positions = Channel 1, or low-entropy = Channel 2 no-op?). This is what makes the
claim mechanistic ("at token 14 the model's own nucleus had the correct symbol at rank 2; the
grammar masked its malformed rank-1 head; that flipped the call correct") rather than a leaderboard row.

---

## 6. The honest current state

- **No clean measurement exists.** Every delta we hold compares grammar-*scheme* against the
  python-*prompt* `default`, so it mixes format tax with grammar effect. The 3-arm `pure`-scheme
  baseline is what disambiguates.
- **arch-1.5b:** near the bottom in absolute accuracy; highest validity (100/99.4/100%); the only
  specialist with a *positive* grammar delta (+4.4, +8.3) while stronger models regress under the
  same confounded comparison. Lead with it for Channel-1 concentration, on the *honest* reason.
- The specific retired-branch figures are unverifiable and must not be cited.

---

## 7. The roster (5 models, size ladder)

| Model | Repo | Params |
|---|---|---|
| arch-1.5b | `Mungert/Arch-Agent-1.5B-GGUF` | 1.5B |
| hammer | `mradermacher/Hammer2.1-3b-GGUF` | 3B |
| rnj-1 | `essentialai/rnj-1` → `bartowski/EssentialAI_rnj-1-instruct-GGUF` | 8.3B |
| glm-4.7-flash | `zai-org/glm-4.7-flash` | 12B active (~100B-class MoE total, unconfirmed) |
| qwen3-14b | roster | 14B |

Ladder: 1.5 → 3 → 8.3 → 12 → 14 (or → ~100 if glm total). qwen3-**14b** chosen over 8b because 8b
duplicates rnj-1's 8.3B rung. No roster qwen fills the real 3→8.3B middle gap.

---

## 8. The three-world plan

One shared adapter — `oracleEnvFromBindings(worldTools)` → decode → execute — gated on the
**type-layer rework** (`signatureOf` over real `SymbolDef`s, not bfcl fixtures). Per-world
difference is only (turn-loop, verifier). Not three worlds from scratch; **one adapter + 2 shims**.

| World | Role | Verifier | Notes |
|---|---|---|---|
| **BFCL** parallel + multiple | PoC — structural validity, cheap, canonical | (structural) | where grammar−pure first goes clean |
| **ToolHop** | the **type-layer** probe | verifiable answer-match | single-shot multi-hop chain = a scheme program with `output_type(A) ⊨ input_type(B)`; carryover mistyping is where trace-match is blind and typed decode wins. Thin adapter. |
| **AppWorld** | the **agentic** flagship | final-state assertion + collateral-damage | tasks are executed *programs* (our artifact's shape); multi-turn REPL loop + state = heavier shim. Strongest "right decision, nothing broken" signal. |

Order: BFCL PoC first, ToolHop next (thin, isolates types), AppWorld last (heavier, flagship).

---

## 9. The moat

- **scheme-for-dummies** (a friendly scheme scaffold in the prompt) — the format-teaching
  concept; currently held **constant across all arms** (not an ablation axis, and may prove
  unnecessary), so the ladder does **not** toggle it
- **generalized model-quirk acknowledgments** (not bfcl-specific — real, portable model behavior)
- **the type-layer** (Σ∩T narrowing real tools)

A **single, non-tuned sampler** proving the point **across model families**. BFCL proves the
concept; it is never minmaxed. The bet: steer the LLM where we know the allowed shapes, let it
be the decision-maker where the state is genuinely indeterminate. Railway lines, not "ride
anywhere" — not guaranteed to arrive where you want, but guaranteed never to end up in the
middle of nowhere.

---

## 10. Dependencies & ordering

- **Reference numbers come from the external official BFCL runner** (canonical FC + Prompt). The
  home-grown python `default` baseline is **retired**; our harness is the **scheme-ablation
  white-box path** — the only one that can do per-token divergence forks (§5.4).
- The **type-layer rework** (`docs/working-proposals/arrival-type-layer-rework.md`,
  plan `eager-yawning-dongarra`) is the **enabling substrate** — it is the universal borrowed-world
  adapter, not merely "make typed work." Prioritize it.
- Native-FC reference: **local same-quant**, made practical by LM Studio multi-load (disable
  "Only Keep Last JIT Loaded Model" → models stay resident, no reload thrash between reference and
  sampler arms). The separate LM Studio **1-tool_call cap** means native *parallel*-FC still reads
  0 through the tools API — a footnote, not a faked number; the clean parallel signal is the
  within-scheme ablation, where our server emits multiple calls natively.
- Sequencing: harness (divergence-fork + persisted per-token trace) → BFCL parallel/multiple clean
  `grammar−pure` → type-layer rework → ToolHop → AppWorld.
