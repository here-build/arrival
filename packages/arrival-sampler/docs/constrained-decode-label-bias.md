# Constrained decode is label-biased: token probability ≠ lexer-entity probability

**Status**: problem statement + design space · 2026-06-20 · owner: sampler
**TL;DR**: our constrained decoder is the naïve one — mask infeasible tokens, walk prob-descending,
keep the first feasible token. That is *locally normalized, per-token, zero-lookahead* decoding, and it
suffers **label bias**: it picks the argmax feasible **token**, not the argmax feasible **completion**.
Several of our "the model is worse in Scheme" failures are actually this decoder leaving valid-completion
mass on the table. Our accuracy numbers are therefore a **lower bound**, and the representation fights
(quote vs string vs value-symbol) are *downstream symptoms* of the decoder, not the root.

---

## 1. The problem, stated exactly

At each decode step our loop (`llama-cpp-generate.ts` → `isCandidateLive` from `mask-compiler.ts`) takes
the model's prob-sorted token distribution, walks it descending, and keeps the **first feasible** token
(greedy keepN=1 = the constrained argmax). This compares the probability of the **next token**. It never
accounts for the probability of the **completion** that token leads into.

Worked example (the framing that surfaced this):

- token `action` = **60%**, but its valid futures are sparse — say 20% of its continuations complete a
  correct call → expected-correct ≈ `0.60 × 0.20 = 0.12`.
- token `!action` = **30%**, but 90% of its continuations are correct → expected-correct ≈
  `0.30 × 0.90 = 0.27`.

`!action` is the better choice (0.27 > 0.12). **Greedy picks `action`** — it only sees the current token.
Per-step normalization cannot move probability mass backward from a future observation, so it
**systematically favors locally-concentrated, low-branching paths regardless of where they lead.**

## 2. Two compounding mechanisms

**(a) Expected-future blindness — label bias.** The classic failure of *locally-normalized* sequence
models (CRF paper, Lafferty/McCallum/Pereira 2001; revived for neural decoders by Andor et al. 2016,
"Globally Normalized Transition-Based Neural Networks"). A locally-normalized model can't redistribute
mass based on the future, so it prefers low-entropy transitions. Greedy constrained decode with per-token
renormalization *is* a locally-normalized model — label-biased by construction.

**(b) Token-vs-entity — tokenization bias.** One lexer entity (`fastest`, `vegan`) is spelled by **many**
token sequences. If the entity's mass is fragmented across, say, 5 tokenizations at ~10% each, its *true*
50% is invisible to a token-argmax that sees a single concentrated 60% **wrong** token. Recovering it
requires **marginalizing over tokenizations** before the argmax. (Microsoft Guidance "token healing";
the tokenization-bias literature.)

Both are consequences of deciding at the **token** granularity what is really a question about the
**entity / completion** granularity.

## 3. The named prior art (verify + extend in research)

- **Label bias** — Lafferty, McCallum, Pereira 2001 (CRFs); the canonical name for §2(a).
- **Globally-normalized neural decoding** — Andor et al. 2016; label bias in neural seq models.
- **Grammar-Aligned Decoding / ASAp** — Park et al., NeurIPS 2024: *proves standard grammar-constrained
  decoding does NOT sample from the LLM distribution conditioned on the grammar* (distorted by label
  bias), and proposes **A**daptive **S**ampling with **A**pproximate Expected Futures — weight each token
  by its approximate *further* probability of completing a valid string. This is the closest match.
- **Token healing / tokenization bias** — Guidance; §2(b).
- (research to confirm/extend: constrained beam search, MBR decoding, EFG/expected-future-grammar,
  locally-vs-globally normalized energy models, lookahead heuristics in semantic parsing.)

## 4. Our exposure (concrete)

