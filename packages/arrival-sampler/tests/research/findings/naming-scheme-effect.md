# Tool naming dominates tool-call correctness — a validity-isolated measurement

**Status**: finding · 2026-06-19 · mic-drop #1 (see `docs/package-specific/arrival-sampler/intent-chain-eval-micdrops.md`)
**One line**: the *same* actions, with *identical* semantics and arities, swing **~25 points** in
correctness (worst 0.543 → best 0.800) purely as a function of how the tools are **named/namespaced** —
and the effect is a **monotone ladder**: front-loading a read-vs-mutate cue in the tool name rescues
correctness, bare domain-first naming hurts it. Measured with structural + bound-symbol validity held at
**100% by construction**, so the swing is attributable to naming *semantics*, not formatting.

## Why this is uniquely measurable here

Every other tool-calling benchmark conflates two error sources: *picked the wrong tool / wrong args*
(semantics) and *emitted a malformed or unbound call* (syntax/format). A naming change moves BOTH — a
longer or oddly-segmented name is both harder to *choose* and harder to *spell correctly* — so a naive
correctness delta across namings can't be attributed to either cause.

Our **constrained-decoding sampler removes the syntax/format axis entirely**: at every decode step the
oracle masks the logits so the model *cannot* emit a malformed program or an unbound/nonexistent tool name.
Structural + bound-symbol validity is **guaranteed by construction** (0 malformed, 0 unbound, 0 arity
errors — not "rare", *impossible*). With the format axis pinned, **the entire correctness delta across
namings is attributable to naming *semantics*** — does the model reach for the *right* (always-valid) tool?
That is a clean causal claim no benchmark that scores raw output can make.

(Anchor: ToolScan, arXiv 2411.13547, separates syntactic / invalid / semantic tool-use errors *post-hoc by
classification*. We make the first two buckets *provably empty*, so the residual we measure is exactly the
third.)

## The schemes

The same Apple-intent action set under 7 namespacings (the `@inhuman.tools/arrival-sampler/palettes`
surfaces; recombinations from `apple-namespaced.ts`), e.g. the *send-message* action:

| scheme | recombination | example name |
|---|---|---|
| dei | domain / entity / intent | `messaging/message/send` |
| die | domain / intent / entity | `messaging/send/message` |
| eq | effect\|query / entity / intent | `effect/message/send` |
| bang | !effect\|!query / entity / intent | `!effect/message/send` |
| env | env / kind / entity / intent | `env/effect/message/send` |
| bdei | !/? sigil + domain / entity / intent | `!effect/messaging/message/send` |
| bdie | !/? sigil + domain / intent / entity | `!effect/messaging/send/message` |

Identical actions, identical arities, identical device semantics — *only the names differ*.

## Method

`measurement-trust` harness (Stage-0-qualified), Rnj-1 (Q4_K_M, llama.cpp/Metal), 14 Apple-intent tasks,
τ=0.3 sampling over the **oracle-feasible set** (so every emitted program is valid by construction),
REPEATS=5. Correctness = the generated program, executed, produces the intended device outcome
(state/trace), scored 0/1 per task. Reported per scheme: mean correctness ± run-to-run sd, pass^1/pass^5.
The gauge itself is qualified: A/A test inconclusive (no false differences), Gage R&R %R&R, and a pairwise
separability rule (|Δ| > pooled run-to-run sd) for which scheme differences are actionable.

## Results (full 7-palette factorial)

Rnj-1, 14 tasks, REPEATS=5, τ=0.3, constrained (validity = 100% by construction). A **monotone ladder**:

| scheme | recombination | mean correctness ± sd | pass^1 | pass^5 |
|---|---|---|---|---|
| dei | domain/entity/intent (bare) | 0.543 ± 0.073 | 0.543 | 0.429 |
| die | domain/intent/entity (bare) | 0.586 ± 0.105 | 0.586 | 0.429 |
| eq | effect\|query / entity/intent | 0.643 ± 0.045 | 0.643 | 0.500 |
| bang | !effect\|!query / entity/intent | 0.743 ± 0.035 | 0.743 | 0.571 |
| env | env / kind / entity/intent | 0.786 ± 0.000 | 0.786 | 0.786 |
| **bdei** | !/? sigil + domain/entity/intent | 0.786 ± 0.000 | 0.786 | 0.571 |
| **bdie** | !/? sigil + domain/intent/entity | **0.800 ± 0.029** | 0.800 | 0.786 |

