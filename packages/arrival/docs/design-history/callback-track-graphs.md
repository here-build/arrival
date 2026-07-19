# Callback tracks — isolated provenance graphs, formally

*Status: formal design (V + Fable, 2026-07-09). Builds on: region discipline (B3,
`region-scope.ts`), provenance-vocabulary-v2.md (roles, callback wiring from contracts),
execution-plan-wireframe.md (segment collapse, port records, replay). The claim: a
callback crossing into a host verb is not part of the main provenance graph — it is an
isolated TRACK, and the isolation is by construction, not bookkeeping.*

## 1. The model

**Main graph** `G` — the program's wireframe + its runtime port records.

**Region** `R` — B3's scope token `{open, pending, signal}`, opened by a host-verb
invocation that exports callables. A region owns an **ordered sequence of tracks**
`T₁ … Tₙ`, one per callback invocation, ordered by the host's iteration.

**Track** `Tᵢ` — an isolated provenance graph with exactly three surfaces:

- **INGRESS** (the consumption to highlight): callback arguments supplied by the host,
  plus closure captures from the callback's lexical environment. Every ingress edge
  references a SEALED value — provenance fixed before the region opened (captures) or
  fixed by the host port's own ingress (per-iteration args). *The main program relates to
  a track exactly as a completed preamble*: readable, immutable, temporally closed.
- **INTERIOR**: the callback body's own wireframe — same purity-licensed segment
  collapse, same replay-materialization on demand. Never stored step-by-step.
- **EGRESS**: at most ONE value (the return), delivered to the HOST PORT — never to `G`
  directly. The host's declared role wires it (vocabulary-v2 §3):

| Host role | Track composition | Egress meaning |
|---|---|---|
| element-transformer (map) | **parallel** — zero inter-track edges | element *i*'s lineage |
| selector (sort comparator) | parallel | ORDER structural fact only (PROXIED plane) |
| decision (filter pred) | parallel | membership/length (PROVENANCED plane) |
| accumulator (fold/reduce) | **chained** — `egress(Tᵢ) → ingress(Tᵢ₊₁)` acc slot, the ONLY sanctioned inter-track edge | the running value |
| effect (for-each) | **terminal** — no egress | the track is a sink; its cone dies at the region boundary |

## 2. Invariants

**I1 — No-penetration (the design theorem).** For any node `n` interior to `Tᵢ`:
`cone⁺(n) ∩ G ⊆ cone⁺(egress(Tᵢ))` — and for effect tracks, `cone⁺(n) ∩ G = ∅`.
Stated precisely (panel finding C3, `provenance-design-challenges.md`): this is
**value-egress provenance confinement** — no provenance-id flows from a track interior
into `G` except through the egress wire. It is NOT behavioral/world noninterference: an
effect track's sink events happen and are real. Corollary: the sealing/full cone of any
value CAPTURED by an effect track must include the region port — adjusting a capture
changes observations, and under-reporting that is forbidden. The confinement holds *by
construction*: total immutability (the whole mutator family — set!, vector-set!,
string-set! — is teaching-doored) and no call/cc/dynamic-wind (deliberately
unimplemented; continuations are the classical region-escape channel) are LOAD-BEARING
invariants here, plus region doors killing every historical escape (returned closures,
retained wrappers, post-completion calls, unsettled promise egress).

**I2 — Preamble consumption.** `ingress(Tᵢ) ⊆ sealed(G at region-open) ∪ hostArgs(i)`.
Nothing a track reads can change after it reads it; replaying `Tᵢ` at any later time
yields identical results (replay stability — the same soundness the wireframe's
segment replay rests on).

**I3 — Track separation.** Inter-track edges exist ONLY where the host role declares
them (the fold chain). Spontaneous `Tᵢ → Tⱼ` flow is impossible: each track's reachable
world is its sealed ingress. Order itself is a structural fact of the host port, not a
dataflow edge.

**I4 — Completion (already enforced).** At region close, started = completed (B3's
pending counter, throwing door). Provenance reading: an incomplete track is a dangling
subgraph; the door prevents it from ever existing in a closed region.

