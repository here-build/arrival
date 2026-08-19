# The Cost of a Constraint Is the Probability Mass It Forces

### Minimal-intervention grammar constraints for LLM tool calls — an argument with a working artifact

> **Status: unpublished working paper, satellite to an experimental package.** This document
> states the argument that `@inhuman.tools/arrival-sampler` exists to make. The package is the
> experiment; the model-free test suite is the reproducible half of the evidence; the
> benchmark harness is the non-reproducible-without-hardware half. §6 is the honest ledger of
> what is and is not established.

## Abstract

Grammar-constrained decoding (masking tokens that cannot extend to a valid program) is widely
deployed and widely misunderstood as a free win. We argue it is governed by two laws. The
**soundness law**: a gate that masks only tokens that cannot extend to a *valid* output can
never score below unconstrained decoding under greedy decode; therefore any measured negative
lift is a bug certificate — the grammar's "valid" is narrower than the scorer's "correct"
somewhere, and the discrepancy can be found mechanically. The **minimal-intervention law**:
the harm of a constraint is graded by the *pre-mask probability mass of the picks it forces*,
not by how often it overrides the argmax; forcing tokens inside the model's own uncertainty
nucleus is indistinguishable from sampling variance, while forcing tail tokens makes the model
condition on text it considers implausible, and the degradation compounds forward
(exposure-bias contamination). Together the laws yield a design discipline — **the constraint
mirrors validity exactly, never style** — and a falsifiable prediction: validity-mirroring
gates on competent models show near-zero tail-forced events, and the benefit of constraining
scales inversely with the model's native ability to produce the format. We implement the
discipline as a substrate-free constrained-decoding kernel over a Scheme tool-call grammar,
instrument the cost model directly (`tailPicks`/`tailMass`), enforce the validity-mirror as an
executable conformance gate against the reader's own corpus, and report that the soundness law,
used as a bug detector, located three real decode defects that had contaminated every earlier
benchmark number we had.

## 1. The problem

A language model emitting a tool call can fail at three independent levels: syntax (unbalanced,
misnested, truncated), reference (calling a tool that does not exist), and semantics (wrong
tool, wrong arguments). Constrained decoding can eliminate the first two *by construction*:
at each step, mask every token that cannot extend the current prefix to some valid, bound
program. The mechanism is standard; llama.cpp GBNF grammars, Outlines, Guidance, XGrammar and
similar systems all implement variants of it.

What is not standard is an account of what the mask *costs*. The naive accounting — "the model
keeps its top choice whenever that choice is valid, so a good model pays nothing" — is wrong in
both directions. It undercounts: a single forced pick can derail everything downstream, because
the model now continues from a prefix it assigned ≈0 probability. And it overcounts: overriding
the argmax between two tokens the model rated 31% vs 29% costs essentially nothing. The
override *count* is the wrong metric. This paper's central claim is that the right metric is
the **probability mass of the forced picks**, and that taking this seriously reorganizes how
constrained decoders should be designed, measured, and debugged.

## 2. The formulation: feasibility, not validity

BPE tokens do not align with grammar tokens — one model token may be `(net` (an opener plus a
partial symbol). So the well-posed per-step question is never "is this token valid?" but
**feasibility of the extended prefix**: does `accepted_prefix + token_string` remain *live*,
i.e. extendable to some complete valid program? (`src/mask-compiler.ts`.)

Three consequences of taking prefix-liveness as the primitive:

- **EOS is a grammar decision.** End-of-sequence is admitted iff the program is *closeable* at
  the cursor. A truncated program is ungeneratable — truncation, one of the most common
  tool-call failure modes in the wild, is deleted as a category.
- **Reference-validity composes with syntax.** The Σ layer consults the binding environment:
  mid-atom at an operator/argument position, the atom fragment must be a prefix of some bound
  symbol. An unbound tool name is ungeneratable, not merely un-executable. Without an
  environment the layer degrades gracefully to structural-only. (`Σ` throughout the code.)