- **`80` is textbook.** Asked for `dietary_requirements: ["vegan"]`. The model's natural form `'vegan`
  was masked (quote-forbid); greedy then took the *locally* highest feasible token `)` (close the list)
  over `"vegan"` — even though `"vegan")` carries more valid-completion mass than `(list)`. We emitted
  `(list)` (empty) and lost vegan **to label bias**, not to "strings unsupported" (the string slot is
  provably feasible there — checked at the gate).
- **The representation fights are downstream.** We have been trying to fix quote-vs-string-vs-value-symbol
  at the *gate* and *scorer* because the *decoder* mis-picks among representations. With expected-future
  weighting, the model's true preference surfaces and the representation matters far less. We were
  treating a symptom.
- **Part of the "−7.5pp format cost" is decoder, not capability.** Some of "the model reasons worse in
  Scheme" is "our greedy constrained decoder leaves valid-completion mass on the table." So the current
  BFCL numbers (grammar/typed 90%) are a **lower bound**; a better decoder closes some of the gap for
  free — which *strengthens* the thesis (the constraint costs less than it looks).

## 5. What is NOT broken

The **constraint itself is sound** — the oracle/mask guarantees structural + bound-symbol (+ optional
type) validity, and that guarantee holds (validity 100% empirically). We have paired a sound constraint
with the naïvest possible decoder. This doc is about the **decoder**, not the oracle.

## 6. Fix ladder (cheap → principled) — VERIFIED against the literature + our code

The whole field reduces to **one quantity: expected future grammaticality (EFG)** — `c(prefix) =
E_P[1[w∈L(G)] | prefix]`, the LLM-weighted probability that a prefix *completes* grammatically. The exact
grammar-conditioned conditional is `Q(wᵢ|·) ∝ P(wᵢ|·) · c(w₁..ᵢ)`. **GCD — what every library AND our loop
do today — is the degenerate approximation `c ≈ 1[prefix is still extendable]`, a binary indicator. That
binary indicator IS our `feasible`/`closeable` oracle.** The distortion is using `1`/`0` where the true
weight is a mass in `[0,1]`. Every fix below is a tighter estimate of the SAME `c`; they layer.

> **White-space finding (from the design research):** *no* production constrained decoder does expected-
> future weighting — Outlines, XGrammar, llguidance, Guidance, llama.cpp GBNF are all mask-then-local-
> sample, zero lookahead. Their sophistication only makes the *mask* correct, never the *distribution*
> globally correct. The expected-future correction is open white-space, and we own the one asset (a cheap
> oracle) that makes the cheap version cheap.

- **Tier 0 — premature-closer guard (`expectedFutureProxy`). SHIPPED + MEASURED.** 0 extra forward evals,
  pure oracle. When the model's top pick was masked *content* but greedy collapses to a *closer*, pick the
  best feasible *content* token instead. It is a 0-eval truncation of ASAp's EFG recursion. **Result:
  recovered `80` (`(list)` → `(list "vegan")`), grammar 90.0 → 92.5%, gap to native-python −7.5 → −5.0pp.**
- **Tier A — 1-step expected-future lookahead.** At *contested steps only* (today's proxy trigger), weight
  each candidate `c` by `P(c) · liveMass(prefix·c)` where `liveMass` = oracle-feasible mass of the NEXT
  distribution, obtained by ONE `controlledEvaluate([c.token])` (node-llama-cpp reads the successor logits
  *without committing* — no KV rollback needed; the earlier `eraseContextTokenRanges` flakiness does not
  apply). This is literally ASAp's EFG recursion truncated to depth 1 — same theoretical footing, ~1–3
  evals on the rare contested steps, 0 on the rest. **The next build.**
- **Tier A.5 — oracle structural partition bound (free).** Add `minTokensToClose` / `liveBranchCount` to
  `OracleState` (the contract has `closeable`/`overClosed`/`validSymbols` today, no depth/branch bound).
  The Stolcke-style grammar-only half of `c`, 0 forward evals — a prior that composes with Tier A's LLM term.
- **Tier B — ASAp (amortized EFG over a prefix trie).** Distribution-correct *in the limit* (Park et al.,
  NeurIPS 2024); refine `c̃` by a backward walk after each of many samples of the same task. Honest caveat:
  convergence is asymptotic with no finite-sample rate and **slow in practice** (thousands of samples) — so
  Tier B is a *targeted* tool for known-hard tasks, not the default path. `isCandidateLive` is unchanged —
  it stays the `c̃=1[live]` base case; ASAp wraps around it.
  - *Fork in the road:* AWRS-weighted SMC (Lipkin/Loula, ICLR 2025) is the stronger *single-pass*
    principled option and is built for "we own a cheap oracle" — **but** needs N parallel sequences, and
    node-llama-cpp exposes no cheap `seq_cp` KV-copy. SMC beats ASAp for us *only if* we later patch the
    binding to expose `llama_kv_cache_seq_cp`.

**Tokenization marginalization is NOT on the ladder — deliberately.** The design research measured the
real rnj-1/Llama-3 BPE: every short enum spelling (`fastest`, `monthly`, `vegan`) has exactly ONE canonical
tokenization, and models concentrate >99.9% of mass on it (Chirkova et al. 2023) — within-entity
fragmentation recovers <0.5%, concentrated on long/rare words we don't use. The `80`-class failures the
doc first filed under §2(b) are mechanistically **§2(a) label bias over representations** (bare vs string
vs quote), which the EFG ladder already catches. The one genuine tokenization hazard — prompt-boundary
mis-conditioning right after a forced `"`/`'`/`(` opener (token healing) — is subsumed by Tier A's 1-token
lookahead past the opener. So: **skip standalone marginalization; fold token-healing into Tier A.**

