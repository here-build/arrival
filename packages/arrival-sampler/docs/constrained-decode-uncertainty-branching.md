# Uncertainty branching: track the minority hypothesis, resolve it by our guarantees

**Status**: design proposal · 2026-06-20 · owner: sampler
**Composes with**: `constrained-decode-label-bias.md` (the EFG/label-bias ladder). Read that first.
**TL;DR**: When the model's next-token distribution **splits** across *different lexer-entities* (60/30, not
99/1), that split is the model signalling **uncertainty about intent** — and the minority branch may resolve
to a *better* completion than the greedy one. Greedy argmax collapses it; even the EFG ladder (Tier 0/A/B)
collapses it, because EFG still re-weights toward **one** token by future *grammatical* mass. Uncertainty
branching is a **different axis**: keep ≤2–3 hypotheses alive through the uncertain region, let the **oracle
prune** the dead ones for free, and **resolve the survivors by what we uniquely own** — the structural+Σ
oracle, the Σ∩T type gate, and the **device-sim semantic eval** (`exec` the branch against the world, then
`chain.assert` the final state — the per-program engine inside `runChain`/`runEval` + `scoreEval`; there is
no `runAndScore`, see §4). That resolve-by-guarantee is the entire thesis: every other brancher in the
literature resolves by LM probability or self-consistency voting; **we can resolve by ground truth.**

This is not "adopt beam search." Beam search ranks the frontier by *cumulative LM logprob* — it would keep
the 60% branch for the same reason greedy does. Our frontier is ranked by *completion correctness under our
own oracles*, which is information beam search structurally cannot see. Where this reduces to beam/SMC we say
so (§6); where it doesn't is precisely the resolution criterion (§4).

---

## 0. Why this is a real axis, not a re-skin of the EFG doc

The label-bias doc proves greedy leaves valid-*completion* mass on the table and fixes it with **expected
future grammaticality** `c(prefix) = E_P[1[w∈L(G)] | prefix]`. That is a **scalar re-weight of a single
pick**: at each step you still emit one token, just a better-justified one. EFG answers *"which single token
has the most grammatical future?"*

Uncertainty branching answers a question EFG cannot even pose: *"the model is torn between two **intents** —
which intent, carried to completion, actually satisfies the request?"* EFG's `c` is **request-blind** (it
only knows the grammar `G`); it cannot tell `(call-contact Dad)` from `(facetime-contact Dad)` when both are
grammatical and both type-check — only running the program against the sim, or judging it against the prompt,
can. So the two compose orthogonally: **EFG sharpens each branch's local pick; uncertainty branching decides
*which branch* by terminal quality.** You want both.

The worked example from the label-bias doc (`80`/vegan) is actually a *label-bias* case — one intent
(`"vegan"`), mis-ranked at the token level — and Tier 0 already caught it. Uncertainty branching targets a
**different failure family**: genuine *intent* forks where two different, both-feasible programs compete, and
the greedy one is wrong about what the user meant.

---

## 1. Detecting intent-uncertainty — the branch trigger (precise)

Most steps are confident (the benchmark records mean P(argmax) and mean top-2 margin per run; on Rnj-1 the
vast majority of steps are decisive). Branching everywhere is a compute blowup and pointless. The trigger
must fire **only at genuine intent forks**. Four gates, ALL must hold:

**(T1) The split is real — mass, not noise.** Top-2 probability margin below a floor: `top2Margin < δ`
(we already compute `top2Margin` every step in `StepMetric`). Start `δ = 0.25` (a 60/35-or-closer split).
A 99/1 step has margin ~0.98 and never triggers.

