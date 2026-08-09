# Execution-plan wireframe — generalized provenance

*Design note behind [RULINGS.md](../RULINGS.md) R5 (resting on R2, PRINCIPLES
P0/P10/P11). Normative content lives in [PROVENANCE.md](../PROVENANCE.md); this note keeps
the reasoning and rejected alternatives that shaped the two-layer wireframe.*

The representation is a generalized execution plan: the AST statically evaluated into a
base **wireframe** holding every mux/bifurcation, with static wires **collapsed** into
procedural nodes — `(+ (* x x) 5)` is ONE provenance edge, not four — and real runtime
provenance wiring into the abstract flow.

## Three facts that shaped it

1. **The static skeleton already exists at arg granularity.** `../../src/values/lineage.ts`'s
   `LineageNode` + `classify()`/`walk()`/`countCone`/`fullCone` are the
   per-consumer-argument wireframe; the whole-program wireframe is `classify` GENERALIZED
   from per-arg op-sequences to the program, not a new vocabulary.
2. **`AValue.provenance` (the eager per-value Set) is NOT retired by the wireframe.**
   Retiring it is a security regression — the sift seal grounds on per-leaf stamps — and
   its memory cost is illusory (sets share by reference). What the wireframe supersedes is
   per-op accumulation on the TRACE side: the one-`Invocation`-per-reduction model, whose
   O(n) invocations × O(depth) sets grow trace heaps with runtime (a 46k-iteration loop →
   a 186MB heap dump) and force a hard trace cap to avoid OOMing a 128MB isolate. The
   memory win lives in the trace, and only there.
3. **Cone ≠ slice.** The provenance cone answers *evidence* questions; re-runnable slicing
   is reference-closure, a different query. The wireframe serves the cone queries;
   `slice.ts` stays reference-closure over top-level forms.

## The collapse rule and its license

A wire is static iff its producer and consumer are both classifier-pure and no
mux/fan/source/opaque/binder-cycle sits between; every maximal pure connected subgraph
folds to ONE segment whose ingress is the union of the subgraph's leaf/source slots.
**Purity is the license**: arrival's purity invariant (no set!, no IO) means a pure
region's internal wiring can never differ between runs given the same ingress — which is
why the collapse is sound *in arrival specifically*. letrec back-edges are never folded
across, so recursive knots stay visible muxes/segments rather than mis-collapsing into a
cycle-containing "pure" region. syntax-rules classify on the EXPANDED form; where use-site
spans are absent, macro bodies classify as opaque — degraded, never wrong.

**Struct-fact routing.** R2's container facts are first-class wires: a container-typed
value wire carries a parallel `length` fact wire. A length-preserving fan (map) **proxies**
it through; `filter` **mints** a fresh fact node (derived length is new information).
`length`/`count` consumers attach to the fact wire, NOT the value wire — that single
routing decision is what makes length-of-map minimal: `(length (map id xs))` resolves the
count to the fact wire's origin (`xs`'s grouping fact if minted, EMPTY for a plain
unminted list), and element points never enter because no wire connects them to the count.
This implements R2's "named fields, not emergent" verbatim.

## Why per-reduction accumulation was the wrong granularity

Per-reduction union walks, authoritative-set forwarding heuristics, and child-provenance
pruning are all compensations for accumulating at the wrong granularity — an authoritative
"don't re-union across a forwarding boundary" WeakSet is a hand-built segment-collapse
detector. Recording per port crossing instead of per reduction makes wrong states
impossible rather than pruned: interior pure nodes have no mint or accumulation API at all
(P11 structurally). Per-reduction accumulation costs ~150B + sets per reduction, so the
trace grows with TIME; the wireframe plan is O(program text) and runtime wiring is O(ports
crossed), with per-port run-length aggregation making steady-state loops O(1)/iteration —
a 128MB isolate holds the plan + port log where it cannot hold the invocation graph.

## Agreement is the cheap gate (P0)

The wireframe is a static interpreter alongside the type lens and oracle Σ. Per generated
program of the conservation generator (which computes expected id sets by construction — a
free oracle): `deep-collapsed egress stamp == wireframe egress-port cone`. Divergence is a
bug in ONE interpretation, and the generator prints the seed. Strongest cheap gate the
design has; reuses committed machinery.