- **The oracle is the reader.** Liveness is answered by the language's own reader-derived
  oracle (`makeOracle`, injected), not by a hand-maintained parallel grammar. This is what
  makes the validity-mirror discipline of §4 *checkable* rather than aspirational.

The kernel is substrate-free (no model, no tokenizer object, no I/O — plain data in, verdicts
out), so every law below is testable deterministically, without a GPU, in the default CI suite.

## 3. The soundness law

**Claim.** Under greedy decoding, a gate that masks only tokens that cannot extend to a
scorer-accepted output can never produce a worse output than unconstrained greedy decoding.

**Proof sketch.** Let P be the token sequence unconstrained greedy decode produces, and
suppose the scorer accepts P. Every prefix of P extends to a scorer-accepted output (namely P
itself), so a gate that masks only non-extendable tokens never masks any token of P. Greedy
decode under the gate therefore reproduces P step by step. ∎

The law is trivial — two lines — and that is precisely its value, because its **contrapositive
is a bug detector**: if a constrained run scores *below* the unconstrained run on any instance,
the gate masked a token inside a correct output, which means the grammar's "valid" is strictly
narrower than the scorer's "correct" at some reachable prefix. Negative lift is never a
"model capability" observation. It is a discrepancy certificate, and the offending step can be
located mechanically from a per-token decode log.

### 3.1 The law as instrument: three bugs it found

Used this way, the law located three real defects in this package's decode loop (the arc is
preserved in test headers and in the harness history; each fix has a model-free regression
test):

1. **Honor-the-stop.** A model that frames calls in a markdown fence terminates by *closing
   the fence*: after a complete program its argmax was the backtick at p≈1.0. The grammar
   masked it (quasiquote is banned in tool calls) and force-fed a p≈0 "new call", looping to
   the token cap — a −39pp instance-level regression vs unconstrained that the law flagged as
   necessarily a bug. Fix: at a *closeable* prefix, if the unmasked argmax is itself
   infeasible (the model wants to leave grammar-space), terminate as if EOS rather than force
   a continuation. (`tests/kernel/honor-the-stop.test.ts`.)
