# Provenance design — challenges and resolutions

*The objections the provenance system must answer, each stated as the problem and why the
resolution holds. The normative rulings live in [`PROVENANCE.md`](../PROVENANCE.md); this
file preserves the objections themselves — including the ones that fail ONLY because of a
language invariant, so any change to that invariant re-opens the corresponding objection.*

## Challenges resolved into the design

**Interior nondeterminism vs replay stability.** gensym, a rosetta source, or a clock
inside a callback or collapsed segment makes any replay that re-invokes sources a
different run — so replay stability cannot rest on recomputation. Retrospective mint
records carry PAYLOADS and are authoritative (gensym is a mint, its identity a payload);
the claim is therefore *replay from frozen port payloads is stable*, re-execution
stability neither claimed nor needed. Guard: `replay-nondeterminism`
([`PROVENANCE.md`](../PROVENANCE.md) §4, §7).

**Dynamic instance count dominates.** Port records are Θ(elements) per fan and
Θ(iterations) per TCO loop — "O(ports)" is really O(dynamic behavior), which reintroduces
the per-reduction blowup the design exists to kill. Answered by ordinal-path-scoped
RLE/ring aggregation (a loop crossing one port T times with stable wiring stores
O(1)+count) with per-element payloads only at mint/decision ports. The memory budget is a
HARD GATE, not a benchmark — demoting the motivating problem to a benchmark is a category
error ([`PROVENANCE.md`](../PROVENANCE.md) §4, Appendix A).

**Honest scope of the isolation lemma.** Track isolation is a *value-egress
provenance-id confinement* lemma, NOT world/behavioral noninterference: an effect track's
sink events happen, an effectful comparator's log is real. The sealing/full cone of a
value captured by an effect track must therefore include the region port — a secret whose
capture changes observations may not be under-reported (I1, [`PROVENANCE.md`](../PROVENANCE.md) §3).

**Widening vs the Galois adjunction on loops.** Widening yields over-approximate (not
least) cones, so a "minimal = least" adjunction claim is false at every loop node. The
adjunction scopes to loop-free segments; loops carry the widened cone plus exact
reconstruction via aggregation counts (`loop-unroll` staged,
[`PROVENANCE.md`](../PROVENANCE.md) §7).

**Data-dependent comparator schedules.** Modeling a sort's comparator invocations as
parallel selector tracks is false — later comparisons depend on earlier results. Selector
hosts with data-dependent order emit a host-schedule record; absent it, drill-in on a sort
is honestly marked non-replayable-in-order ([`PROVENANCE.md`](../PROVENANCE.md) §4).

**Stamp-containment ≠ replay-containment.** Cone laws verified only against the eager stamp
oracle can stay green while replay is broken — two distinct properties. The containment
suite is split (stamp-level and replay-level laws); drill-in UI gates on the replay-level
suite, and a progress surface shipping on stamp-containment alone gets counters, explicitly
no click-through ([`PROVENANCE.md`](../PROVENANCE.md) §7).

**Role declarations are fallible.** A JS body that maps while declared `pipe` is
consistent-but-wrong; selector-vs-decision and polymorphic callback returns are not
decidable from shape, so no drift alarm can see through a JS body. Accepted as a limit:
the mitigation is the eager-oracle agreement law over a deliberately impure generator
corpus. The drift alarm catches contradictions, not lies
([`PROVENANCE.md`](../PROVENANCE.md) §7).

**Async egress.** A callback returning a promise must not satisfy egress-completion as
"completed": promise egress keeps its track PENDING until settled; region close with
unsettled egress throws the incomplete door. Under async, port records are appended at
settlement, in settlement order — the stream's total order IS emission order and the stream
laws quantify over emission orders, not a fictional program order. The permutation worry
dissolves: the fold is order-insensitive for counters, and anything order-sensitive must
cite the host-schedule record ([`PROVENANCE.md`](../PROVENANCE.md) §3–4).

**One vocabulary, two layers.** Declaration kinds and wireframe node kinds were two
vocabularies for one graph, several kinds derivable (`sink`/`transparent` are graph-shape
facts; `loop` duplicates the binder-with-cycles node). One unified vocabulary: declaration
kinds are the DECLARATION layer, wireframe node kinds the GRAPH layer, mapped 1:1 where the
mapping exists; one control role and ONE cone color until a product query needs a second
([`PROVENANCE.md`](../PROVENANCE.md) §2).

**No permanent second interpreter.** Keeping the eager stamp path as a production dual of
the wireframe would be exactly the two-diverging-interpreters fragmentation P0 exists to
prevent. The eager path is a TEST-ONLY oracle deleted from production hot paths — which
also dissolves the apparent verification circularity between replay and its own stream:
replay is verified against recorded oracle runs, not against the stream it feeds
([`PROVENANCE.md`](../PROVENANCE.md) §4).

## Deployment-target challenges

The deployment target — full provenance for a ~1000-SLOC program inside one 128MB Durable
Object with CPU caps and mid-run eviction — raises its own family, each resolved normatively
in [`PROVENANCE.md`](../PROVENANCE.md) §4 and Appendix A. The objections, one line each:

- **Retained payloads break 128MB first**, not record count (they are the pinned live set
  of crossed values, a floor independent of aggregation).
- **Pure-selector muxes are derivable noise** — 10⁴–10⁵ records in loop-heavy programs for
  decisions γ rederives from frozen ingress.
- **Helper captures leak closures into payloads** — a port-reaching define referenced by
  name would smuggle a source past the frozen-payload rule.
- **Replay observing itself** — recording a drill-in into the production stream pollutes the
  provenance it inspects.
- **Eviction mid-region** — a DO WILL evict mid-await; scope tokens cannot live only in
  memory.
- **Retries vs exactly-once** — CF request retries and multi-request programs re-emit; flat
  ordinals collide under nesting.
- **Crash window vs write amplification** — durability and meaning boundaries must coincide
  or every await pays a DO write.
- **Interpreter drift across deploys** — persisted streams outlive the code that wrote them;
  a newer evaluator can lie politely.
- **Persisted payloads persist secrets** (API responses, user data) — accepted LIMIT, a
  privacy/retention surface for product review.

## Objections that fail only because of language invariants

These objections are refuted by design invariants, not by machinery — which is what makes
the invariants load-bearing. Any future work relaxing them re-opens the objection, so it is
recorded here rather than only in the resolved list above:

- **Region escape via continuations.** call/cc and dynamic-wind are the classical
  region-escape channel: a captured continuation re-enters a closed region and falsifies
  egress-completion. Arrival deliberately implements neither — the sandbox excludes the
  family — so the objection has no purchase. Any continuation work starts by answering it.
- **Shared-state channels via mutation.** vector-set!/string-set!-style mutators are the
  classical isolation-escape channel. The entire mutator family is teaching-doored ("every
  value is frozen by design — mutating would falsify the provenance lineage"); immutability
  is total, not set!-only.

## Accepted limits

- **Structured egress field-routing**: one egress value can carry multiple interior cones,
  but port records store the host-level stamp set; field-demand at a region boundary answers
  by replay, not by records. The honest cost of the O(1) exterior collapse; region
  field-ports deferred until a workload demands them ([`PROVENANCE.md`](../PROVENANCE.md) §3 I5).
- **Segment granularity is phrasing-sensitive**: `(+ (src-a) (src-b))` and
  `(if f (src-a) (src-b))` collapse differently — true of every program-dependence graph; a
  UX fact, not a soundness hole ([`PROVENANCE.md`](../PROVENANCE.md) §1).
