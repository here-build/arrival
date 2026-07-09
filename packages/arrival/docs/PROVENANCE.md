# Arrival Provenance — Specification

*Ratified 2026-07-09 (V + Fable). Normative fusion of the design arc — supersedes, for
normative content, the working proposals it fuses (`execution-plan-wireframe.md`,
`provenance-vocabulary-v2.md`, `callback-track-graphs.md`, `provenance-lineage.md`,
`provenance-design-challenges.md`, all in repo-root `docs/working-proposals/`; those
remain as design history and evidence). Language: **CHOSEN** (normative) ·
**EXCLUDED (because …)** · **DEFERRED (until …)** · **LIMIT** (accepted, documented).
Implementation sequencing: P-track in `REWORK-DAG.md`.*

Constitutional ground: PRINCIPLES.md P0 (two simultaneous interpretations), P10 (egress
is the only shed), and the language invariants — total immutability (the mutator family
is teaching-doored) and no continuations (call/cc/dynamic-wind deliberately absent).
Both absences are **load-bearing**: continuations are the classical region-escape
channel and mutation the classical isolation-escape channel. Any future work adding
either re-opens this spec's panel findings (challenges doc) by rule.

## 1. Model

**CHOSEN — two layers, named by the field's vocabulary:** the **prospective** layer (the
wireframe: the program statically evaluated into a template graph) and the
**retrospective** layer (the port-record stream: what actually crossed at runtime).
EXCLUDED: per-reduction Invocation accumulation (the 186MB failure mode; superseded —
its prune/forwarding machinery was a hand-built approximation of segment collapse).

**CHOSEN — designated nodes** are exactly: ports (membrane crossings — source, sink,
rosetta), muxes, fan instantiation points, binders. Nodes are where P0's two
interpretations must agree; everything between nodes is wire. Ports are defined by
MEANING (where the world touches the program), which is why the storage optimum and the
user's ontology coincide (§8).

**CHOSEN — a wire is a closed arrival lambda.** `uneval` emits it lambda-lifted:
parameters = ingress, `FV(body) = params` (checked at emission — wire-locality law).
Locality is thereby syntactic; declared-vs-actual consumption drift is unrepresentable.
- EXCLUDED: stamp-set-only edges (lose replay — the wire must carry the relation).
- EXCLUDED: a storage-format choice between reader AST and tagless terms (false
  dichotomy — an arrival lambda IS Pairs-with-spans as data and the tagless algebra
  under evaluation; the evaluator is the isomorphism and is already law-tested).
- EXCLUDED: JS closures as wire carriers (not serializable, not content-addressable,
  retain ambient references).

**CHOSEN — the frame is abstract interpretation.** Wireframe = α(program); replay = γ =
`apply` of the wire lambda to recorded ingress in a hermetic env (base packs + ingress
bindings via the env-capability assembler), executed under region discipline (§4) —
replay is a track; no separate replay machinery exists.
- EXCLUDED: the trace-slicing Galois adjunction as the general foundation (widening
  makes loop cones non-least — panel C4). It holds and is claimed for LOOP-FREE wires
  (wire-γ law); loops get the abstract (widened) cone plus exact reconstruction via
  aggregation count + quoted body, one γ-step away.

**CHOSEN — collapse rule:** maximal pure connected subgraphs fold to one wire. Ports
break segments by definition, so a wire body structurally contains no source, sink,
mux, or gensym — wire purity is by construction, not by audit.
- LIMIT: segment granularity is phrasing-sensitive (`(+ (src-a) (src-b))` vs
  `(if f (src-a) (src-b))` collapse differently) — true of every PDG; accepted.

## 2. Declaration vocabulary

**CHOSEN — one declared `provenance` role per symbol declaration**, data in string key
space (P7): `pipe` (default for native/sequence/tagless kinds) · `fan` · `source`
(default for rosetta) · `sink` · `transparent` · `loop` · `opaque`.
- EXCLUDED: the two ad-hoc booleans `fanout?`/`pure?` (degenerate two-word fragment of
  this vocabulary; each had exactly two readers).
- EXCLUDED: heuristic classification (`isRosettaIn`, `.fanout` stamped on bound
  functions for duck-reading) — the key-taxonomy violation the P7 corollary exists to
  kill; every static interpreter reads the declared field.
- EXCLUDED: `opaque` as a citizen — it is a quarantined escape hatch; corpus count is a
  shrink-only drift alarm baselined AFTER W0 (span propagation changes what is opaque).