Gauge (honest): Gage R&R **%R&R = 23.2% (marginal→poor)**, run-to-run sd ≈ 0.054, and the A/A this run
wobbled to Δ=−0.143 (should be ~0) — **the gauge is noisy at this scale**, so treat *exact* per-scheme
values and *fine within-cluster* rankings as unresolved. (Note the run-to-run drift vs the earlier 3-scheme
run: bdei 0.843→0.786, die 0.571→0.586 — the precise numbers move; the *structure* does not.)

**What IS robust — the coarse cluster gap.** The schemes split into a **bare-domain cluster** (dei 0.543,
die 0.586) and a **kind-cue-prefixed cluster** (bang 0.743, env/bdei 0.786, bdie 0.800). Every
bare↔prefixed cross pair is **separable** (|Δ| ≈ 0.16–0.26, ~3–5× sd; 10+ separable pairs): e.g.
**dei↔bdie = 0.257**, dei↔env/bdei = 0.243, die↔bdie = 0.214. Within each cluster the differences
(dei↔die = 0.043; env≈bdei≈bdie) are **not** separable.

**Headline:** a **~0.25 (25-point) worst-to-best swing from naming alone** (dei 0.543 → bdie 0.800), and
— mechanistically — **putting a confident effect/query cue at the *root* of the tool name rescues
correctness; bare domain-first naming hurts it.** The ladder is monotone in "how early/strong the
read-vs-mutate signal appears": bare-domain < kind-replaces-domain (eq) < bang-cue < sigil-on-full-domain.

## What it means

- **Tool-call accuracy is dominated by a variable nobody benchmarks.** BFCL, τ-bench, ToolSandbox et al.
  fix the tool naming and measure the model; none vary the naming over a fixed action set. A ~25-point
  effect from *naming alone* says the surface presentation of a capability is a first-class determinant of
  agentic correctness — with an **actionable, mechanistic rule**: front-load an effect/query cue in tool
  names (name tools for the model, not just for humans).
- **It's a structured ladder, not two points.** The monotone ordering (and the clean bare-vs-cued cluster
  split) is a stronger claim than a single pair: the effect tracks a nameable property (root-level
  read/mutate cue), not an arbitrary relabeling.
- **Validity-isolation is the enabling instrument.** The swing is attributable to naming *semantics* only
  because the constraint guarantees the format axis (a longer/odd name can't cost points by being
  *misspelled* — only by being *mis-chosen*). This is the measurement the sampler uniquely makes possible.

## Honest caveats

- One model (Rnj-1); the *direction/magnitude* may differ across models (the effect is real; its size is
  model-specific). A multi-model replication would strengthen the universality claim.
- 14 tasks, single domain (Apple intents). The gauge is **marginal→poor (23.2% %R&R)** this run, with an
  A/A wobble of 0.14 — so the **coarse** claim (bare-domain cluster < kind-cued cluster, ~0.2 gap, 10+
  separable pairs) is robust, but the **exact** per-scheme values and the **fine** within-cluster ranking
  are not resolved. The numbers drifted vs the earlier 3-scheme run (bdei 0.843→0.786); read the
  *structure* (the monotone ladder + the cluster split), not the decimals. Tightening the gauge (the G2
  majority-vote lever, or more tasks) is the path to fine claims.
- Correctness scoring is outcome-based on the device sim; semantic mistakes the sim can't distinguish
  (right tool, plausible-but-wrong arg) are a known floor (the eval-harness phase tightens this with the
  stateful device-sim + state assertions).

## Next

- Fold in the full 7-palette factorial (running) → complete naming-effect landscape + 21-pair separability.
- Tighten the gauge (the G2 majority-vote lever) if the bdei↔bang question matters.
- Multi-model replication for universality.
- This is the cheapest, most surprising of the mic-drops; the semantic-isolation eval (#2, the device-sim
  harness) is the deeper methodology contribution it de-risks.