**(T2) Enough candidates clear a mass floor.** `|{c : P(c) ≥ p_floor}| ≥ 2`, `p_floor = 0.15`. This is
min-p-style (Nguyen et al. 2024, [arXiv 2407.01082](https://arxiv.org/abs/2407.01082)) — it bounds the branch
fan-out by the model's own dispersion and ignores a long tail of 2% tokens that are not real alternatives.

**(T3) The contenders are DIFFERENT lexer-entities — a real fork, not a spelling.** *This is the gate that
makes the trigger meaningful, and it is the one our oracle gives us for free.* Take the top candidates above
`p_floor`; for each, look at where its continuation lands. Two sub-cases that are NOT a fork and must be
suppressed:
  - **Same-entity spellings.** `Da` vs `Dad` (BPE fragmenting one symbol), or `0.1`/`0.15` mid-number — the
    branch resolves to the *same* eventual token. Detect via the oracle's `validSymbols()`: if every
    contender is a live prefix of **one** symbol in the Σ set (or all are partial-numbers per `isLiteralValue`),
    it is a tokenization split, not an intent fork → don't branch. (The label-bias doc already argues genuine
    within-entity tokenization fragmentation is <0.5% on this tokenizer — but the *gate* is cheap and exact,
    so use it rather than trust the prior.)
  - **A closer vs content split** is already handled by the Tier-0 premature-closer proxy; don't double-fire.

  A real fork is when the contenders, advanced by one token and re-analyzed, land on **different members of
  `validSymbols()`** (e.g. `call-contact` vs `facetime-contact` vs `call-dad`), or on **structurally
  different forms** (open a list arg vs pass a bare value). That is the model uncertain about *which tool* or
  *which argument shape* — i.e. about intent. **This is the precise definition of the branch trigger.**

**(T4) We are at or before a decision point that the eval can discriminate.** Branch only when the fork is in
the **operator slot** (`position === "operator"`, tool selection) or the **first token of an argument slot**
(`position === "argument"` at a slot boundary, argument-shape selection). These are the points where two
intents diverge into observably different traces. Forks deep inside a free-text string body (`"…late"` vs
`"…running late"`) are not worth branching — the fuzzy `argsContainAny` scorer can't tell them apart, and the
type gate doesn't constrain string interiors. Restricting to slot-boundary forks is what keeps branches/program
near zero on the easy tasks.

> **Trigger summary:** branch iff `top2Margin < δ` **and** `≥2` candidates above `p_floor` **and** they are
> distinct lexer-entities/forms (via `validSymbols()`, not string equality) **and** we're at an operator or
> argument-slot boundary. Implemented entirely from data we already have (`top2Margin`, the prob map,
> `scanner.analyze`).

---

## 2. What to track — the frontier

**The dominating cost fact (verified in the binding, node-llama-cpp 3.18.1):** node-llama-cpp exposes **no
`seq_cp` / KV-copy fan-out** (confirmed: `getSequence()` gives independent lanes but there is no cheap
sequence-clone; `LlamaContextSequence.d.ts` has `controlledEvaluate`, `eraseContextTokenRanges`,
`saveStateToFile`/`loadStateFromFile`, and `takeCheckpoint`, **not** `seq_cp`). So **parallel particles are
expensive** — each new lane re-prefills the ~1.1k system prompt and re-decodes the shared prefix from
scratch. This single fact dictates the architecture:

- **Do NOT run N parallel beams/particles.** That is the SMC shape, and it is gated on a binding patch we
  don't have (same blocker the label-bias doc flags for AWRS-SMC).
- **Branch depth-first on ONE sequence with token-range rewind.** At a triggered fork, record the fork index
  `forkIdx = seq.nextTokenIndex`, decode branch A greedily-with-EFG to completion, score it, then
  **`eraseContextTokenRanges([{ start: forkIdx, end: seq.nextTokenIndex }])`** to erase the *entire* branch-A
  token range back to the fork, decode branch B to completion, score it, keep the better. This trades
  wall-time (you decode each branch serially) for **zero extra KV machinery** and reuses the existing loop
  verbatim per branch.

**Correction — `takeCheckpoint` is NOT the rewind primitive, and there is no cheap in-memory checkpoint.**
The earlier draft framed branching as `takeCheckpoint()` → decode → rewind-to-checkpoint. That is wrong on
the verified 3.18.1 surface:
  - **`eraseContextTokenRanges` is the rewind**, on its own. It deletes token ranges from the KV state; for
    depth-first branching you erase `[forkIdx, nextTokenIndex)` — the whole sub-tree below the fork — and the
    sequence is back exactly at the fork, ready to decode the next branch. This is the same primitive the
    shipped loop already calls (`llama-cpp-generate.ts` uses `eraseContextTokenRanges` to erase back to the
    system-prefix boundary), so it is de-risked.
  - **`takeCheckpoint()` is not a save/restore handle.** Per its doc-comment it is a **prefix-reuse helper for
    recurrent / hybrid / SWA models** that cannot otherwise reuse a prefix-eval state: checkpoints are taken,
    *automatically consulted* when you erase past them, and *automatically freed* — you never rewind *to* one.
    On a standard transformer that natively supports prefix-eval reuse (the Rnj-1 path) **calling it "will
    have no effect."** So it neither needs nor helps branching here; do not call it as the "save the branch"
    step. (If a future model on this path is SWA-without-`swaFullCache`, `takeCheckpoint()` before the fork
    would make the post-fork erase *cheaper to recover from* — but that is a model-dependent optimization, not
    the branch mechanism, and is gated on `seq.needsCheckpoints`.)
  - **The only true full-state snapshot is `saveStateToFile` — disk, and expensive** (`fileSize` bytes written
    to a path; `loadStateFromFile` reads it back and can crash on a model mismatch). It is *not* a per-fork
    primitive; it exists for cross-process persistence, not in-loop branch rewind. **There is no cheap
    in-memory user-level "checkpoint this sequence, restore it later" call.** Depth-first
    `eraseContextTokenRanges` is the affordable substitute *because* that cheap snapshot does not exist.

**Cost-model consequence.** The per-fork rewind cost is **one `eraseContextTokenRanges` of the branch-A
range** (KV-range delete — cheap, no decode), *not* a state save/restore. There is **no** snapshot-write cost
to budget (we never call `saveStateToFile` in the loop) and **no** `takeCheckpoint` memory growth on the
Rnj-1 path (it no-ops). The real cost is therefore purely the **serial re-decode of branch B's suffix** after
the erase — i.e. branching's whole price is decode wall-time, with the rewind itself near-free. (Contrast the
rejected parallel shape, whose price is *re-prefilling the system prompt per lane*.)

**Bounds (a branch budget per program):**
- **Branch factor ≤ 2** at a fork (the top-2 distinct entities). A third only if its mass is within `p_floor`
  of the second — rare. (Empirically a 3-way *intent* tie at a slot is near-nonexistent in these tasks.)
- **Total forks per program ≤ 2** (`BRANCH_BUDGET = 2`). A device intent has at most a tool-choice fork and an
  argument-shape fork; beyond that you're in free-text where T4 forbids branching anyway. Budget exhausted →
  fall back to greedy+EFG.
- **Oracle prunes the tree for free.** A branch whose continuation the oracle kills (structural-infeasible, or
  Σ∩T-rejected) is dropped **immediately, before decoding it to completion** — we already know it can't
  produce a valid program. This is the asymmetry that makes branching cheap *for us*: most of the would-be
  frontier is dead-on-arrival under the constraint, so we rarely actually decode two full branches.
- **Worst case is bounded and tiny:** `≤ 2 forks × 2 branches = ≤ 4` full decodes per program, and only on
  programs that trip the trigger (a minority). Easy tasks decode exactly once.

