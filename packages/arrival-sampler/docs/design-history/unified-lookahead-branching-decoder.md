# Plan: unified expected-future decode loop (Tier A lookahead + uncertainty branching)

**Status**: SHIPPED — implemented as designed (`experimental/arrival/packages/arrival-sampler/src/runners/local/backends/llama/{branching,lookahead,tier-strategies}.ts`; probe primitive per §3a, branch constants per the companion doc). Kept as the design record. · designed 2026-06-20 · owner: sampler · companion to
`constrained-decode-label-bias.md`
**Decision**: build the `controlledEvaluate`-based decode loop ONCE, structured so single-path expected-
future lookahead (Tier A) is the depth-1/width-1 special case of multi-hypothesis branching. Avoids
rewriting the core loop twice.

> §5 (branching frontier + resolution) is filled from the uncertainty-branching design agent's output;
> until then it carries the shape we already know it must have. Everything else (the loop rewrite, the
> probe primitive, Tier A) is design-stable and does not depend on the branching specifics.

## 1. Goal & non-goals

**Goal.** Replace the llama decode loop's `evaluateWithMetadata` *generator* stepping with a
`controlledEvaluate`-based stepping that supports, behind flags, four decoders sharing one code path:
`greedy` (today) · `proxy` (Tier 0, shipped) · `lookahead` (Tier A) · `branch` (uncertainty branching).
Every tier is a tighter estimate of the same quantity — expected future grammaticality `c(prefix)`.

**Non-goals.** Tier B (ASAp/SMC) — not in this plan. The browser/lazy-processor path — unchanged (this is
the Node/Metal `__benchmarks__` loop only). The oracle/`isCandidateLive` predicate — unchanged (it stays
the `c̃=1[live]` base case).

## 2. The verified primitive (de-risked empirically)

`controlledEvaluate([[tok, {generateNext:{probabilities:true}}]])` advances the sequence by `tok` and
returns the successor distribution; `eraseContextTokenRanges([{start, end}])` rolls it back. **Measured
clean:** re-probing a candidate after rollback returns the identical distribution (A1==A2) and
`nextTokenIndex` is restored — no drift. (The earlier flakiness was the *generator* + prefix-reuse path;
this path is clean.) **Constraint:** `controlledEvaluate` probes cannot be mixed into an *active*
`evaluateWithMetadata` generator — hence the loop must move its stepping onto `controlledEvaluate` too.

## 3. The loop rewrite (generator → controlledEvaluate) — the shared core

Current (`llama-cpp-generate.ts`): `const gen = s.evaluateWithMetadata(prompt,…); result = await
gen.next(chosenTok)` commits a token and yields the next dist. New:

- **Prefill:** `out = await s.controlledEvaluate([...prompt.slice(0,-1), [last,{generateNext:{probabilities:true}}]])`
  → baseline dist at `s.nextTokenIndex`.
- **Step:** keep the existing per-step logic verbatim — `stepProbs`, top1/top2/`top2Margin`, `closeable =
  scanner.analyze(prefix)`, `pickConstrained`, the Tier-0 `expectedFutureProxy` block, `onStep`/`onExplain`.
  Only the *advance* changes: commit via `out = await s.controlledEvaluate([[chosenTok,{generateNext:
  {probabilities:true}}]]); dist = out[0].next.probabilities`.
- **Parity requirement:** with all expected-future flags OFF, the new loop must produce **token-identical**
  output to the generator loop (same greedy constrained argmax). This is the gate test (§7).

### 3a. The reversible-probe step primitive (what both Tier A and branching call)

```
probeSuccessor(seq, tok): Promise<Map<Token,number>>   // evaluate tok, read successor dist, ROLL BACK
  base = seq.nextTokenIndex
  out  = await seq.controlledEvaluate([[tok, {generateNext:{probabilities:true}}]])
  await seq.eraseContextTokenRanges([{start: base, end: seq.nextTokenIndex}])
  return out[0].next.probabilities
```

One forward eval + one erase, leaves the sequence exactly as found. Tier A calls it per candidate at a
contested step; branching calls it to score frontier extensions. **This is the single primitive the whole
plan rests on** — already verified.

## 4. Tier A — 1-step expected-future lookahead (single path)

At a **contested step** (the Tier-0 trigger generalized: the greedy pick is a closer/low-commitment token
AND ≥1 feasible content candidate exists), gather candidate set `C = {greedy pick} ∪ {top-m feasible
content tokens}`, m≈3. Score each by one real step of EFG:

```
score(c) = P(c) · liveMass(prefix·c)
liveMass(p) = Σ over top-K of probeSuccessor(seq, c.token) of  prob(t)·[isCandidateLive(p, t)]
            + (scanner.analyze(p).closeable ? P(eos in successor) : 0)
pick argmax score(c)
```

`P(c)·liveMass` is ASAp's EFG recursion truncated to depth 1 (the binary oracle bound as the inner `c̃`).
Cost: `|C|` probes (~3 forward evals) ONLY on contested steps (rare; counted by `proxyOverrides`); 0 on the
~95% confident steps. Greedy-only (`temperature≤0`). Replaces the Tier-0 prob-only ranking with EFG-weighted
ranking — Tier 0 becomes the `|C|=0` (no-probe) degenerate of Tier A.

## 5. Uncertainty branching (multi-path) — from `constrained-decode-uncertainty-branching.md`

**Thesis:** every prior brancher (beam, SMC, ToT, entropy-branching, self-consistency) resolves its frontier
by LM-probability or self-agreement; **we resolve by *executing the branch against ground truth*.** That
swap is the whole contribution — the frontier machinery is borrowed and deliberately minimal.

- **Branch trigger — four gates, ALL required (§1 of the design):** `top2Margin < 0.25` · ≥2 candidates
  above a 0.15 mass-floor · the contenders are **distinct lexer-entities** (via `scanner.analyze(prefix)
  .validSymbols()`, NOT BPE spellings of one symbol — the meaningful gate, oracle gives it free) · at an
  **operator or argument-slot boundary**. (V's 60/30 case ⇒ fork.)
- **Frontier (§2):** node-llama-cpp (3.18.1) has **no `seq_cp` KV-copy fan-out** (verified) ⇒ **depth-first
  token-range rewind on one sequence**. The rewind is **`eraseContextTokenRanges([{start: forkIdx, end:
  nextTokenIndex}])`** alone (erase the whole branch range back to the fork) — **not** `takeCheckpoint`, which
  is a recurrent/SWA prefix-reuse helper that no-ops on a standard transformer and is *not* a save/restore
  handle; the only true snapshot is `saveStateToFile` (disk, expensive), so **there is no cheap in-memory
  checkpoint** — the design correction in the branching doc §2. **Width ≤2, budget ≤2 forks/program.** The
  oracle prunes dead branches *before* decoding them — the cheapness asymmetry; the per-fork rewind is a
  cheap KV-range delete, so branching's whole price is branch B's serial suffix re-decode.
- **Resolution — lexicographic cascade (§4), the differentiating part:** R0 oracle-validity → R1 Σ∩T
  type-gate (both **elimination filters**) → **R3 execute the branch against the device sim — the PRIMARY
  resolver, the only criterion that compares the program's *effect* to the *request* (sees intent)**. There is
  **no `runAndScore`** — the engine is the inside of `runChain` (`inhuman/examples/intent-eval/src/eval/run.ts`):
  `exec(program, { env })` from `@inhuman.tools/arrival` then `chain.assert(world.snapshot(), world.trace)`,
  yielding a **`ChainResult{valid,passed,trace}`** the brancher ranks; `scoreEval(ChainResult[]) → EvalScore`
  (`score.ts`) is the aggregate *measurement* reducer, not the per-fork resolver.
  **R2 self-consistency vote is REJECTED**: voting discards the minority branch we set out to preserve —
  greedy bias at the branch level. This is the exact divergence from entropy-branching (same trigger,
  opposite resolver).
- **Composition (§3/§6):** EFG (Tier 0/A/B) is the per-step policy *inside* each branch; branching is the
  cross-branch decision — **orthogonal, layered**. EFG is *request-blind* (knows only the grammar) so it
  structurally cannot pick `call-contact` over `facetime-contact`; **only execution can**. The type gate does
  double duty (fork detector + branch pruner). Honest: frontier ≈ adaptive beam, resolver-intent ≈ SMC's
  terminal potential — but made **exact** (we execute) rather than an approximated twist.
- **V0 "fork-and-execute" (§8):** single operator-slot fork, depth-first, **R3-only, tie-goes-to-greedy**
  (weakly monotone — can only *upgrade* a category, never regress). Reuses the whole loop. Measurement:
  `astAccuracy(greedy)` vs `astAccuracy(greedy+V0)`.
- **Failure modes + guards (§7):** compute blowup (hard budget) · minority-for-good-reason (strict-
  improvement-only override) · eval≠true-intent on genuinely ambiguous requests (telemetry bucket for human
  review, not auto-resolved) · serial latency (on-for-eval/off-for-low-latency-serve knob) · measurement
  contamination (deterministic at τ=0 ⇒ clean A/B; keep the LLM judge OFF in the loop).

### 5a. ⚠ The resolver-deployability tension (flag for eng-review)

R3 (`exec` the branch + `chain.assert` against the sim — the `runChain` internals, *not* a `runAndScore`
call) needs **ground truth at decode time** — the device-sim's state assertion (`chain.assert` / the
`StatePredicate`) encodes the expected intent. That exists in the **eval/device-sim** context but **not in real deployment**
(no assertion when serving a user). So V0/R3 measures a **ceiling**: "does the frontier *contain* the right
branch, and would a perfect resolver pick it?" — a valid, important measurement (it proves the minority
branch is ever right). The **deployable** resolver is a *different* object: R0/R1 (validity/type, free) + a
request-grounded re-score that is NOT the assertion (LLM-judge, or a learned scorer, or — for our actual
product — the agent's own MCP round-trip). The plan must keep these two separate: **V0 = ceiling
measurement; deployable branching = R0/R1 + a real request-scorer.** Do not let the eval's assertion leak
into a "decoder" we claim is deployable.

## 6. Flags & surface

`llamaCppGenerator` hooks gain `decodeStrategy?: "greedy" | "proxy" | "lookahead" | "branch"` (default
`greedy`), superseding the boolean `expectedFutureProxy` (kept as an alias → `proxy`). Threaded through
`generateWithExplain` → the bench backend (env `DECODE_STRATEGY`) exactly as `expectedFutureProxy` is today.
Telemetry gains `probes` (forward evals spent), `contestedSteps`, `branchesOpened`, `branchesPruned`.

## 7. Test matrix

| Invariant | Test | Level |
|---|---|---|
| Probe primitive leaves seq unchanged (A1==A2, index restored) | `probe-rollback` assertion | unit (model) — already run as a spike; promote to a gated micro-test or `__benchmarks__` |
| **Loop parity**: strategy=greedy ≡ the generator loop, token-for-token | new parity test over a fixed prompt+grant env (compare chosen-token sequences) | unit/bench |
| `isCandidateLive` / oracle behavior unchanged | existing 267 sampler tests stay green | gate |
| Tier A recovers `80`-class without regressing the rest | BFCL grammar bench, strategy=lookahead vs greedy | bench |
| Branching resolution picks the correct-intent branch on a seeded fork | a constructed fork case (design will name it) | bench/research |
| Cost bound: probes/program within budget | telemetry assertion (`probes` ≤ k·contestedSteps) | bench |

The **loop-parity test is the load-bearing one** — it proves the generator→controlledEvaluate rewrite is
behavior-preserving before any expected-future logic is trusted.

## 8. Risks & rollback

- **Parity drift** (controlledEvaluate stepping ≠ generator stepping). Mitigation: the parity test gates;
  if it can't be made identical, keep the generator path for `greedy` and use controlledEvaluate only for
  the expected-future strategies (dual-path, uglier but safe).
- **Probe cost on Metal.** Each contested step = `|C|`/`W` forward evals. Mitigation: hard-gate probing to
  genuinely contested steps; cap with a per-program budget; telemetry surfaces it.
- **node-llama-cpp erase semantics under load.** De-risked for the single-probe case; re-verify for
  rapid repeated probes within one step (branching) before trusting width>1.
- **Scope creep into Tier B.** Explicitly out; ASAp/SMC stay future.

## 9. Sequencing (the build, post-eng-review)

1. Loop rewrite to `controlledEvaluate` + the §3a probe primitive, **all strategies = greedy passthrough**.
   Land the **parity test** green first. (No behavior change yet.)
2. Tier A `lookahead` strategy on the probe primitive. Bench vs greedy; confirm `80`-class recovery.
3. Branching `branch` strategy per §5. Bench on the fork case.
4. Wire `decodeStrategy` through the bench; add to the multi-model sweep as a column.

### 9a. Implementation dependency DAG

The sequencing above is the linear story; the actual build is a DAG — several nodes are independent and can
land in parallel, and the critical path is shorter than the 1→4 list suggests. Each node names the file it
lands in and the primitive/entry it rests on (all verified present).

**Node table.**

| # | Node | Lands in | Rests on (verified) | Depends on |
|---|---|---|---|---|
| N0 | `probeSuccessor` primitive (§3a) | `arrival-sampler/src/__benchmarks__/llama-cpp-generate.ts` | `controlledEvaluate` + `eraseContextTokenRanges` (`LlamaContextSequence`, 3.18.1) | — (spike already green) |
| N1 | Loop rewrite generator→`controlledEvaluate`, all strategies = greedy passthrough | same file | N0 primitive; existing `stepProbs`/`pickConstrained`/Tier-0 block | N0 |
| N2 | **Loop-parity test** (greedy ≡ generator, token-for-token) | `arrival-sampler` `__benchmarks__` (or gated micro-test) | fixed prompt+grant env | N1 |
| N3 | `decodeStrategy` flag surface (`"greedy"|"proxy"|"lookahead"|"branch"`, env `DECODE_STRATEGY`) | `llama-cpp-generate.ts` hooks + bench backend | existing `expectedFutureProxy` threading | N1 |
| N4 | Tier A `lookahead` strategy | `llama-cpp-generate.ts` | N0 (`probeSuccessor`); `isCandidateLive`; `scanner.analyze` | N2, N3 |
| N5 | Branch **trigger** (T1–T4: `top2Margin`, `validSymbols()`, `position`) | `llama-cpp-generate.ts` | existing `StepMetric.top2Margin`; `scanner.analyze().validSymbols()` | N2 |
| N6 | Depth-first **branch wrapper** (`forkIdx` → decode A → `eraseContextTokenRanges` rewind → decode B); frontier state machine (branching doc §2a) | `llama-cpp-generate.ts` | `eraseContextTokenRanges` (rewind; **no** `takeCheckpoint`) | N4, N5 |
| N7 | **R3 resolver seam** (`program → exec(program,{env}) → chain.assert → ChainResult`; derive `ok>mis-slotted>wrong-tool>empty`) | new resolver module beside `inhuman/examples/intent-eval/src/eval/run.ts` | `exec` (`@inhuman.tools/arrival`); `createDeviceWorld`; `chain.assert`/`StatePredicate` | — (independent of the loop; parallel to N0–N6) |
| N8 | Branch `branch` strategy = wrapper + resolver wired (V0: R3-only, tie→greedy) | `llama-cpp-generate.ts` | N6 + N7; F2 tie-guard | N6, N7 |
| N9 | Telemetry (`probes`, `contestedSteps`, `branchesOpened`, `branchesPruned`) | `llama-cpp-generate.ts` + bench report | — | N4, N8 |
| N10 | Bench wiring: `decodeStrategy` column in the multi-model sweep; fork-case + ambiguous-probe set; `scoreEval` aggregate | `inhuman/examples/intent-eval` + `arrival-sampler` `__benchmarks__` | `runEval` / `scoreEval` (`eval/{run,score}.ts`) | N8, N9 |

**ASCII DAG.**

```
                                  N0  probeSuccessor primitive  (spike green)
                                   │
                                   ▼
                                  N1  loop rewrite (greedy passthrough)
                                   │
                       ┌───────────┼───────────┐
                       ▼           ▼           ▼
                      N2          N3          N5  branch trigger (T1–T4)
                 parity test   flag surface    │   (needs only N1's step metrics)
                  (GATE)           │           │
                       └─────┬─────┘           │
                             ▼                 │
                            N4  Tier A lookahead│
                             │                 │
                             └────────┬────────┘
                                      ▼
   N7  R3 resolver seam ───────────► N6  depth-first branch wrapper
   (exec + chain.assert;             │   (forkIdx → decode A →
    INDEPENDENT — parallel           │    eraseContextTokenRanges → decode B;
    to N0–N6, no loop dep)           │    state machine §2a)
            │                        │
            └───────────┬────────────┘
                        ▼
                       N8  branch strategy (V0: R3-only, tie→greedy)
                        │
                        ▼
                       N9  telemetry
                        │
                        ▼
                       N10 bench wiring + sweep column + fork/ambiguous sets
```

**Critical path.** `N0 → N1 → N2 (parity GATE) → N4 → N6 → N8 → N9 → N10`. Seven hops; **N2 is the hard
gate** — nothing expected-future is trusted until greedy is proven token-identical to the generator loop
(the load-bearing test, §7). Two structural facts shorten the wall-clock:
- **N7 (the R3 resolver: `exec` + `chain.assert`) is fully off the critical path** — it depends on no loop
  node (it consumes a finished program string), so it can be built and unit-tested in parallel with N0–N6 and
  is merely *joined* at N8. It is the differentiating asset (§5) yet the cheapest to land independently.
- **N3 (flag surface) and N5 (trigger) are off-critical too** — both fork from N1 and rejoin later (N3 at N4,
  N5 at N6), so they overlap the parity work rather than extend it.

The minimal *measurable* milestone is **N0→N2→N5→N6→N7→N8** (skipping N3/N4/N9): a greedy loop with a single
operator-slot fork resolved by `exec`+`assert`, behind a hardcoded branch path — enough to answer V's
question (does the minority branch, resolved by execution, beat greedy?) before investing in Tier A or the
full flag/telemetry surface.
