# Callback tracks — isolated provenance graphs, formally

*Builds on the region discipline (`../../src/values/primitives/region-scope.ts`),
[provenance-vocabulary-v2.md](provenance-vocabulary-v2.md) (roles, callback wiring), and
[execution-plan-wireframe.md](execution-plan-wireframe.md) (segment collapse, port records,
replay). Normative invariants live in [PROVENANCE.md](../PROVENANCE.md) §3; this note keeps
the argument. The claim: a callback crossing into a host verb is not part of the main
provenance graph — it is an isolated TRACK, and the isolation is **by construction, not
bookkeeping**.*

## The model

**Main graph** `G` — the program's wireframe + its runtime port records. A **region** `R`
(scope token `{open, pending, signal}`) is opened by a host-verb invocation that exports
callables, and owns an ordered sequence of **tracks** `T₁ … Tₙ`, one per callback
invocation. Each track is an isolated provenance graph with three surfaces: INGRESS
(callback args + closure captures, every edge a SEALED value — the main program relates to
a track exactly as a completed preamble), INTERIOR (the callback body's own
purity-collapsed wireframe, replayed on demand, never stored step-by-step), and EGRESS (at
most one value, delivered to the HOST PORT, never to `G` directly).

The host's declared role composes the tracks — this table is the design evidence behind
PROVENANCE §3's normative composition rule:

| Host role | Track composition | Egress meaning |
|---|---|---|
| element-transformer (map) | **parallel** — zero inter-track edges | element *i*'s lineage |
| selector (sort comparator) | parallel | ORDER structural fact only (PROXIED plane) |
| decision (filter pred) | parallel | membership/length (PROVENANCED plane) |
| accumulator (fold/reduce) | **chained** — `egress(Tᵢ) → ingress(Tᵢ₊₁)` acc slot, the ONLY sanctioned inter-track edge | the running value |
| effect (for-each) | **terminal** — no egress | the track is a sink; its cone dies at the region boundary |

## Why the isolation holds by construction

The confinement theorem (PROVENANCE §3 I1) is **value-egress provenance confinement**:
no provenance-id flows from a track interior into `G` except through the egress wire. It is
NOT behavioral noninterference — an effect track's sink events happen and are real, so the
sealing cone of any value CAPTURED by an effect track must include the region port
(adjusting a capture changes observations; under-reporting that is forbidden).

What makes confinement structural rather than audited: **total immutability** (the whole
mutator family — set!, vector-set!, string-set! — is teaching-doored) and **no
call/cc/dynamic-wind** (deliberately unimplemented; continuations are the classical
region-escape channel) are LOAD-BEARING here, plus the region doors that kill every
historical escape (returned closures, retained wrappers, post-completion calls, unsettled
promise egress). Take either invariant away and the escape channel reopens.

Consequences that follow (normative statements in PROVENANCE §3): a track's reachable world
is its sealed ingress, so replay is stable and spontaneous `Tᵢ → Tⱼ` flow is impossible;
order is a structural fact of the host port, not a dataflow edge; at region close
started = completed (the throwing completion door — an incomplete track is a dangling
subgraph the door forbids from existing); from `G` the whole region is ONE node
(segment-collapse one level up); opaque symbols are the only inter-world identity carriers
(identity crosses, cones do not — a bridge is provenance-inert by type).

## Live materialization: the track set IS the progress model

No separate instrumentation — region = the task, track = the unit of work,
`{started, completed}` counters ARE the port-record stream. Progress UI is a **pure fold**
over port records (no interior access); `completed ≤ started` is the completion door in
stream form; clicking a track replays its interior under a tap — the SAME mechanism as the
user-facing provenance walk. Live overview and post-hoc explanation are one machinery.

## Prior art

Nearest: W3C PROV *bundles* — descriptive, unenforced; construction-enforced isolation with
a containment theorem has no verified prior. Provenance-driven live monitoring exists
(DfAnalyzer / Souza–Mattoso, HPC workflow steering) — the narrower novel claim is progress
as a *pure fold with proved monotonicity* (the completion door in stream form) and live
drill-in unified with post-hoc explanation through ONE replay machinery. noWorkflow (PVLDB
2017) is the two-layer twin at language grain — it does not do purity-collapse-replay,
demand-lattice cones, or enforced track isolation.
