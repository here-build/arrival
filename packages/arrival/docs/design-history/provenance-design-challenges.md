# Provenance design — adversarial panel verdicts

*Three-model challenge (grok-4.5, grok-composer-2.5-fast, longcat via local `grok -p`,
2026-07-09) against the design quartet + P-track plan. Rule applied: attacks landed
independently by ≥2 models = confirmed design debt; singletons verified against the
codebase before acceptance. This doc records what changed and why; the P-track revision
in REWORK-DAG.md implements it.*

## Confirmed (≥2 models) — accepted, design amended

**C1 — Interior nondeterminism breaks R1 (all three).** gensym / rosetta-source / clock
inside a callback or collapsed segment: replay that re-invokes sources is a different
run. AMENDMENT: (a) **retrospective mint records carry PAYLOADS** (the minted value, not
just "a mint occurred") and are AUTHORITATIVE for replay — replay never re-invokes a
source; (b) gensym classifies as a mint (its identity is a payload); (c) R1 restated:
*replay from frozen port payloads is stable* — re-execution stability is neither claimed
nor needed. NEW LAW FAMILY (all three independently demanded it):
`provenance/replay-nondeterminism.law` — generated programs with interior
gensym/source/clock; replay from frozen payloads with the external world deliberately
mutated between runs; divergence = red.