This is an **adaptive, oracle-pruned, depth-first beam of width ≤2, budgeted to ≤2 forks** — not an
open-ended search tree, and explicitly not MCTS (no rollout policy, no value backup over a tree; see §6).

---

## 2a. The frontier state machine (per-branch lifecycle + the three corner transitions)

The frontier is a tiny set of **branch nodes**, each in one of four states. The depth-first walker drives
each node through them; the corner cases the eng-review flagged (all-branches-pruned, budget-exhausted
mid-branch, tie-after-cascade) are the three transitions worth spelling out, because each has a *guard* and a
*side effect* that determine correctness (and weak-monotonicity vs greedy).

**States.**

| State | Meaning |
|---|---|
| `open` | spawned at a fork, not yet decoded to completion (the walker is currently extending it token-by-token) |
| `pruned` | killed mid-decode by the oracle (R0 structural-infeasible) or the type gate (R1 Σ∩T-reject) — **before** finishing; dropped, never scored |
| `completed` | decoded to a full program; has a `ChainResult` from `exec` + `chain.assert` (§4); awaiting the resolution cascade |
| `resolved` | the cascade picked the winner among `completed` siblings; its program is **committed** to the live sequence and decoding resumes past the fork |

**Normal transitions.** `open --decode-to-completion--> completed` · `open --oracle/type kill--> pruned` ·
`{completed…} --cascade picks winner--> resolved`. A fork spawns ≤2 `open` nodes; the walker takes them
depth-first (decode A fully, `eraseContextTokenRanges` back to `forkIdx`, decode B fully).

**The three corner transitions (each: trigger · guard · side effect).**

1. **All branches pruned** (`{open…} → all pruned`, none reaches `completed`).
   - *Trigger:* every spawned branch hits an oracle/type kill before completing (R0/R1 eliminate the whole
     fan-out). Possible because the fork was detected on the *next-token* distribution, but every continuation
     turns out infeasible deeper in.
   - *Guard:* `count(completed) == 0` after the fan-out is exhausted.
   - *Side effect:* **fall back to greedy at the fork** — re-decode the single greedy-constrained pick (the
     fork never happened, as if the trigger had not fired), state → `resolved` with the greedy branch. The
     program is never left un-emitted; this transition guarantees the walker always produces an output. (In
     practice rare: at least the greedy top-1 is live by construction, since we only branch among feasible
     tokens — so the greedy branch itself is essentially never pruned. The guard exists for the pathological
     case where a *deeper* infeasibility kills even the greedy line, in which case the oracle's normal
     single-path repair takes over.)

2. **Budget exhausted mid-branch** (`open`, `forksUsed == BRANCH_BUDGET`, another fork trigger fires).
   - *Trigger:* while decoding inside an already-spawned branch, a *second* (or beyond-budget) fork condition
     fires but `forksUsed` has reached `BRANCH_BUDGET` (1 for V0, 2 for V1).
   - *Guard:* `forksUsed >= BRANCH_BUDGET` at the new candidate fork.
   - *Side effect:* **do not spawn** — suppress the trigger and continue the *current* branch greedily+EFG to
     completion (the §1 "budget exhausted → fall back to greedy+EFG" rule). The current branch still reaches
     `completed`; only the *new* fork is declined. `forksUsed` is per-program, not per-branch, so a fork
     inside branch A counts against branch B's budget too — the cap is on total forks in the program, bounding
     worst-case decodes at `≤ 2^BRANCH_BUDGET`.

3. **Tie after the full cascade** (`{completed…}` survive to the end of R0→R1→R3 with no strict separation).
   - *Trigger:* the resolution cascade (§4) runs to its last enabled rung and **cannot strictly separate** the
     completed branches — same derived category, and (R4 judge off, or no gold label) nothing left to split
     them.
   - *Guard:* `cascade.strictWinner == null` (no rung produced a strict improvement; R2 vote is *excluded*, so
     agreement never breaks the tie).
   - *Side effect:* **tie-goes-to-the-model** — `resolved` = the **higher-probability (greedy) branch** (F2,
     Guard 1). This is what makes branching *weakly monotone*: a tie can only ever yield greedy's own choice,
     so branching never regresses on noise; it overrides greedy **only** on a strict R3 category improvement.
     (If R4 is enabled and allowed, the tie first falls to the judge; only a judge-tie defers to greedy.)

> **Invariant the machine enforces:** every fork terminates in exactly one `resolved` node, and `resolved`
> equals the greedy branch *unless* a `completed` sibling strictly out-ranked it under R0/R1/R3 (never R2).
> All three corner cases collapse to "emit greedy" — so the frontier can only **upgrade** an output, never
> drop or degrade one.

---

## 3. How EFG composes inside a branch (the per-branch local policy)

Each branch, *between* forks, decodes by the **existing greedy + EFG ladder** (Tier 0 shipped; Tier A when
built). Uncertainty branching does not replace the per-step policy — it sits *above* it. So:

- At a non-fork step → greedy-constrained pick, optionally EFG-reweighted (Tier A 1-step lookahead). Unchanged.
- At a fork step (trigger fires) → spawn the ≤2 branches; *within* each branch, resume the greedy+EFG policy.

This is the clean layering: **EFG decides the local token; uncertainty branching decides which fork-path to
commit.** They never fight — EFG runs identically inside every branch.

---

## 4. THE RESOLUTION CRITERION — the differentiating part

This is where we beat greedy *for us specifically*, and where every choice must be justified by **"does it
correlate with the minority branch being right about intent?"** We have a tiered ladder of resolvers, cheap →
expensive, and we apply them as a **lexicographic cascade with early-exit**, because the cheap ones eliminate
most of the work and the expensive one is the only one that actually sees *intent*.

