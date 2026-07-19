# Execution-plan wireframe — the generalized provenance plan (R5)

*Design for [RULINGS.md](../RULINGS.md) R5, DAG node C3 of the 2026-07 principle-first
rework (the rework DAG lives in the private monorepo docs).
Companion constraints: R2 (container structural facts), PRINCIPLES P0/P10/P11, and the
standing v0.2 static-lineage reframe (private monorepo docs).*
— this design is the continuation of that arc, not a rival to it.*

## 0. Position in the lineage arc (what this does and does not supersede)

R5's target: the AST statically evaluates into a base **wireframe** holding every
mux/bifurcation, static wires **collapsed** into procedural nodes — `(+ (* x x) 5)` is ONE
provenance edge, not four — and real runtime provenance wires into the abstract flow.

Three standing facts shape everything below:

1. **The static skeleton already exists at arg granularity.** `src/values/lineage.ts`'s
   `LineageNode` (literal / leaf / source / pipe / merge / field / fan / mux / opaque) +
   `classify()` + `walk()`/`countCone`/`fullCone` are the per-consumer-argument wireframe,
   live and G0-proven with the `AutoBindings` runtime leaf-stamp sidecar. The wireframe is
   `classify` **generalized from per-arg op-sequences to the whole program**, not a new
   vocabulary.