**I5 — Exterior collapse.** From `G`'s perspective the entire region is ONE node:
`ingresses → [region port] → egress-per-role`. Track interiors are the region's private
interior — the segment-collapse rule applied one level up. `G` stores O(1) per region +
O(tracks) counters; interiors replay on demand.

**I6 — Bridges are identity, never cones.** Opaque symbols (the deferred ASymbol
crossing design) are the sanctioned inter-world carriers: identity round-trips through
the opaque mapping, provenance does not ride ambiently. Names cross; cones cannot.
A bridge is provenance-inert by type — consuming a bridged identity in a track is an
ingress read like any other.

## 3. Live materialization (the inhuman tie-in)

The track set IS the progress model — no separate instrumentation:

- region = the task; track = the unit of work; `{started, completed}` counters are the
  port-record stream, already emitted at the only places anything is recorded.
- **P1 (stream-fold):** folding the open/close event stream reproduces the region's
  final state exactly — progress UI is a pure fold over port records, no interior access.
- **P2 (monotonicity):** `completed ≤ started`, both monotone; violation = the I4 door
  in stream form.
- **P3 (drill-in = replay):** clicking a track in the progress view replays its interior
  under a tap — the same mechanism as the user-facing provenance walk. Live overview and
  post-hoc explanation are ONE machinery.

Nearest prior art (corrected after the lineage survey — see
`provenance-lineage.md`): W3C PROV *bundles* — descriptive, unenforced; our
construction-enforced isolation with the I1 containment theorem has no verified prior.
Provenance-driven live monitoring EXISTS (DfAnalyzer / Souza–Mattoso, HPC workflow
steering) — the corrected claim is narrower and still real: progress as a *pure fold
with proved monotonicity* (P2 = the completion door in stream form), and live drill-in
unified with post-hoc explanation through ONE replay machinery. noWorkflow (PVLDB 2017)
is the two-layer twin at language grain — it does not do purity-collapse-replay,
demand-lattice cones, or enforced track isolation.

## 4. Testing logic

Law families (extend the existing suites; taxonomy per tests.md):

1. **Isolation laws** (`membrane/region.law` extension): enumerate the escape taxonomy —
   returned closure, retained wrapper, post-close call, promise leak — each throws its
   taught door. Already partially landed (B3's 7 rows); the taxonomy table becomes
   exhaustive per composition operator.
2. **Cone laws** (`provenance/track-cone.law`): F2-style generator — random pure host
   program × random callback bodies; compute interior-node impact cones against the
   eager-stamp oracle; assert I1's containment per role (element/selector/decision/
   effect). The effect-track row asserts the EMPTY cone.
3. **Preamble laws**: replay `Tᵢ` after the main program has advanced; byte-equal
   results (I2). Randomized replay points.
4. **Separation laws**: map/filter regions assert zero inter-track edges in the
   materialized graph; fold regions assert exactly the acc chain and nothing else (I3).
5. **Stream laws** (`provenance/track-stream.law`): P1 fold-reconstruction ×
   generated regions; P2 monotonicity as a property over event permutations the
   scheduler could emit.
6. **Bridge laws**: opaque-symbol round-trip through a track preserves identity and
   carries no cone (I6) — lands with the ASymbol crossing design, todo-gated until then.
7. **Agreement family** (P0): the track graph derived STATICALLY from declarations +
   contracts must agree with the eager-stamp oracle on every generated program — same
   free-oracle pattern as the wireframe gate.

## 5. Sequencing

Rides the vocabulary-v2 order (§4 there): kinds land → declaration field → classifier
declaration-driven → contract extraction. Tracks then need only: (a) region port records
gaining track open/close events (B3's counters already count them — emit them), (b) the
track-cone + stream law suites, (c) fold's acc-chain wiring declared on its contract.
Full materialization (drill-in replay) is W2+ of the wireframe migration — the law
suites land FIRST as `it.todo`/`it.fails` per the stubs-before-code discipline that
built the v2 suite.