Rank surviving branches by, in order:

**(R0) Oracle validity — binary, ~free. ELIMINATION ONLY, never a tiebreak.** Both branches are valid by
construction (we only kept feasible tokens), so this never *ranks* — it only *prunes* mid-decode (§2). Listed
for completeness: validity is table stakes, not a quality signal. *Does it correlate with correct intent? No
— it's necessary, not sufficient.* This is exactly why beam-search-by-logprob is insufficient for us: it has
no signal beyond this plus LM probability.

**(R1) Type validity (Σ∩T) — binary, cheap, ELIMINATION + weak rank.** Run each completed branch's argument
slots through the existing async type gate (`narrowByTypeAsync` / `getTypeValidCandidates`). A branch that
fills a slot with a well-typed value beats one that (despite being structurally feasible) produces an
ill-typed argument the gate would have to widen-and-admit. *Does it correlate? Partially* — a branch that
respects the tool's parameter types is more likely the intended call. But two intents can both type-check
(`call-contact Dad` vs `facetime-contact Dad`), so R1 often won't separate them. Use it to **drop** a
type-broken branch, rarely to pick.

**(R2) Self-consistency across the surviving branches — cheap, but a TRAP here.** Classic self-consistency
(Wang et al. 2022, [arXiv 2203.11171](https://arxiv.org/abs/2203.11171)) and entropy-aware branching resolve
by **majority vote** over many samples. *Does it correlate with correct intent? PERVERSELY, NO — and this is
the key insight that separates us from the entropy-branching literature.* The whole premise (V's insight) is
that **the minority branch may be right**. Resolving by agreement would systematically discard exactly the
30% branch we branched to investigate — it re-implements the greedy bias at the branch level. **We
deliberately do NOT use vote-to-resolve.** (We may *log* agreement as a diagnostic — if branches always agree,
the trigger is firing on non-forks and `δ` should drop — but agreement must never *rank* branches.)

**(R3) — THE PRIMARY CRITERION — semantic eval against the request.** Run each completed branch through the
harness's per-program engine. **There is no `runAndScore` function** — the real entry points live in
`inhuman/examples/intent-eval/src/eval/`:

- **`runChain(chain, generator, opts)` / `runEval(chains, generator, opts)`** (`run.ts`) — the batch drivers.
  Note their signature: they take a `ChainGenerator` and *generate-then-execute* internally, returning a
  **`ChainResult`** (`{ program, executed, valid, passed, state, trace, … }`). They do **not** accept a
  pre-decoded program string — so the brancher cannot call `runChain` directly on an already-decoded branch
  (that would re-generate). The brancher reuses the **inside** of `runChain`, which is exactly two calls:
  `exec(program, { env: world.env, budgetMs })` from `@inhuman.tools/arrival` (execute the branch's program
  string against the device world), then `chain.assert(world.snapshot(), world.trace)` (a `StatePredicate`
  over the final state + trace).
- **`scoreEval(results: readonly ChainResult[]): EvalScore`** (`score.ts`) — reduces a *set* of `ChainResult`
  to aggregate metrics (`passRate`, `semanticResidual`, `validityRate`, …). It is an **aggregate reducer, not
  a per-program categorizer** — there is no `ok`/`wrong-tool`/`mis-slotted`/`empty` enum in the code. The real
  per-branch signal is the `ChainResult` triple `{ valid, executed, passed }` plus the `trace`.

**Resolver I/O (name it precisely):** `program: string → exec(program,{env}) → ChainResult{valid,passed,trace}
→ (rank)`; the aggregate `scoreEval(ChainResult[]) → EvalScore` is the *measurement* layer that sits over a
whole run, not the per-fork resolver. The branch categories the cascade ranks on are **derived from the
`ChainResult`**, not returned by a function: map `valid && passed → ok`, `valid && !passed → mis-slotted /
wrong-tool` (split by reading `trace`: did the recorded operator match the expected tool?), `!executed ||
empty-program → empty`, `!valid → invalid`. The ranking `ok > mis-slotted > wrong-tool > empty` is a
derivation over `ChainResult`, owned by the brancher. **This is the only resolver that sees *intent*, because
it's the only one that compares the program's *effect* (the executed `trace` + `state`) to the *request*
(`chain.assert` / the prompt).** *Does it correlate with correct intent? This IS correct intent, by definition
of the eval* — `chain.assert` is our operationalization of "did the program do what was asked." This is the
asset no other decoder has: a **cheap, exact terminal potential** (one `exec` + one `assert`), not a learned
twist function (SMC) or a vote (self-consistency).

  - **In production (no gold `task.expect`)** the sim-execution still resolves most forks: it discriminates
    `wrong-tool`/`empty`/`invalid` (the trace either fired the plausibly-right tool or didn't) **without**
    the gold predicate. The `ok`-vs-`mis-slotted` split needs the gold label and is an *eval-time* luxury; at
    serve time R3 degrades to "did this branch produce a non-empty, plausibly-on-intent trace," which still
    beats every probability-only resolver. The remaining ambiguity (two branches both produce plausible
    traces) falls through to R4.

**(R4) LLM-as-judge against the prompt — expensive, last resort, eval-time / high-value-serve only.** When R3
ties (both branches produce plausible non-empty traces and we lack a gold label to split them), ask a judge
model "which of these two tool calls better satisfies: `<prompt>`?" *Does it correlate? Yes, most directly* —
but it costs a model call per tie, so it fires only on the residual the cheaper resolvers couldn't split.
Gate it behind a flag; default off in the measurement loop (it would contaminate the very accuracy we're
measuring). This is the fallback, not the workhorse — R3 is the workhorse.

> **The cascade in one line:** prune by oracle (R0) and type (R1) *during* decode; resolve survivors by
> **sim-execution outcome (R3)**; break R3 ties by judge (R4) only when allowed. **Never resolve by branch
> agreement (R2).** The correlation argument: R3 is *definitionally* correct-intent on the eval; R0/R1 are
> necessary filters; R2 actively anti-correlates with V's thesis and is excluded.

**Why this beats EFG's resolution.** EFG would rank the same two branches by `P(branch) · c(branch)` — LM
probability times *grammatical* future. Both branches here are fully grammatical (`c ≈ 1` each), so EFG's
ranking collapses to `P(branch)` — i.e. it keeps the 60% branch. **Our R3 ranks by *did it do the right
thing*, which is orthogonal to and dominates `P(branch)`.** That gap is the whole reason to build this.

---

## 4a. Data flow — fork → depth-first decode → oracle-prune → resolve → commit

The end-to-end path of one program through the brancher. The shared greedy+EFG loop runs until the trigger
(§1) fires; everything inside the dashed box is the depth-first branch wrapper; control rejoins the shared
loop at `commit`.

```
                         shared greedy+EFG decode loop  (llama-cpp-generate.ts)
                                         │
                         each step: stepProbs → top2Margin, validSymbols(), position
                                         │
                              ┌──────────┴───────────┐
                              │  trigger? (§1 gates)  │   T1 margin<δ ∧ T2 ≥2 over p_floor
                              │  T1∧T2∧T3∧T4          │   ∧ T3 distinct entities ∧ T4 slot-boundary
                              └──────────┬───────────┘
                            no ┌─────────┴─────────┐ yes
                               │                   │
                    greedy pick, advance     forkIdx = seq.nextTokenIndex
                    (continue loop)           pick top-2 distinct entities  (branch-factor ≤2)
                               │                   │
                               │      ╔════════════╪════════════ DEPTH-FIRST BRANCH WRAPPER ═══════════╗
                               │      ║            ▼                                                    ║
                               │      ║   ┌──────────────────┐    branch nodes: state ∈                ║
                               │      ║   │  branch A: open  │    {open,pruned,completed,resolved}      ║
                               │      ║   └────────┬─────────┘                                          ║
                               │      ║     decode A token-by-token, greedy+EFG (§3)                    ║
                               │      ║            │                                                    ║
                               │      ║      ┌─────┴──────┐  R0 oracle live? ∧ R1 Σ∩T type ok?          ║
                               │      ║   kill│           │ok   (isCandidateLive / narrowByTypeAsync)   ║
                               │      ║       ▼           ▼                                             ║
                               │      ║   ┌────────┐  ┌─────────────────────────────────┐               ║
                               │      ║   │ pruned │  │ completed: full program string  │               ║
                               │      ║   │(drop,  │  │  exec(prog,{env}) (@h.b/arrival)│  ← R3 engine  ║
                               │      ║   │ no     │  │  chain.assert(snapshot, trace)  │    (run.ts    ║
                               │      ║   │ score) │  │  ⇒ ChainResult{valid,passed,..} │     internals)║
                               │      ║   └────────┘  └────────────────┬────────────────┘               ║
                               │      ║                                │                                ║
                               │      ║   eraseContextTokenRanges([{start:forkIdx, end:nextTokenIndex}])║
                               │      ║                rewind A → forkIdx;  repeat for branch B          ║
                               │      ║                                │                                ║
                               │      ║              ┌─────────────────┴──────────────────┐             ║
                               │      ║              │  RESOLUTION CASCADE (§4) over the   │             ║
                               │      ║              │  completed siblings:                │             ║
                               │      ║              │   R0 prune → R1 prune → R3 rank      │             ║
                               │      ║              │   (derive ok>mis-slotted>wrong-tool │             ║
                               │      ║              │    >empty from ChainResult+trace)   │             ║
                               │      ║              │   R2 vote  = EXCLUDED                │             ║
                               │      ║              │   R4 judge = flag-gated, eval-only  │             ║
                               │      ║              └─────────────────┬──────────────────┘             ║
                               │      ║                  strict winner? │ tie?                           ║
                               │      ║              yes ┌──────────────┴──────────────┐ tie            ║
                               │      ║                  ▼                              ▼                ║
                               │      ║       resolved = winner            resolved = greedy branch     ║
                               │      ║       (strict R3 upgrade)          (F2: tie-goes-to-the-model)   ║
                               │      ║                  └──────────────┬──────────────┘                 ║
                               │      ╚═════════════════════════════════╪══════════════════════════════╝
                               │                                        │
                               └────────────────►  COMMIT resolved.program past forkIdx, ◄──────────────┘
                                                   resume shared loop until EOS
                                                            │
                                                            ▼
                                                    program complete
```

**Reading the diagram against the corner cases (§2a):** if every branch lands in `pruned`
(`count(completed)==0`) the cascade is empty and the wrapper emits the greedy fallback (corner 1); if a second
fork fires while `forksUsed==BRANCH_BUDGET` the trigger diamond is forced down its `no` edge (corner 2); a
cascade with no `strict winner` takes the `tie` edge to the greedy branch (corner 3). All three rejoin the
single `COMMIT` node — the frontier has exactly one exit.

---

## 5. Cost & where it fires

**Trigger rate.** With the four-gate trigger (§1), forks fire only on genuine slot-level intent splits.
Estimate from the benchmark's recorded margin distribution: steps with `top2Margin < 0.25` *and* at a
slot boundary *and* across distinct entities are a small minority of the ~80–96 steps/program. Expect
**0–2 forks per program**, most programs **0** (decode exactly once, identical to today).

**Per-fork cost.** A fork with branch-factor 2, both surviving the oracle prune:
- Decode branch B to completion serially after A: **~one extra short decode** (the suffix after the fork, not
  a whole program — typically 5–30 tokens, since forks are late, at the call site).
- One `eraseContextTokenRanges` rewind (cheap; same primitive the loop already imports).
- Two branch executions against the sim (R3): `exec(program,{env})` + `chain.assert(...)` per branch (the
  inside of `runChain`, not a `runAndScore` call). The sim is a pure in-process interpreter run with a 2000ms
  budget — **sub-millisecond to low-ms** for these tiny programs. Negligible vs a forward pass.
- Type gate (R1): reuses the async fill already warming during decode — near-free.

**Total added cost per program** ≈ `forks × (one short suffix decode + 2 sim runs)`. On a program with one
fork: roughly **+10–30 forward passes** (the second branch's suffix) and **2 sim executions**. On a
zero-fork program: **+0**.

**Compare to Tier-A (1-step EFG lookahead):** Tier-A pays ~1–3 `controlledEvaluate` calls on each *contested*
step (more frequent than forks, since "contested" ⊇ "intent fork"). Uncertainty branching pays *more per
event* (a whole suffix decode + sim runs) but fires on a *strictly rarer* set (slot-boundary entity forks ⊂
contested steps). The two are **complementary in cost profile**: Tier-A is many-cheap-events, branching is
few-expensive-events. Neither dominates the easy path (both are ~free when the model is confident).

**The asymmetry that makes it affordable:** the sim eval (R3) is the expensive part *for everyone else*
(they'd need a reward model). **For us it's an in-process interpreter call** — we already built it as the
scorer. That's why resolve-by-execution is cheap *specifically for us* and would be prohibitive for a generic
decoder.

---

## 6. Composition & honest "is this just X?"

**With the EFG ladder (Tier 0/A/B):** orthogonal, layered (§3). EFG is the per-step local policy *inside*
each branch; branching is the cross-branch decision. Tier-0's premature-closer guard handles the
closer-vs-content case so branching never fires there (T3). **Ship order: EFG ladder first (it's strictly
cheaper and catches the label-bias family), uncertainty branching second (it catches the intent-fork family
EFG can't see).**

**With the type gate (Σ∩T):** the gate is both a *branch pruner* (R1, drops type-broken branches mid-decode)
and, via `validSymbols()`, the *fork detector* (T3 — distinct entities = distinct valid symbols). The gate
does double duty here; no new machinery.

**Is it beam search?** *Structurally similar, semantically not.* Beam keeps width-`k` ranked by **cumulative
LM logprob**; it would keep the 60% branch. We keep width-≤2 **ranked by sim-execution outcome**. The frontier
*management* is beam-shaped (a small ranked set carried forward); the **ranking key is the entire difference**,
and it's information beam search cannot access. Calling it "beam search" obscures that the resolution criterion
— not the frontier shape — is the contribution. Honest statement: **frontier ≈ adaptive beam (width ≤2,
oracle-pruned, depth-first); resolution = our terminal oracle, which beam search does not have.**

**Is it SMC / twisted SMC?** (Lew et al. 2023 [arXiv 2306.03081](https://arxiv.org/abs/2306.03081); Loula et
al. ICLR 2025 [arXiv 2504.13139](https://arxiv.org/abs/2504.13139), [JHU pdf](https://www.cs.jhu.edu/~jason/papers/loula+al.iclr25.pdf)).
*Same intent, different mechanism, and we own a sharper potential.* SMC carries N particles, reweights each by
a **twist function** (an *estimate* of expected future value) and **resamples** to clone promising prefixes.
Two reasons we don't adopt it as-is:
  1. **No cheap `seq_cp`** → resampling/cloning particles is expensive (the binding blocker; §2). Depth-first
     checkpoint+rewind is the affordable substitute.
  2. **Our potential is EXACT, not a twist.** SMC's twist is a *learned/approximated* `ψ(prefix) ≈ E[reward |
     prefix]`. We don't approximate — at a completed branch we **run the program and read the true outcome**
     (R3). We're doing SMC's *terminal* potential exactly, on a tiny frontier, instead of an *intermediate*
     twist approximately on a large one. If a `seq_cp` binding patch ever lands, the principled upgrade is
     "twisted SMC with our sim-outcome as the terminal potential and the oracle as the proposal" — but that's
     a later, heavier version; this proposal is the affordable first cut.

**Is it MCTS / tree-of-thought?** No. No rollout policy, no UCB, no value backpropagation over a tree, no
multi-step planning. It's a flat, budgeted, oracle-pruned branch at ≤2 decision points. Tree-of-thought
([Yao et al. 2023](https://arxiv.org/abs/2305.10601)) branches over *reasoning steps* and resolves by an LLM
self-evaluation; we branch over *token-level intent forks* and resolve by *execution*. Different granularity,
different (and cheaper, exacter) resolver.

**Is it entropy-aware branching?** ([Shih et al.-style "forking tokens",](https://arxiv.org/abs/2512.23765)
and the entropy-adaptive-decoding line, ~4.6% on small LLMs.) *The trigger is the same idea (branch at
high-entropy/low-margin "forking tokens"); the resolver is the opposite.* They resolve by **self-consistency
vote** — which (R2) *discards the minority branch*, the exact thing V wants to preserve. **Our contribution is
swapping their vote-resolver for an execution-resolver.** That single swap is what operationalizes "the
minority branch may be right."

> **The one-sentence positioning:** *every* prior method (beam, SMC, ToT, entropy-branching, self-consistency)
> resolves the frontier by **LM-derived probability or self-agreement**; we resolve it by **executing the
> program against ground truth**. The frontier machinery is borrowed and deliberately minimal (forced by the
> `seq_cp` gap); the **resolution-by-guarantee is the novel, defensible part**, and it's only cheap because we
> already own the oracle + type gate + sim eval.

---

## 7. Honest failure modes + guards

**(F1) Compute blowup if the trigger over-fires.** If `δ` is too high or T3/T4 are too loose, every mildly
uncertain step forks → 4× decode cost.
  - *Guard:* the hard `BRANCH_BUDGET = 2` forks/program (§2) caps worst case at ≤4 decodes regardless of
    trigger noise. Plus: log trigger rate; if forks/program > ~0.5 on the easy set, the trigger is mis-tuned
    (tighten `δ`, verify T3 is suppressing spellings).

**(F2) The minority branch was minority *for a good reason*.** Sometimes the 60% really is right and the 30%
is a genuine error; if R3 mis-ranks (e.g. both produce a plausible trace but the 30% one happens to satisfy
the fuzzy scorer spuriously), branching *introduces* a regression greedy wouldn't have.
  - *Guard 1 — tie-goes-to-the-model.* If R3 cannot strictly separate the branches (same category, and no gold
    label to split `ok`/`mis-slotted`), **keep the model's higher-probability (greedy) branch.** Never
    override greedy on a tie — only on a *strict* R3 improvement (`ok` > `mis-slotted` > `wrong-tool` >
    `empty`). This makes the change **weakly monotone**: it can only *upgrade* a category, never downgrade on
    noise.
  - *Guard 2 — the scorer's fuzziness is the risk surface.* `argsContainAny` is lenient; a spurious keyword
    match could rank a wrong branch `ok`. Mitigate by requiring R3 to clear `wrong-tool`/`empty` (high-signal,
    hard to spoof) for an override, and treating `mis-slotted`-vs-`ok` overrides as the low-confidence zone
    (defer to R4 judge if enabled, else keep greedy).

**(F3) Resolution criterion mis-ranks because the eval ≠ true intent.** The sim eval is *our* operationalization
of intent; on an ambiguous request the eval's `task.expect` encodes *one* reading. If the request is genuinely
ambiguous (the case V names — "the 30% is the right disambiguation"), the gold predicate might mark the
*correct* disambiguation as `wrong-tool`.
  - *Guard:* this is a measurement-validity issue, not a decoder bug. Flag forks where the two branches landed
    in *different* categories *and* both are plausible as a **"genuine-ambiguity" telemetry bucket** for human
    review — these are exactly the cases worth a clarifying question in a real product, and the cases that
    reveal whether our `task.expect` predicates are too narrow. Don't silently auto-resolve high-ambiguity
    forks in the measurement loop; surface them.

**(F4) Serial-decode latency.** Depth-first means branch B's decode is *added* wall-time (no parallelism,
courtesy of the `seq_cp` gap). On a latency-sensitive serve path, +10–30 tokens per fork is real.
  - *Guard:* gate branching behind a `branchOnUncertainty` flag, default **on for eval / off for low-latency
    serve** (or: cap to one fork on the serve path). The measurement loop wants the accuracy; a real-time
    assistant may prefer greedy+EFG. It's a knob, not a default-everywhere.

**(F5) Non-determinism / measurement contamination.** Branching changes outputs, which interacts with the
Stage-0 A/A + Gage R&R harness (which needs a controlled noise source).
  - *Guard:* branching is **deterministic** at `temperature = 0` (the branch order is fixed by prob-descending
    candidates; R3 is deterministic given the sim). So it composes with the existing deterministic-greedy
    measurement without adding noise. Keep R4 (judge) **off** in the measurement loop (it's the only
    stochastic resolver). Measure branching as a *fixed decoder variant* vs greedy, same as Tier 0 was
    measured — a clean A/B, not a noise source.

---

## 8. Recommended minimal first version (to measure)

Ship the smallest thing that tests V's hypothesis — *does the minority branch, resolved by execution, beat
greedy?* — with the least new machinery:

**V0 — "fork-and-execute," single fork, depth-first, R3-only.**
1. **Trigger:** the four gates (§1) with `δ = 0.25`, `p_floor = 0.15`, restricted to the **operator slot
   only** (tool-choice forks — the highest-signal, easiest-to-score case; defer argument-shape forks to V1).
2. **Frontier:** at the *first* triggered fork only (`BRANCH_BUDGET = 1` for V0), branch-factor 2 (top-2
   distinct tool-name entities via `validSymbols()`). Record `forkIdx = seq.nextTokenIndex` → decode A to
   completion (greedy + Tier-0 proxy, the shipped path) → **`eraseContextTokenRanges([{start: forkIdx, end:
   seq.nextTokenIndex}])`** to erase branch A back to the fork → decode B → done. (No `takeCheckpoint`; §2.)
3. **Resolve:** R3 only — `exec` + `chain.assert` both branches (the per-program engine inside `runChain`,
   §4), derive each branch's category from its `ChainResult{valid,passed,trace}`, keep the strictly-better
   category; **tie → greedy branch** (F2 guard). No R1/R4 yet.
4. **Instrument:** count forks fired, branch-override rate (how often B beat A), and the category delta. The
   headline number: **astAccuracy(greedy) vs astAccuracy(greedy+V0)** on the 14 apple tasks, same harness as
   the Tier-0 spike (`__benchmarks__`, opt-in).
5. **Falsification:** if branch-override rate is ~0 (the minority branch never wins) on these tasks, V's
   hypothesis doesn't pay *on this task set* — but the apple tasks are mostly unambiguous (T4 will rarely
   fire). **So V0 should ALSO run on a deliberately-ambiguous probe set** (e.g. "message Dad" where
   `send-message` vs `send-email` vs `call-contact` genuinely compete, "open music" where `play-music` vs
   `open-app Music` compete) — those are where the asset is supposed to pay, and where greedy is supposed to
   fail. Build ~6 such ambiguous tasks alongside V0; that's where the win (or the null result) is real.

**Explicitly deferred to later versions** (don't build in V0):
- V1: argument-shape forks (T4's second clause), `BRANCH_BUDGET = 2`.
- V2: R1 (type-gate pruning of branches) + R4 (judge tiebreak, eval-only).
- V3 (gated on a binding patch): twisted-SMC with sim-outcome terminal potential, *if* `seq_cp` lands.

**Why this is the right first cut.** It reuses the entire existing loop (greedy + Tier-0 in
`experimental/arrival/packages/arrival-sampler/src/__benchmarks__/llama-cpp-generate.ts`; the `exec` + `chain.assert`
engine inside `runChain` and the `scoreEval` reducer in `inhuman/examples/intent-eval/src/eval/{run,score}.ts`), adds
only the trigger, the depth-first **`eraseContextTokenRanges`-rewind** wrapper (§2 — no `takeCheckpoint`;
the shipped loop already calls `eraseContextTokenRanges` for prefix-boundary erase), and the branch resolver,
fires on a minority of programs, and produces the **one measurement that answers the question**: on an
intent-fork, does executing the minority branch and keeping the better outcome beat collapsing to greedy?
Everything heavier is deferred until that number says branching pays.

---

## 9. References

- **Wang et al. — Self-Consistency, ICLR 2023** — [arXiv 2203.11171](https://arxiv.org/abs/2203.11171). The
  vote-resolver we deliberately reject (R2): majority vote discards the minority branch.
- **Lew, Zhi-Xuan, Grand, Mansinghka — SMC Steering of LLMs, 2023** — [arXiv 2306.03081](https://arxiv.org/abs/2306.03081).
- **Loula et al. — Syntactic and Semantic Control via SMC, ICLR 2025** — [arXiv 2504.13139](https://arxiv.org/abs/2504.13139),
  [JHU pdf](https://www.cs.jhu.edu/~jason/papers/loula+al.iclr25.pdf). "Myopic" (per-token) vs long-horizon;
  twist functions reweight promising prefixes. Our resolver is SMC's terminal potential, made *exact* (we
  execute) rather than approximated, on a depth-first frontier (forced by the `seq_cp` gap).
- **Zhao et al. — Probabilistic Inference via Twisted SMC, 2024** — [arXiv 2404.17546](https://arxiv.org/abs/2404.17546).
  The twist-function framing; contrast with our exact terminal potential.
- **Park, Wang, Berg-Kirkpatrick, Polikarpova, D'Antoni — Grammar-Aligned Decoding (ASAp), NeurIPS 2024** —
  [arXiv 2405.21047](https://arxiv.org/abs/2405.21047). The EFG ladder this composes with; EFG re-weights one
  pick by *grammatical* future and is request-blind — orthogonal to intent-fork resolution.
- **Nguyen et al. — Min-p Sampling, 2024** — [arXiv 2407.01082](https://arxiv.org/abs/2407.01082). The
  mass-floor gate (T2) for bounding fan-out by the model's own dispersion.
- **Yao et al. — Tree of Thoughts, NeurIPS 2023** — [arXiv 2305.10601](https://arxiv.org/abs/2305.10601).
  Branches reasoning steps, resolves by LLM self-eval; we branch token-level intent forks, resolve by execution.
- **Entropy-aware / forking-token decoding** — e.g. [arXiv 2512.23765](https://arxiv.org/abs/2512.23765) and
  the entropy-adaptive line (~4.6% on small LLMs). Same *trigger* (branch at low-margin forking tokens),
  opposite *resolver* (self-consistency vote vs our execution). Our swap of the resolver is the contribution.
- **node-llama-cpp `LlamaContextSequence`** (v3.18.1) — `controlledEvaluate` (depth-1 lookahead, the Tier-A
  primitive); **`eraseContextTokenRanges`** (the depth-first rewind primitive this design uses — erase the
  branch token-range back to the fork index); `takeCheckpoint` (a recurrent/SWA prefix-reuse helper, **not** a
  save/restore handle — no-op on a standard transformer, §2); `saveStateToFile`/`loadStateFromFile` (the only
  true full-state snapshot — disk, expensive, not a per-fork primitive); **no `seq_cp`** (the parallel-particle
  blocker that forces depth-first over fan-out, and the reason no cheap in-memory checkpoint exists).

## 10. Open questions

- Calibrate `δ` and `p_floor` from the recorded margin distribution before V0 — what fraction of steps clear
  T1∧T2∧T3∧T4 on the apple set vs the ambiguous probe set? (If ~0 on the ambiguous set, the trigger is wrong;
  if >0.5 on the easy set, it's too loose.)
- Does branch-override rate (B beats A) actually correlate with the model's *lower* confidence in A? (Plot
  override-rate vs `top2Margin` at the fork — the thesis predicts more overrides at smaller margins.)
- Production R3 without gold labels: how often does sim-execution alone (no `task.expect`) strictly separate
  two branches? If rarely, R4 (judge) is load-bearing at serve time and the cost story changes.
- Is there a cheaper *intermediate* potential than full-branch execution — e.g. score the branch the moment
  the tool name + first arg are committed, before the whole call closes? (A partial-trace resolver would cut
  the suffix-decode cost, edging back toward an SMC intermediate twist — but exact, on the partial trace.)