**C2 — Dynamic instance count dominates; loops/fans reintroduce the 186MB asymptotics
(all three; longcat's strongest objection).** Port records are Θ(elements) per fan,
Θ(iterations) per TCO loop — "O(ports)" is O(dynamic behavior). AMENDMENT: **P8b
aggregation node added** (run-length/ring encoding for stable-wiring repeated ports —
a loop crossing the same port T times with the same wiring stores O(1) + count; fan
records store per-element payloads ONLY at mint/decision ports, ordinals elsewhere).
**R3 promoted from benchmark to HARD GATE at P10** (longcat: demoting the motivating
problem to a benchmark is a category error — correct).

**C3 — I1 overclaims (composer + grok).** It is a *value-egress provenance-id
confinement* lemma, not world/behavioral noninterference: an effect track's sink events
happen; an effectful comparator's log is real. AMENDMENT: I1 prose restated in
callback-track-graphs to the honest claim; the sealing/full cone of a value captured by
an effect track MUST include the region port (grok's secret/log example — adjusting the
capture changes observations; under-reporting forbidden).

**C4 — Widening vs Galois adjunction contradiction on loops (grok; composer adjacent).**
V4's widening yields over-approximate (not least) cones — W2's "minimal = least" is
false for every loop node. AMENDMENT: W2's adjunction claim SCOPES to loop-free segments;
loops get either retrospective unroll records (backedge/iteration/exit-arm — new port
kinds, deferred until demanded) or documented over-approximation. `loop-unroll.law`
staged as it.todo.

**C5 — Sort's comparator schedule is data-dependent (composer + grok).** Parallel
selector tracks are a false model: later comparisons depend on earlier results.
AMENDMENT: selector hosts with data-dependent invocation order gain a **host-schedule
record** (the comparison sequence) in the retrospective stream; without it, drill-in on
a sort is honestly marked non-replayable-in-order.

**C6 — Stamp-containment ≠ replay-containment (composer + grok).** Track-cone laws
verified against the eager oracle can green while replay is broken. AMENDMENT: suite
split — stamp-containment gates P8; replay-containment gates P9; **P11 drill-in gates on
P9** (a progress UI shipping on P8 alone gets counters, explicitly no click-through).

**C7 — Plan bug: P7 must depend on P4 (grok).** Wireframe fan templates need
contract-derived callback roles. FIXED in the node table.

**C8 — Drift alarm cannot see JS bodies; roles are semantic (all three).** A JS body
that maps while declared `pipe` is consistent-but-wrong; selector-vs-decision and
polymorphic callback returns are not decidable from shape. ACCEPTED AS LIMIT: the
declaration override is a fallible human/agent assertion; the mitigation is W1 agreement
(eager oracle catches wrong roles on exercised programs) + the F2 corpus gaining
HOF/source/macro program classes (C10). Drift alarm scope stated honestly: catches
contradictions, not lies.

**C9 — Async egress rule missing (composer + longcat).** A callback returning a promise
must NOT satisfy I4 as "completed." AMENDMENT: promise egress keeps the track PENDING
until settled (B3's pending counter already counts re-entries — extend to unsettled
egress); region close with unsettled egress throws the incomplete door. Port stream
ordering under async: records are appended at settlement in settlement order —
**the stream's total order is emission order, and T7's laws quantify over emission
orders**, not a fictional program order (composer's n!-permutation worry dissolves:
the fold is order-insensitive by construction for counters; anything order-sensitive
must cite the schedule record from C5).

**C10 — F2 corpus is too pure to find any of this (all three, implicitly).**
AMENDMENT: the generator gains program classes: interior sources, nested regions
(map-in-map, map-in-fold), first-class HOFs, structured multi-field egress, macro-
expanded bodies (post-P6), deep mux nesting.

**C11 — Vocabulary redundancy (grok + longcat).** loop duplicates the wireframe's
binder{cycles}; transparent/sink are derivable graph-shape facts; selector+decision
could start as one control role; vocabulary-v2 kinds vs wireframe node kinds are two
vocabularies for one graph. AMENDMENT: **one unified vocabulary** — vocabulary-v2's
kinds are the DECLARATION layer, the wireframe's node kinds are the GRAPH layer, and
the mapping is stated 1:1 where it exists (sink/transparent = declaration-layer facts
that LOWER to graph shapes; loop lowers to binder{cycles}). Deferred: splitting
selector/decision cone colors until a product query needs the second (both models'
advice; the open question in vocabulary-v2 §4 closes as "one color first").

**C12 — Eager-as-oracle = permanent second interpreter? (composer + grok).** DECIDED:
oracle is TEST-ONLY (F2/agreement corpus, sampled), never production dual-run; P10's
"demoted to oracle" means the eager stamp path survives as a test-mode flag, deleted
from production builds' hot path. The alternative (dual-run forever) is exactly the
fragmentation P0 exists to prevent.

## Refuted (verified against implementation)

- **call/cc region re-entry (longcat)**: arrival does not implement
  call/cc/dynamic-wind — deliberate sandbox decision, chibi registry rows exclude the
  family. NOW STATED as load-bearing for I1/I4 in callback-track-graphs: continuations
  are the classical region-escape channel and their absence is a design invariant, not
  an accident. Any future continuation work re-opens this panel finding first.
- **vector-set!/string-set! shared-state channels (longcat)**: the whole mutator family
  is teaching-doored ("every value is frozen by design — mutating would falsify the
  provenance lineage"). Immutability is total, not set!-only. Also now stated.
- **A13 interim orphan (grok)**: already landed (c27b2e8b62), stale.

## Accepted as known limits (documented, not fixed)

- **Structured egress field-routing (grok)**: one egress value with multiple interior
  cones — port records store the host-level stamp set; field-demand at a region boundary
  answers by replay, not by records. Honest cost of I5's O(1) exterior collapse; region
  field-ports deferred until a workload demands them.
- **Sealed-value retention (longcat)**: replay requires retained ingress values —
  long-running sessions grow O(values crossed). Mitigation path (not built): segment
  eviction downgrades drill-in from replay to recorded-only. `memory-retention`
  measurement rides R3's gate.
- **Segment granularity is phrasing-sensitive (longcat)**: `(+ (src-a) (src-b))` vs
  `(if f (src-a) (src-b))` collapse differently — true of every PDG; noted as UX fact.
- **P9/W2 verification circularity (longcat)**: dissolved by C12 — W2 verifies replay
  against recorded eager-oracle runs, not against the stream that replay itself feeds.

---

# Rounds 2–3 (deployment-target critique, 2026-07-09)

*Second and third critique rounds ran against the FUSED spec
([`PROVENANCE.md`](../PROVENANCE.md)) under its normative deployment
target: full provenance for ~1000-SLOC programs inside one Cloudflare Durable Object
(128MB, CPU caps, eviction mid-run, DO storage limits). Round 2 = fresh attack on the
fusion; round 3 = narrow self-review of round 2's own amendments. Every finding below
names where it landed in the spec — the citation trail for "round 2, X" / "round 3, Y"
markers in PROVENANCE.md resolves here.*

## Round 2 — findings and dispositions

| # | Severity | Finding | Resolution → spec location |
|---|---|---|---|
| A1 | BLOCKER | R1 (frozen-payload replay) rested on an unbuilt retention LIMIT; retained payloads are what actually break 128MB first | CHOSEN payload tiering: ring → DO storage → R2 → hash-only stub; per-tier deterministic never-silent degradation → §5 tiering row; motivation preserved in Appendix A.1 |
| A2 | MAJOR | Every mux recorded, but pure-selector decisions are derivable by γ — 10⁴–10⁵ noise records per loop-heavy program; pure conditionals needlessly fragment segments | CHOSEN: pure-selector muxes collapse INTO wires; only port-coupled muxes carry records → §1 designated-nodes row; soundness = pure-mux-derivation law (§7) |
| A3 | MAJOR | Hermetic env unspecified for program defines; helper captures leak closures/natives into payloads | CHOSEN: program prelude third static layer; captures resolving to prelude/native names are references → §1 prelude row (narrowed by round 3 M1) |
| A4 | MAJOR | Replay-is-a-track circularity left "does γ emit records?" undefined (observer effect + write cost) | CHOSEN: γ runs in a SILENT region, emission off, ephemeral trace → §4 |
| A5 | MINOR | "One cone color" vs surviving fact-wires wording | Clarification: fact wires = tagged value wires; one traversal color → §2 |
| A6 | MAJOR | Aggregation applicability unstated; cheapness story quietly assumed pure loop bodies (mint payloads never aggregate) | CHOSEN per-kind aggregation table → §5 |
| B | (arithmetic) | Budget: retained payloads break first; drill-in on big segments 1–10s CPU; replay memo dropped by the fusion | Appendix A (split A.1/A.2 by round 3 M2); CHOSEN replay memo → §4 |
| C1 | BLOCKER | Hibernation/eviction mid-region: scope tokens are in-memory; DO WILL evict mid-await | CHOSEN: production regions are event-sourced; T7's fold IS the recovery mechanism → §5 |
| C2 | MAJOR | Multi-request programs + CF retries vs "exactly once" | CHOSEN: deterministic record ids (template hash, ordinal PATH, region epoch), idempotent upsert; W3 = exactly-once per id → §5, §7 |
| C3 | MAJOR | Flush policy absent (crash window vs write amplification) | CHOSEN: flush at ports + size/time backstop + pre-hibernation hook → §5 (barrier semantics added by round 3 m5) |
| C4 | MINOR | Template store locality (per-DO duplication) | CHOSEN: shared immutable cross-DO store; program version = wireframe hash → §5 |
| C5 | MINOR (opportunity) | γ serializable ⇒ offloadable to stateless Workers — unclaimed CPU relief | CHOSEN → §4 (epoch-carry clause added by round 3) |
| C6 | MAJOR | Interpreter drift: DO storage outlives deploys; cross-version replay can lie | CHOSEN: semantics-epoch pinning in stream header → §4 |
| D1 | MAJOR | Instance ordinals flat vs nested collision (round-1 leftover) | CHOSEN: ordinal PATHS → §5 record identity |
| D2 | MAJOR | Payload with or without stamp ids | CHOSEN: value + stamp ids, round-tripped → §5 |
| D3 | MINOR | Wire hash: spans stripped vs kept | CHOSEN: two named hashes (template-hash / site-hash) → §5 |
| D4 | MINOR | Emission-order key undefined | CHOSEN: per-region monotonic seq + region epoch; global sequence EXCLUDED → §5 |
| D5 | MINOR | Host-schedule record shape | CHOSEN: (left-ordinal, right-ordinal, verdict) triples — verdicts inline = replay-free reconstruction → §5 |
| D6 | MINOR | Top-level program-order owner | CHOSEN: root binder chain, prospective-only → §1 |
| E1 | MINOR | Live plane implies real-time; it is flush-coupled | LIMIT → §6 |
| E2 | MINOR | Persisted payloads persist secrets | LIMIT (privacy surface, product review) → §5 |

## Round 3 — findings against round 2's own amendments

| # | Severity | Finding | Resolution → spec location |
|---|---|---|---|
| M1 | MAJOR | Prelude admitted port-reaching defines — name indirection re-opened the R1 hole A1 closed (γ would re-invoke a fetch inside a "pure" helper) | Prelude membership PURE-ONLY, classifier-checked; port-reaching defines are wireframe material; third EXCLUDED row → §1 prelude row |
| M2 | MAJOR | Appendix A still showed the PRE-tiering break order beside the tiering row that invalidates it — the R3 gate enforced stale numbers | Appendix split: A.1 motivation (pre-tiering) / A.2 enforced budget (in-memory vs storage columns, ≥3× headroom stated, new break order: DO write volume → R2 settle latency → ring misconfiguration → drill-in CPU) |
| m1 | MINOR | Silent-γ region textually violated the event-sourced EXCLUDED clause | Exemption scoped: production regions event-sourced; silent regions = pure queries → §4 + §5 |
| m2 | MINOR | Memo cached WHAT? (egress vs step-walks); memo outliving evicted payload | Memo scope = egress/cone; step-walks stream lazily; `replayed-cached` tier → §4 memo row |
| m3 | MINOR | Pure-mux collapse trades backward-cone precision silently | Trade stated + γ mitigation, "the trade IS the ruling" → §1 A2 row |
| m4 | MINOR | RLE runs must be path-scoped (inner ordinals restart per outer element) | (parent ordinal-path, start, count) → §5 aggregation table |
| m5 | MINOR | DO storage write failure mid-flush | Port completion barriers on durable write (DO output gates); failed write kills request, idempotent retry → §5 flush row |
| m6 | MINOR | R2 latency/failure inside CPU-capped request | pending → R2-ref settlement by upsert; async I/O; failure degrades to stub → §5 tiering row |
| m7 | MINOR | pure-mux-derivation law lacked ground truth | Eager oracle's recorded arm choices named → §7 |
| m8 | MINOR | tier-honesty law lacked the answer envelope | Enum `replayed \| replayed-cached \| recorded \| stub` named → §5, §7 |
| — | (clause) | γ-offload vs epoch pinning needed the carrier stated | Drill-in request carries stream epoch; worker refuses mismatch → §4 |

**Round-3 checks that PASSED** (attacked, held): flush-at-ports vs pure-mux collapse
(muxes aren't flush points; ring backstop covers long pure stretches); template-hash vs
epochs (expressions are data, the interpreter is what's pinned); no regressions against
round-1 adjudications (sampled verification ≠ dual-run; D5 shape consistent with C5).

**Post-round-3 coherence read**: one mechanical fix (preamble round citation); three
nits closed in a follow-up pass (R1↔tier-availability cross-reference, pure-bodied-loop
prose, and this appendix as the durable citation trail).

**Stability declaration (round 3)**: no new design flaws — only defects in round 2's own
patch; all resolved. The reference workload fits the deployment target with ≥3× stated
in-memory headroom. Round 4 unwarranted.