2. **The empty-program guard.** The first fix over-rotated: a model whose *first* token is an
   infeasible framing token (a leading `` `( ``) at the empty — vacuously closeable — prefix
   was terminated at step 0 with empty output. The stop is honored only once a non-empty
   program exists. (Regression pinned in the same test family.)
3. **Backtick tolerance.** The clean generalization: framing backticks are non-semantic
   envelope that the scorer strips anyway. Rather than mask them (off-distribution) or stop on
   them (under-generation), *commit* the token to the model's context but *strip* it from the
   oracle's view — the model stays on its trained rails, the constrained program stays pure.
   (`tests/kernel/backtick-tolerance.test.ts`.)

All three are instances of one lesson: the model carries a trained **envelope** around the
payload, and a sound gate must constrain the payload while leaving the envelope free. The
end-state of that lesson (full envelope pass-through) is *not* implemented — see §6.

A sobering corollary: every benchmark number produced before these fixes was contaminated.
The soundness law is also, therefore, a *measurement-hygiene* instrument: run it per-instance,
and treat any violation as invalidating the batch.

## 4. The minimal-intervention law

**Claim.** The cost of a constraint is graded by the pre-mask probability of each pick it
forces. Formally: a forced pick drawn from within the model's uncertainty nucleus (a token the
model itself rated plausible — e.g. inside top-p) leaves the decode on-policy and is
indistinguishable from sampling variance; a forced pick from the tail (pre-mask p below ~5%,
outside the nucleus) puts the model off-distribution, and the error compounds because every
subsequent step conditions on the implausible prefix.

This is a *mechanistic* claim about exposure bias, not a benchmark observation, and it has a
directly instrumentable signature. The decode loop counts exactly it:
`telemetry.tailPicks` (constrained steps whose committed token had pre-mask probability below
the threshold) and `telemetry.tailMass` (cumulative pre-mask mass of those picks) —
`src/runners/local/strategies/common/types.ts`, threshold documented at the definition.
Force-emitted slots are excluded (they are constraint-determined, not picks). The
per-step transparency record (`src/step-explain.ts`) exposes the same data at full resolution:
every token the model preferred over the committed pick, with its probability and the decisive
veto rule.

Two design rules fall out:

- **Validity, never style.** A validity-mirroring gate on a competent model almost never
  fires — it is a *safety net*, and its tail telemetry reads ≈0. A gate that additionally
  enforces stylistic preferences (canonical literal forms, a preferred bracket, a naming
  convention) fires on *every* fluent valid path — it is a *steering wheel* permanently
  dragging the model off-distribution, and it shows the harm signature (constant tail-forcing)
  precisely on the strongest models. Hence the discipline: **Σ admits exactly what the reader
  reads.** This is enforced as an executable anti-drift gate: the reader's own conformance
  corpus (`foundations/arrival/arrival/spec/corpus/`) is driven through the real admission
  path character by character, asserting reader-accepts ⟺ Σ-admits, with the package's single
  deliberate tightening (quasiquote, a markdown-fence leak in tool calls, handled by §3.1's
  tolerance rather than by masking alone) *pinned by name* so any other divergence fails
  loudly. (`tests/kernel/corpus-conformance.test.ts`.)
- **Report mechanism, not magnitude.** A claimed constraint benefit should be backed by the
  token-level walk — which tokens were tried, which were masked, at what mass — not by an
  aggregate delta that the previous section showed can be dominated by decoder bugs.

### 4.1 The falsifiable prediction

The two laws jointly predict the *shape* of constrained-decoding benefit across models:
**lift ∝ 1 / (native format strength)**. For a model that cannot reliably produce the format,
the gate deletes an entire failure category (syntax/reference errors) at near-zero tail cost —
large positive lift. For a model whose native function-calling is already strong, the gate has
nothing to delete and any residual format friction (the model's trained envelope fighting the
grammar from token 0) is pure cost — lift ≈ 0 or slightly negative. Observed sweeps on local
quantized rosters through the in-repo BFCL harness matched this shape: double-digit
percentage-point gains concentrated on weak-FC models, ties or small losses on strong-FC
models, after (and only after) the §3.1 fixes. To be precise about what a residual small loss
*means*: it is not an exemption from §3 — it is §3's certificate still firing on the one
discrepancy we know remains, the unfinished envelope pass-through (§6.5). A strong model's
trained framing is part of its correct output, so until the envelope is fully freed the
grammar stays narrower than the scorer exactly there. These runs are directional evidence, not
publishable numbers — see §6.

## 5. The artifact

The package demonstrates that the discipline is implementable without heroics:

- **One decision procedure.** `selectConstrainedStep` (`src/select-constrained-step.ts`) is
  the single per-step decision shared by every backend: lazy walk of the model's ranked
  candidates up to the first `keepN` feasible ones, one widening retry, a structural-closer
  fallback that never masks the whole vocabulary, and the EOS-iff-closeable gate. Mask-style
  and pick-style backends read the same result differently (`keepSet` vs `kept[0]`), so the
  reference O(vocab) mask (`compileMask`) and the O(K) production paths cannot diverge —
  equivalence is pinned by parity tests (`tests/kernel/contract-parity.test.ts`,
  `session-parity.test.ts`, `tests/benchmarks/loop-parity.test.ts`).
- **Laziness makes it real-time.** Because greedy-constrained needs only the *first* feasible
  candidate, the oracle is consulted O(K) times per step, not O(vocab); the resumable session
  seam (`OracleSession.clone().advance`) makes each consultation O(candidate-length). The
  constraint's runtime cost is a bounded number of string-liveness queries per emitted token.
- **Transparency is a first-class output.** Every step can emit the explain record (§4) —
  what the model wanted, what the constraint vetoed and under which named rule, at what mass.
  The rule catalog (`src/rules.ts`) gives each tightening an identity, which is what makes
  "every departure from reader-validity is enumerated and justified" auditable at decode time
  rather than only in code review.
- **Everything above is model-free.** The default test suite (grammar gates, Σ gates, profile
  gates, parity, corpus conformance, the §3.1 regressions over a scripted backend) runs
  deterministically in CI with no GPU, no weights, no network. The GGUF/Metal wiring and the
  OpenAI-compatible server exist so the same kernel can be driven by real harnesses (BFCL et
  al.), but no law stated here depends on them.

## 6. Honest limitations — what this package does *not* establish

1. **One grammar, one domain.** Everything is demonstrated over the arrival Scheme tool-call
   grammar. The laws are stated generally and the proof of §3 is grammar-agnostic, but the
   *engineering* claims (validity-mirror is enforceable; tail telemetry reads ≈0 on competent
   models) are only evidenced here. No JSON-schema, SQL, or code-generation instantiation
   exists in this package.
2. **Greedy-dominant evidence.** The soundness law is a theorem for greedy decode only. A
   temperature-sampling path exists (`src/sampling.ts` — sampling restricted to the feasible
   set, built for measurement-noise studies), but no analogous guarantee is claimed or proven
   for sampled decoding.
3. **The benchmark numbers are directional, not archival.** Sweeps were run on local,
   *quantized* GGUF models on one machine through `scripts/` (BFCL official + reference
   harnesses); result directories are deliberately pruned from the repo. Quantization
   demonstrably perturbs rankings (`tests/research/findings/quant-ranking-findings.md`), the
   rosters are small, and §3.1 shows how easily such numbers are contaminated by decoder
   defects. The reproducible claims of this package are the *laws and their executable tests*,
   not any specific percentage.
4. **The tail threshold is a heuristic.** The ~5% nucleus boundary in the telemetry is
   defensible but not derived; the mechanistic claim (compounding off-policy degradation) is
   supported by the literature on exposure bias and by our decode logs, not by a controlled
   ablation in this repo.
5. **Envelope pass-through is unfinished.** Honor-the-stop and backtick tolerance are point
   fixes for the two envelope collisions we hit. The architecture they point at — constrain
   the payload, leave the model's entire trained framing free — is the roadmap
   (`docs/package-specific/arrival-sampler/sampler-roadmap-dag.md`), not the implementation.
6. **Σ needs an environment to bite.** The reference-validity layer is only as strong as the
   grant environment injected; structural-only operation (no env) deletes syntax errors but
   not phantom tools.

## 7. Relation to existing work (sketch)

Token-level grammar masking is established practice (llama.cpp GBNF, Outlines, Guidance,
XGrammar, SynCode and kin), and the observation that constrained decoding can *hurt* has been
made empirically in the literature comparing constrained vs unconstrained accuracy. What we
believe is under-articulated, and what this package packages as one discipline: (a) the
soundness law's contrapositive as a *mechanical bug-finding procedure* for decoder/grammar
mismatches, rather than a shrug about "alignment tax"; (b) probability-mass-of-forced-picks as
the *cost model*, with the telemetry built into the decoder; (c) the validity-mirror kept
honest by an *executable conformance gate against the language's own reader corpus*, with
named, enumerated departures; and (d) reference-validity (Σ, binding-environment liveness) as
a peer of syntax in the same mask. A proper related-work treatment with citations is future
work for the written-up version of this paper.

## 8. Conclusion

Constrained decoding is not a knob but a contract. State the contract as validity (never
style), and it comes with a theorem: you cannot lose under greedy decode — so when you do
lose, you have found a bug, and the per-token log will show you where. Price every
intervention in the model's own currency — pre-mask probability mass — and the telemetry will
tell you whether your constraint is a safety net or a steering wheel. This package is one
complete, tested instantiation of that contract, kept deliberately small so the argument stays
inspectable end to end.

---

*Package: `@inhuman.tools/arrival-sampler` (`foundations/arrival/arrival-sampler`). The kernel
tests under `tests/kernel/` are the normative statement of every claim marked "pinned" or
"enforced" above; where this document and a green test disagree, the test wins.*