**CHOSEN — declaration kinds LOWER 1:1 to graph node kinds** (one vocabulary, two
layers): `loop` lowers to `binder{cycles}`; `sink`/`transparent` are declaration-layer
facts lowering to graph shapes (a sink is a port with no egress wire; a transparent is a
membrane crossing that neither mints nor stamps — dedent).
- EXCLUDED: two parallel vocabularies (panel C11 — vocabulary-v2 kinds vs wireframe node
  kinds were two design passes over one graph).

**CHOSEN — callback roles extracted from the contract** (z.lambda position + return
shape), with declaration override only where the contract underdetermines:
**element-transformer** · **control** · **effect** · **accumulator**.
- EXCLUDED (for now): the selector/decision split inside `control` and the second cone
  color it implies — one control role and ONE cone color until a product query needs
  "why sorted this way" separately from "where did element k come from" (panel C11;
  both panel models independently advised deferral). DEFERRED, not dead: the wires are
  distinct in the graph; splitting later is additive.
- LIMIT — the drift alarm catches CONTRADICTIONS, not lies: a JS body that fans while
  declared `pipe` is consistent-but-wrong; contract shape cannot see JS bodies, and
  arrange-vs-membership is semantic. Mitigation is the W1 agreement gate plus the
  extended generator corpus (§7), not the alarm.

**CHOSEN — container structural facts** (R2): per TERM, once (P8 — a per-carrier matrix
would re-legalize divergence): `{groupingFact, lengthFact}` with verbs **PROXIED**
(length-preserving: map/sort) · **PROVENANCED** (length-changing: filter — union with
the decision's cone) · **MINTED** (constructors). `length` and count-shaped consumers
read the container's own facts, never the elements' deep union (this closed A13).
DEFERRED: dict keyset fact (until a consumer demands it).

## 3. Tracks

**CHOSEN — a track IS a wire whose expression is a first-class lambda** (captures =
ingress); track invariants are wire laws at a membrane boundary. One concept.

**CHOSEN — composition operator comes from the host role:**
parallel (element/control) · chained (accumulator — `egress(Tᵢ) → ingress(Tᵢ₊₁)` is the
ONLY sanctioned inter-track edge) · terminal (effect — no egress).

**Invariants (normative statements):**
- **I1 — value-egress provenance confinement**: for interior `n` of `Tᵢ`,
  `cone⁺(n) ∩ G ⊆ cone⁺(egress(Tᵢ))`; `= ∅` for effect tracks. EXCLUDED: the
  world-noninterference reading (panel C3 — sink events are real observations; I1
  confines provenance ids, not behavior). Corollary: the forward cone of any value
  CAPTURED by an effect track includes the region port — under-reporting forbidden.
- **I2 — sealed ingress**: everything a track reads is fixed at region open (the main
  program is a completed preamble) or host-supplied per iteration.
- **I3 — separation**: no spontaneous inter-track edges; order is a structural fact of
  the host port, not a dataflow edge. LIMIT: order-dependent selector hosts (sort's
  comparator schedule is data-dependent) — modeled by the host-schedule record (§5),
  without which drill-in on a sort is honestly non-replayable-in-order.
- **I4 — completion**: started = completed at region close, throwing door. CHOSEN
  (async rule, panel C9): a promise egress keeps its track PENDING until settled;
  region close with unsettled egress throws the incomplete door.
- **I5 — exterior collapse**: a region is ONE node from `G`. LIMIT: structured egress
  (one value, several interior cones) — field-demand at a region boundary answers by
  replay, not by records; region field-ports DEFERRED until a workload demands them.
- **I6 — bridges**: opaque symbols are the only inter-world identity carriers; identity
  crosses, cones do not. DEFERRED until the ASymbol crossing design.

## 4. Regions and replay

**CHOSEN — B3's region discipline is the enforcement AND the replay container**: scope
token `{open, pending, signal}`, per-(callable, scope) wrapper identity, escape and
incomplete teaching doors. Replay of any wire executes as a track under a fresh region.

**CHOSEN — R1, stated precisely**: replay from **frozen port payloads** is stable.
Replay NEVER re-invokes a source; retrospective mint records are authoritative (panel
C1 — the finding all three challenge models landed independently).
- EXCLUDED: re-execution stability (a live `infer` re-fetch is a different run — never
  claimed).
- CHOSEN: gensym is a mint; its identity is a recorded payload.
- CHOSEN: effect tracks replay in the second mode — replay-between-records (pure
  stretches applied, recorded port events interleaved verbatim).

**CHOSEN — the eager stamp path is a TEST-ONLY oracle** (agreement corpus, sampled),
compiled out of production hot paths. EXCLUDED: permanent production dual-run (panel
C12 — two provenance mechanisms in tension forever is the fragmentation P0 forbids).

## 5. The retrospective stream

**CHOSEN — record kinds**: mint (WITH payload) · mux decision · fan instantiation ·
ingress binding · track open/close · host-schedule (order-dependent selector hosts) ·
aggregation (run-length/ring for stable-wiring repeated ports — a loop crossing one
port T times with unchanged wiring stores O(1)+count; panel C2).

**CHOSEN — order**: the stream's total order is EMISSION order (settlement order for
async). Counter folds are order-insensitive by construction; anything order-sensitive
must cite a host-schedule record. EXCLUDED: a fictional program-order guarantee under
concurrency.