## 7. Measurement — DONE (Tier 0 spike)

Quantified the prize with the 0-eval Tier-0 proxy on BFCL-simple grammar mode (Rnj-1, Metal, quote-forbid):

| | astAccuracy | `80` | gap to native-python |
|---|---|---|---|
| greedy baseline | 90.0% | `(list)` — empty, FAIL | −7.5pp |
| + Tier 0 proxy | **92.5%** | `(list "vegan")` — PASS | **−5.0pp** |

`80` was the only label-bias-recoverable failure in the set; the residual `35`/`69` are genuine reasoning
gaps and `158` is BFCL ground-truth strictness (fails in *native python* too). **Finding confirmed: the
string was never blocked in the grammar — the decoder was bailing to a premature closer. "What's blocking
the string" = the decoder.** Tier A (real 1-step EFG) should recover any deeper garden-path cases a weaker
model exhibits; the prize grows as model strength drops.

## 9. References (verified by the design research)

- **Park, Wang, Berg-Kirkpatrick, Polikarpova, D'Antoni — "Grammar-Aligned Decoding" (ASAp), NeurIPS 2024**
  — arXiv [2405.21047](https://arxiv.org/abs/2405.21047), code `github.com/ebmoon/transformers-GAD`. The
  EFG recursion is the spine of the whole Tier ladder; proves GCD ≠ the grammar-conditioned distribution.
- **Lafferty, McCallum, Pereira — "Conditional Random Fields", ICML 2001** — coins "the label bias problem"
  (§2(a)'s canonical name). *Note:* the SMC constrained-decoding literature calls our exact failure
  "myopic," not "label bias" — label bias is our (correct) classical bridge, flag it as such.
- **Andor et al. — "Globally Normalized Transition-Based Neural Networks", ACL 2016** — arXiv
  [1603.06042](https://arxiv.org/abs/1603.06042); local ⊊ global expressiveness (theorem itself from Smith
  & Johnson 2007).
- **Lipkin/Loula et al. — AWRS / SMC for constrained LM, ICLR 2025** — arXiv
  [2504.05410](https://arxiv.org/abs/2504.05410). The single-pass principled option; gated on a `seq_cp`
  binding patch.
- **Chirkova et al. — "Should you marginalize over possible tokenizations?", ACL 2023** —
  [2306.17757](https://arxiv.org/abs/2306.17757). The magnitude number that kills standalone tokenization
  marginalization for us (<0.5%; >99.9% canonical mass). **Token healing**: Microsoft Guidance.
- **node-llama-cpp `LlamaContextSequence`** — `controlledEvaluate` (read successor logits without
  committing — the Tier A primitive), `eraseContextTokenRanges`/`takeCheckpoint` (rollback), **no** cheap
  `seq_cp` fan-out (the SMC blocker).

## 8. Open questions for the design research

- Cheapest correct approximation of expected-future mass given we **own the oracle** (the feasibility
  predicate is ours, and we already have the full per-token distribution each step)?
- Can the oracle's `feasible`/`closeable` state cheaply bound the future partition function (e.g. "this
  prefix can still reach a complete call in ≤k tokens")?
- Lookahead depth vs cost on llama.cpp/Metal (each lookahead token = one forward eval of a short suffix)?
- Does tokenization marginalization need the tokenizer's merge table, or can we approximate by
  re-scoring the top-K detokenized strings?
- Interaction with the type gate (Σ∩T): does expected-future weighting subsume the value-symbol steering
  (§4 — if the decoder picks the right entity, we may not need to *force* the bare-symbol form)?