2. **The v0.2 reframe stands: `AValue.provenance` (the eager per-value Set) is NOT
   retired here.** The Stage-B pre-mortem found the flip a security regression (the sift
   seal's per-leaf grounding — Gsec) and the Set's memory cost illusory
   (shared-by-reference). That boundary (v02-G6, genesis-labelled per-value carrier) is
   untouched. **What R5 supersedes is the per-op accumulation on the TRACE side** — the
   one-`Invocation`-per-reduction model whose O(n) invocations × O(depth) sets produced
   the 186MB/46k-invocation heap dump and needs a 500k-entry cap to not OOM a CF isolate.
   The memory win lives in the trace, and only there.
3. **The cone-vs-slice split is settled** (slice.ts's adversarial finding): the
   provenance cone answers *evidence* questions; re-runnable slicing is reference-closure,
   a different query. The wireframe serves the cone queries (both of R5's) and the
   region/statechart/viz readers; slice.ts stays reference-closure over top-level forms.

## 1. Data model

### Node kinds

```ts
type WireframeNode =
  | { kind: "segment";            // maximal collapsed pure region — THE procedural node
      ingress: readonly SlotRef[];      // leaf/source slots feeding it (its only inputs)
      structFacts: StructFactSpec[];    // R2 facts it PROXIES through (see §below)
      astSpan: SpanRef }
  | { kind: "source";             // rosetta-in mint port (infer / fetch / db-read / …)
      op: string; astSpan: SpanRef }
  | { kind: "mux";                // if/cond/case/when/unless — value-select
      selector: WireRef; arms: readonly WireRef[]; astSpan: SpanRef }
  | { kind: "fan";                // map/filter/HOF — per-element template
      lengthPreserving: boolean;        // map=true, filter=false — gates fact proxying
      source: WireRef;
      template: WireframeGraph | null;  // lambda body's own wireframe, parametric
      astSpan: SpanRef }
  | { kind: "binder";             // lambda/let/letrec param routing; letrec may
      cycles: boolean;                  // carry DECLARED back-edges
      astSpan: SpanRef }
  | { kind: "port";               // program ingress (env binds) / egress (exec exit)
      direction: "in" | "out"; astSpan: SpanRef }
  | { kind: "opaque";             // membrane/foreign call — holistic black box
      op: string; astSpan: SpanRef };
```

### Edge semantics — three wire roles

- **value wire** — dataflow. A segment has exactly ONE outgoing value wire per consumer:
  this is the collapse. Inside a segment nothing is a wire at all.
- **selector wire** — control contribution into a mux (the test cone). Kept distinct from
  value wires because the two cone queries treat it asymmetrically (§4).
- **struct-fact wire** — R2's container facts as first-class edges. A container-typed
  value wire carries a parallel `length` fact wire (dicts: `keyset`, postponed). A
  `lengthPreserving` fan **proxies** the fact wire through untouched; `filter` **mints** a
  fresh fact node (the derived length is new information). `length`/`count` consumers
  attach to the fact wire, NOT the value wire — that single routing decision is what
  makes A13 minimal (§4). This implements R2's "named fields, not emergent" verbatim: the
  facts are declared spec entries on the segment/fan nodes, so the naive strategy is
  explicit and the shortcut-eval optimization later reads the same declared wires.

### Identity / keying

Wireframe nodes key on **AST span identity** — the same reader-`Pair` identity
`trace.records` already keys on, serialized as `scopeId(pair)` for cross-process use.
Runtime instances key `(nodeKey, instanceOrdinal)` — a fan's template instantiates once
per element, a lambda's per call. Tooling maps node → source span through the reader's
`__location__`, which is also the collapse-inverse: a segment remembers its member spans,
so "expand this procedural node" is a UI zoom, not a re-analysis.

## 2. The static pass

`classifyProgram(ast, classifier): WireframeGraph` — a whole-program generalization of
`classify()`:

- **The collapse rule.** A wire is static iff its producer and consumer are both
  classifier-pure (`isPure`) and no mux/fan/source/opaque/binder-cycle sits between.
  Operationally: build the fine graph in LineageNode vocabulary, then fold every maximal
  connected subgraph of pipe/merge nodes into ONE segment whose ingress is the union of
  the subgraph's leaf/source slots. `(+ (* x x) 5)` → one segment, ingress `{x}`, one
  provenance edge. Purity is the license (arrival's purity invariant: no set!, no IO —
  a pure region's internal wiring can never differ between runs given the same ingress),
  which is why the collapse is sound *in arrival specifically*.
- **Field steps** (`(:k x)` / car / vector-ref-literal) stay inside segments as
  `PathStep`s on the ingress slot (the v0.2 carrier already made the key static; the
  wireframe inherits it — the dropped key lives in the plan, never minted at runtime).
- **Lambdas / closures.** Each lambda body classifies into its own `WireframeGraph`
  (the fan `template` generalized to all callables). Captured variables are ingress
  slots of the template wired to the defining scope's wires. A first-class lambda
  flowing as a VALUE is a literal (never carries provenance — existing rule); its
  template activates per call-site wire.
- **letrec** (post-R7 lowering fix): binder node with declared back-edges; the collapse
  never folds across a back-edge, so recursive knots stay visible muxes/segments rather
  than mis-collapsing into a cycle-containing "pure" region.
- **syntax-rules.** Classify runs on the EXPANDED form. Prerequisite W0 (§6):
  macro-expansion-constructed Pairs today carry no `__location__` and are untracked —
  expansion must propagate the use-site span onto constructed Pairs (hygiene already
  renames idents; spans ride the same rewrite). Until W0, macro bodies classify as
  opaque — degraded, never wrong.
- **The existing cone machinery slots in per-segment**: `walk`/`countCone`/`fullCone`
  become the intra-segment adjoint table — a segment's demand-projection from its one
  output to its ingress slots is exactly what `walk()` computes today over the
  LineageNode subgraph the segment folded.

## 3. Runtime wiring

The evaluator records **per port crossing**, not per reduction:

| Recorded | At | Replaces |
|---|---|---|
| ingress bindings: slot → point-ids | segment entry | `symbolContributions` + per-child union |
| mint | source port | `isProvenancePoint` + `{self.id}` sets |
| decision: taken arm + selector points | mux | rosetta control-flow restriction wrappers |
| instantiation: element ordinal + per-element bindings | fan | one Invocation per element application |
| fact events: proxied / minted-with-value | struct-fact wires | (new — R2) |
| egress: final points at out-port | exec exit | (unchanged seam) |

**What dies:** `Invocation` minting for interior pure Pairs — the trace's enter/exit
taps fire at port nodes only. `computeProvenance`'s union walk, the
authoritative-set forwarding heuristic, and `#pruneChildProvenance` all dissolve: they
are compensations for accumulating at the wrong granularity (the authoritative WeakSet
is literally a hand-built segment-collapse detector — "don't re-union across a
forwarding boundary" IS "this is one segment"). Wrong states become impossible instead
of pruned: interior nodes have no mint or accumulation API at all (P11 structurally).

**What stays:** `AValue.provenance` eager stamps and every one of their ~64 stamp sites
(the reframe, Gsec); the trace cap (now counting port crossings); `EvalTap` as the
interface (the wireframe recorder is a tap implementation).

**Speculation / regions.** *(AHalfBaked since dissolved — R4 verdict KILL, `90272a0b99`;
the speculative-pending-wire role is carried by §8's struct-fact wires instead.)* An
`AHalfBaked` crossing a port records a pending wire that
completes when the value bakes (mirrors R4's MaybePromise egress). Regions
(`region-boundaries.ts`) become wireframe subgraph annotations rather than a post-hoc
fold over the invocation log.

**Memory, roughly.** Today: one `Invocation` (~150B + sets + retained values) per
reduction; a 46k-iteration TCO loop = 46k invocations (the measured 186MB dump);
DEFAULT_TRACE_CAP 500k exists because the trace grows with TIME. Wireframe: the plan is
O(program text) — KBs; runtime wiring is O(ports crossed), and a loop crossing the same
3 ports per iteration appends 3 small port records per iteration — with the natural
next step (per-port ring/run-length aggregation for stable wiring, the same points
repeating) making steady-state loops O(1) per iteration. A CF worker (128MB isolate)
holds the plan + port log where it could not hold the invocation graph; the trace cap
stops being the thing that aborts legitimate long runs.

## 4. The two cone queries — one representation, two traversals

- **Minimal cone** (*why is this an input*): backward walk from a node under a **demand
  lattice** (value / count / field-k). At a segment: demand projects through the adjoint
  table to ingress slots. At a fan: count-demand + `lengthPreserving` prunes the template
  and element wires, following the struct-fact wire instead. At a field step: descend the
  focused child only. At a mux: runtime-taken arm + selector. This is `countCone`
  made total over the program.
- **Full/sealing cone** (*what changes if I adjust this*): FORWARD closure over wires
  from the adjusted node. At a mux it includes untaken arms and everything downstream of
  the selector — adjusting an input can flip the selection, so sealing must be
  conservative (statically selector ∪ arms; runtime decisions may narrow a
  taken-arm-specific query but never the sealing answer).

**A13 resolves by routing, not by a rule patch.** `(length (map id xs))`: map is
`lengthPreserving` → the length fact-wire proxies straight from `xs`'s container fact.
`length` consumes the fact wire. Minimal cone of the count = the fact wire's origin —
`xs`'s grouping fact if minted, EMPTY for a plain unminted `fromArray` list — exactly
the conservation suite's `it.fails` assertion (`expect(provOf(r)).toEqual([])`,
GATE G2). Element points never enter, because no wire connects them to the count.

## 5. Conservation + agreement, restated

**Survives verbatim** (value-layer, observes AValue stamps the wireframe doesn't touch):
the F2 generated-program conservation property; the flat-stamp convention rows
(cons/append/cdr as repaired); mint-at-edge's pure-rosetta forward and
one-mint-per-crossing rows; the egress shed row (P10's only shed).

**Restated over the wireframe** (trace-layer):
- conservation: every in-port/source point is reachable from the out-port through
  runtime-annotated wires (was: survives into some invocation's set);
- mint-at-edge: mint API exists only on source ports — asserted by construction plus a
  law row that greps the recorder surface (P11's "wrong states impossible" form);
- A13 flips green (§4).

**New agreement family rows (P0 — the N interpreters must agree):** the wireframe is a
static interpreter alongside the type lens and oracle Σ. Per generated program of the F2
generator (which computes expected id sets by construction — a free oracle):
`deep-collapsed egress stamp == wireframe egress-port cone`. Divergence is a bug in ONE
of the two interpretations, and the generator prints the seed. This is the strongest
cheap gate the migration has, and it reuses committed machinery unchanged.

## 6. Migration — wireframe derived FROM the trace before it replaces accumulation

- **W0 — span propagation through syntax-rules** (prerequisite): expanded Pairs inherit
  use-site `__location__`. Gate: chibi conformance unchanged; expanded forms appear in
  `trace.records`.
- **W1 — static pass as pure analysis.** `classifyProgram` + collapse, no runtime
  change. Gate: agreement rows (§5) green over the F2 generator against the EXISTING
  eager stamps, plus golden-prov-* cones reproduced. (Analysis home: the analysis layer
  now lives in core `src/provenance/` per DAG C0 — the wireframe lands beside
  flow-graph/trace-to-lineage.)
- **W2 — runtime port recorder as sidecar**, flag-gated like `withAutoBindings()`
  (byte-identical off). Gate: dual-run — port-log-derived cones byte-identical to
  invocation-derived cones on the golden suites; A13 row flips against the sidecar.
- **W3 — consumer migration, one at a time**, dual-run per consumer (the proven L2
  playbook, extended): dag `:fields` → seal `resolveReadIds` → regions →
  `trace-to-chain` → `TraceRegionFold` → studio TraceGraph.
- **W4 — accumulation dies.** Interior Invocation minting retires; enter/exit fire at
  ports; `computeProvenance`/authoritative-forwarding/prune delete.
  Trace-shape-dependent tests (trace-to-forest, regions folds) rebaseline here, and
  DEFAULT_TRACE_CAP re-derives against port-crossing counts.
- **Out of scope, boundary unchanged:** the AValue flip / eager-Set deletion stays
  behind v02-G6 exactly as the reframe rules.

Each step lands green; W1/W2 are additive and independently revertable.

## 7. Interim A13 fix — DO IT, pre-wireframe (decided, P15)

Cheap, ruled, and not throwaway: R2 already orders the naive-but-explicit strategy now.
The fix is one routing change at the op layer — `length`/`count`-family verbs read the
container's OWN flat stamp (the grouping fact) instead of deep-collapsing element ids.
That closes the G2 gate honestly (the conservation row asserts exactly this), unblocks
the C1/C2 containerBox law tables, and the wireframe later subsumes it without undoing
anything — the fact WIRE it introduces conceptually is the same fact the naive field
carries. The alternative (waiting for W2) leaves a known over-attribution leak in every
seal/cone answer for the weeks the wireframe takes. Ride it with C2 (structural facts:
length), not as a separate batch.

## 8. Acceptance criterion inherited from AHalfBaked's dissolution

`AHalfBaked` (a hand-built runtime cardinality-interval carrier for Tier-2 speculative
evaluation) was reviewed and killed — zero production reachability, structurally cornered by
the landed R1/R9 synchronous lazy-proxy egress (an async carrier can't cross a sync proxy
trap without either erasing the optimization at egress-await or breaking the
plain-JS-observable law). See [`halfbaked-existence-review.md`](halfbaked-existence-review.md)
(VERDICT KILL) for the full evidence; the mechanism is gone, but its motivating CAPABILITY —
early-collapsing a monotone control-flow decision before a promise fan fully settles — is a
real requirement the struct-fact wires (§4 above) are the principled home for.

**The motivating program**, preserved as an acceptance test for struct-fact wires (not
runtime early-collapse, which stays out of scope until an async-fan workload — e.g. LLM
predicates over an MCP fan — actually demands it):

```scheme
(if (>= (length (filter (lambda (x) (> x 0)) items)) 2)
    ...then...
    ...else...)
```

Acceptance: once the wireframe's `fan` nodes carry a `structFacts` cardinality wire (the
static generalization of AHalfBaked's per-slot `[lo, hi]` interval — see §1's `StructFactSpec`
and §4's A13 routing), the minimal cone / decidability query over this program's `if` must be
answerable **without materializing `items`'s filtered fan** — i.e. the wireframe can, in
principle, tell a caller "this branch is statically decidable once ≥2 elements are known
kept" the same way AHalfBaked did it at runtime, but as a static fact over the plan rather
than a bespoke promise-functor carrier. If a real async-fan workload later needs the RUNTIME
early-collapse (not just the static plan fact), the wireframe's `mux` nodes are the designed
home for it (P15 dissolution-with-a-survivor note, halfbaked-existence-review.md Q4).

## §9 — Wires are unevaled expressions (V's reframe, 2026-07-09, post-panel)

The load-bearing refinement: a wire between designated nodes is not an edge with a stamp
set — it is a **quoted, lambda-lifted, pure expression defining a purely local relation**
between its endpoint values. `wire = (lambda (in₁ … inₖ) body)`, unevaled, where the
lambda's free-variable set IS the declared ingress. Consequences:

1. **Locality is syntactic.** A wire cannot depend on anything ambient because its FV
   set is its ingress list — declared-consumption drift is unrepresentable, not audited.
   (This is the coeffect discipline made syntax.)
2. **The frame is abstract interpretation.** Wireframe = α(program): keep the designated
   nodes (ports, muxes, sources, sinks — exactly where P0's two interpretations must
   agree), quote the pure interiors. Replay = γ: concretize a wire by evaluating its
   expression on its recorded ingress. The Galois connection is the DEFINITION of the
   two layers, not an imported analogy; Cousot-style soundness obligations apply off
   the shelf.
3. **Panel findings C2 + C4 unify.** A loop's wire is the unevaled fixpoint expression;
   P8b's run-length count + the quoted body = the exact unroll, reconstructible lazily.
   The widened cone (V4) is the cheap abstract answer; the exact relation is one γ-step
   away. "Widening is not least" stops being a contradiction and becomes ordinary
   abstract-interpretation precision loss with a concretization escape.
4. **Tracks are wires.** A track = a wire whose expression is a first-class lambda
   (callback-as-value = the quoted expression; captures = ingress). A collapsed segment
   = a wire with an anonymous lambda-lifted residual. One concept; the track invariants
   I1–I6 are the wire laws stated at a membrane boundary.
5. **Storage sharpens.** Wire expressions are per-TEMPLATE (instances share the quoted
   expression, carry only ingress bindings): expressions O(program), bindings O(ports).
   The expression is pure data — serializable, content-addressable (wire identity =
   hash of canonical print + ingress ids; the Unison move). The plan persists and
   replays cross-machine — the CF-worker snapshot story falls out.
6. **Materializer exists.** `src/provenance/uneval.ts` (C0 merge) is the value→expression
   direction; lambda-lifting a segment = the classifier's ingress-set computation it
   already performs. W1's builder gains one obligation: emit the residual expression per
   wire template, not just the edge.

Law addition (rides the P5 stubs): **wire-locality.law** — for every wire template,
FV(expression) = declared ingress (syntactic check, assembly-time); and
**wire-γ.law** — eval(wire.expression, recorded ingress) reproduces the recorded egress
on the replay-nondeterminism corpus (this is W2 restated per-wire, and subsumes it).

### §9.1 — RULED: full homoiconicity (V, 2026-07-09)

The wire expression is not "stored as" reader AST or tagless-final — it is an **arrival
lambda, a value of the language itself**. `uneval` produces a closed, lambda-lifted
scheme lambda (params = ingress). The reader-AST/tagless dichotomy dissolves: a lambda
IS Pairs-with-spans as data and IS the tagless algebra under evaluation; the iso between
those readings is the evaluator, already law-tested.

Consequences:
- **γ = apply.** Replay = `(apply wire recorded-ingress)` in a hermetic env (base packs
  + ingress bindings via the env-capability assembler). P9's engine shrinks to env
  assembly + the existing interpreter.
- **Replay is a track.** A wire application runs under B3 region discipline verbatim —
  sealed ingress, single egress, no-penetration for free. I1–I6 cover replay with zero
  new machinery.
- **Wire purity by construction.** Ports break segments, so a wire body structurally
  contains no source/mux/gensym — the panel's nondeterminism findings cannot reach wire
  interiors.
- **Provenance is in-language data.** Cone queries writable as arrival programs; MCP
  agents walk the graph with ordinary verbs; drill-in under tap yields the wire's own
  ephemeral trace (meta-level = same level, walked not stored).
- **Serialization = write/read** (name-escape round-trip law already pins it);
  content-address = hash of canonical print.

Obligation moved onto `uneval`: it must emit CLOSED lambdas (FV = params, verified by
wire-locality.law at emission), evaluable in the hermetic base env — no ambient capture.
The purity invariant of arrival-scheme (pure dataflow, zero dynamics) is what makes
hermetic re-evaluation sound; one more place that constraint pays.

### §9.2 — Why the collapse is the product, not an optimization (V, 2026-07-09)

Nobody needs to traverse the math and string operations. Everyone needs "where did this
actually come from" and "what did it impact." Ports are membrane crossings — the places
where the world touches the program — and those are exactly the entities in a user's
mental model of provenance. The wire interiors were never provenance in the user's sense;
they were materialization. So the collapse doesn't approximate the answer, it IS the
answer: α lands on the user's own ontology, and the storage optimum and the UX optimum
coincide because "provenance-significant" was defined by meaning, not by cost.

This is the studio's intent-over-materialization stratification applied to provenance:
ports = intent (stored, foregrounded); wires = the transparent glass (walkable on demand,
one γ-step away); interior reduction steps = plumbing (hidden with guarantees). It also
names why store-everything predecessors (omniscient debuggers, PROV stores) go unused:
they answer a stratum-1 question with stratum-3 material.

### §9.3 — The third surface: the plane at large (V, 2026-07-09)

Two cone queries answer questions FROM a node. The third product surface is the synoptic
view — the plane at large — and it maps 1:1 onto the data model:

- **Plane (x,y) = the prospective template graph** — O(program), renderable before
  anything runs; one wire per template edge (map is ONE wire, not n).
- **Z-axis = instance-ordinal space** — fan tracks stack behind their template edge;
  loop iterations stack behind the backedge; P8b's RLE count IS the z-depth, so depth
  annotates without materializing records.
- **Level-of-detail = the demand lattice** — cruising altitude shows struct-facts
  (z-depth = the length fact-wire); zooming into one z-layer = a γ-step (apply that
  track's wire lambda). The render is literally the abstract interpretation:
  plane = α, z-drill = γ.
- **Live materialization = the plane animated** — the retrospective stream fills
  z-stacks as tracks complete; region counters render as stack fill-ratio. P11's spec:
  overview, provenance map, and progress view are ONE surface with time flowing
  through it.

Product trinity, one graph, three primitives (template, ordinal, γ): backward cone
("where did this come from"), forward cone ("what did it impact"), plane at large
("show me the whole thing, live").