**CHOSEN — storage bound as a HARD GATE** (not a benchmark — panel C2/longcat: the
motivating workload class must demonstrably die): expressions O(program) per template,
content-addressed (identity = hash of canonical print; serialization = write/read under
the existing round-trip law); bindings O(ports); aggregated loops O(1)+count.
- LIMIT: ports are still Θ(data) for genuine fans — value-grain provenance cannot be
  cheaper than the data whose lineage it keeps; the gate is against ACCUMULATION
  overhead, not information.
- LIMIT: replay requires retained ingress values — long sessions grow with crossed
  values. Mitigation path (not built): segment eviction downgrades drill-in from replay
  to recorded-only.

## 6. Queries — the three surfaces

**CHOSEN — the product trinity over one graph** (R5 ruled the first two before the
architecture existed):
1. **Backward cone** — "where did this come from" (minimal witness; why-provenance).
2. **Forward/sealing cone** — "what does adjusting this impact."
3. **The plane at large** — the prospective graph rendered whole: plane (x,y) = template
   graph, O(program), renderable pre-run; **z-axis = instance-ordinal space** (fan
   tracks and loop iterations stack behind their template edge; aggregation count =
   z-depth without materialization); level-of-detail = the demand lattice; zooming into
   a z-layer = γ. Live materialization = the plane animated by the retrospective
   stream — overview, provenance map, and progress are ONE surface.

**CHOSEN — demand lattice**: value / count / field-k. Cone(count) ⊆ cone(value);
struct-fact wires answer count-demand without touching elements.
EXCLUDED (for now): further grades (cardinality intervals, keysets) — scope creep noted
as a footgun in the HalfBaked post-mortem.

**Why the collapse is the product**: nobody needs the math and string operations;
everyone needs "where from" and "what impacted." Ports = the user's ontology; wire
interiors were materialization, not provenance. Intent-over-materialization applied:
ports = intent (stored, foregrounded) · wires = glass (one γ-step away) · reduction
steps = plumbing (hidden with guarantees). Store-everything predecessors answer a
stratum-1 question with stratum-3 material; that is why they go unused.

## 7. Laws (the test spec — stubs land before machinery)

| Law | Statement | Gate |
|---|---|---|
| wire-locality | FV(wire body) = params, at emission | assembly |
| wire-γ | apply(wire, recorded ingress) = recorded egress; subsumes segment losslessness, loop-free scope | P9 |
| replay-nondeterminism | frozen-payload replay stable under a deliberately mutated external world; interior gensym/source/clock programs generated | P9 |
| W1 agreement | eager-oracle cone == wireframe cone, generated corpus | P7 |
| W3 port completeness | every mint/decision/instantiation/ingress exactly once at emission | P8 |
| track containment (stamp) | I1 over stamp sets vs oracle | P8 |
| track containment (replay) | I1 under replay | P9 |
| track separation | zero inter-track edges except declared acc chain | P8 |
| stream fold + monotonicity | fold(events) = final region state; completed ≤ started monotone, over emission orders | P8 |
| loop-unroll | widened vs exact-via-count cones | staged it.todo |
| memory retention | sealed-value growth measured | rides the R3 gate |

**CHOSEN — generator corpus classes** (the panel's F2-too-pure finding): interior
sources · nested regions (map-in-map, map-in-fold) · first-class HOFs · structured
multi-field egress · macro-expanded bodies (post-W0) · deep mux nesting.

## 8. Prior art (normative positioning; full lineage in `provenance-lineage.md`)

Adopted terms: prospective/retrospective provenance (workflow lineage) ·
backward/forward slice (Weiser; FOW PDG) · confinement/declassification (I1's frame —
Denning→Myers) · coeffect-shaped ingress (Petricek–Orchard). Measuring bar: noWorkflow
(the two-layer twin, no purity keystone) and Perera–Acar–Cheney (functional-trace
explanation; their Galois framing imported, scoped per §1). Novelty claim (honest,
panel-corrected): the RECIPE — purity-licensed collapse + demand-lattice value cones +
construction-enforced track isolation + progress as a pure monotone fold over the same
minimal stream that answers post-hoc "why" — no single line has the compound.