## Cardinality facts without a runtime carrier

`AHalfBaked` — a hand-built runtime cardinality-interval carrier for speculative
evaluation — was killed on review: an async carrier cannot cross the synchronous
lazy-proxy egress without either erasing the optimization at egress-await or breaking the
plain-JS-observable law ([`halfbaked-existence-review.md`](halfbaked-existence-review.md)).
Its motivating CAPABILITY — early-collapsing a monotone control-flow decision before a fan
fully settles — is real, and the struct-fact wires are its principled home. The motivating
program, preserved as an acceptance test for struct-fact wires:

```scheme
(if (>= (length (filter (lambda (x) (> x 0)) items)) 2)
    ...then...
    ...else...)
```

With `fan` nodes carrying a `structFacts` cardinality wire (the static generalization of a
per-slot `[lo, hi]` interval), the minimal cone over this `if` must be answerable
**without materializing `items`'s filtered fan** — a static fact over the plan, not a
bespoke promise-functor carrier. A RUNTIME early-collapse (async LLM predicates over an MCP
fan) belongs on the wireframe's `mux` nodes.

## Wires are unevaled expressions

The load-bearing refinement: a wire is not an edge with a stamp set — it is a **quoted,
lambda-lifted, pure expression** `(lambda (in₁ … inₖ) body)`, unevaled, where the lambda's
free-variable set IS the declared ingress. Consequences:

1. **Locality is syntactic.** A wire cannot depend on anything ambient because its FV set
   is its ingress list; declared-consumption drift is unrepresentable, not audited (the
   coeffect discipline made syntax).
2. **The frame is abstract interpretation.** Wireframe = α(program); replay = γ
   (concretize a wire by evaluating its expression on recorded ingress). The Galois
   connection is the DEFINITION of the two layers, not an imported analogy; Cousot-style
   soundness obligations apply off the shelf.
3. **Loops unroll lazily.** A loop's wire is the unevaled fixpoint expression; run-length
   count + quoted body = the exact unroll on demand. Widening is ordinary
   abstract-interpretation precision loss with a concretization escape.
4. **Storage sharpens.** Wire expressions are per-TEMPLATE (instances share the quote,
   carry only ingress bindings): expressions O(program), bindings O(ports). Pure data —
   serializable, content-addressable (wire identity = hash of canonical print + ingress
   ids; the Unison move).

### Full homoiconicity

The wire expression is an **arrival lambda, a value of the language itself** — not "stored
as" reader AST or a tagless-final term. The reader-AST/tagless dichotomy dissolves: a
lambda IS Pairs-with-spans as data and IS the tagless algebra under evaluation, and the iso
between those readings is the evaluator (already law-tested). Therefore **γ = apply**:
replay = `(apply wire recorded-ingress)` in a hermetic env (base packs + ingress bindings),
running under region discipline verbatim — the replay engine shrinks to env assembly + the
existing interpreter. Wire purity holds by construction (ports break segments, so a wire
body contains no source/mux/gensym — nondeterminism cannot reach wire interiors). The
obligation on `uneval` (`../../src/provenance/uneval.ts`): emit CLOSED lambdas
(FV = params), evaluable in the hermetic base env — no ambient capture. Arrival-scheme's
purity invariant (pure dataflow, zero dynamics) is what makes hermetic re-evaluation sound.

### Why the collapse is the product, not an optimization

Ports are membrane crossings — where the world touches the program — and those are exactly
the entities in a user's mental model of provenance. Wire interiors were never provenance
in the user's sense; they were materialization. So α lands on the user's own ontology: the
storage optimum and the UX optimum coincide because "provenance-significant" was defined by
meaning, not by cost. This is intent-over-materialization applied to provenance (ports =
intent, stored; wires = glass, walkable on demand; interior steps = plumbing, hidden with
guarantees) — and it names why store-everything predecessors (omniscient debuggers, PROV
stores) go unused: they answer an intent-stratum question with plumbing-stratum material.

The track invariants ([callback-track-graphs.md](callback-track-graphs.md)) are these wire
laws stated at a membrane boundary.
