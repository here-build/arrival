# Provenance stack — academic lineage

*Names the shared origin of every concept in the arrival provenance stack — one axis
through PL theory, one through provenance systems — so future work imports theorems and
vocabulary instead of re-proving and re-naming. Companions: execution-plan-wireframe.md,
provenance-vocabulary-v2.md, callback-track-graphs.md.*

## 1. The import table

| Our concept | Origin (verified) | Term of art | The divergence (what we re-aim it at) |
|---|---|---|---|
| Membrane, region-scoped wrappers | Miller, *Robust Composition*, PhD 2006 (E; Redell's Caretaker 1974) | ocap **membrane**, revocable forwarder | revokes *temporal validity* for provenance soundness, not *authority* for security; escape = teaching door, not silent no-op |
| Regions (invocation-bound, escape = error) | Tofte & Talpin, Inf. & Comp. 132(2), 1997; POPL 1994 | region-based memory, **letregion** | delimits provenance-graph lifetime, not allocation lifetime; declared by host role, not inferred |
| Host-verb roles, callbacks-as-tracks | Lucassen & Gifford POPL 1988 (kinds = {type, effect, region} — effects and regions born unified); Plotkin & Pretnar ESOP 2009 | effect system; algebraic effect **handler** | a track = handler scope with control amputated to single-shot; roles gate provenance routing, not permitted operations |
| Track determinism, fold acc chain | Kahn, IFIP 1974; Lustre/Lucid Synchrone (Caspi–Pouzet) | **Kahn Process Network**, determinate stream function | Kahn's determinacy theorem run BACKWARDS: determinism licenses replay, not scheduling freedom. Fold chain = capacity-1 Kahn channel; parallel tracks = processes with no channel |
| Ingress boundary, preamble semantics | Danvy & Filinski, LFP 1990 | delimited continuation, **shift/reset** | the delimiter as a SEAL (capture forbidden, doors throw) — inverse of reification |
| Contract-derived callback wiring, drift alarm | Findler & Felleisen ICFP 2002; Wadler & Findler ESOP 2009 | higher-order contract; **blame** (positive/negative) | contract mined for a routing fact at assembly, not monitored for violation at runtime; teaching door = blame rendered educational |
| Opaque-symbol bridges | Kohlbecker–Friedman–Felleisen–Duba, LFP 1986 | **hygiene**, gensym freshness | freshness prevents provenance capture, not variable capture — "names cross, cones cannot" |
| Replay-on-demand of pure segments | Acar–Blelloch–Harper POPL 2002; Hammer et al. *Adapton* PLDI 2014 | self-adjusting computation, **demand-driven** dependence graph | replay over SEALED inputs for explanation, not mutable inputs for incremental update |
| Two-layer split (wireframe / port records) | workflow provenance: VisTrails (Freire et al. 2007), Kepler, Taverna; Lim et al. IEEE 2010 | **prospective vs retrospective provenance** — ADOPT THIS VOCABULARY | ours is sub-expression-grained with purity-collapse; workflow systems are actor-grained, never recover interior detail by replay |
| Cone queries | Weiser ICSE 1981; Ferrante–Ottenstein–Warren TOPLAS 1987; Korel–Laski 1988, Agrawal–Horgan PLDI 1990 | PDG; **backward/forward dynamic slice** | wireframe = PDG + purity-collapse; demand lattice (value/count/field-k) refines the slicing criterion; two-color cones split control- from data-contribution |
| Why/impact taxonomy, struct-fact verbs | Buneman–Khanna–Tan ICDT 2001; Green–Karvounarakis–Tannen PODS 2007; Cheney–Chiticariu–Tan FnT-DB 2009 | **why/where/how provenance; semirings** | minimal cone = why-provenance; PROXIED/PROVENANCED/MINTED ≈ semiring identity/combination/generator — I1 becomes a homomorphism property; length-as-first-class-wire has no ℕ[X] analogue |
| Callback tracks vs nesting | W3C PROV-DM 2013 | **bundle**, account | PROV bundles are descriptive; our isolation is construction-enforced with a containment theorem — no verified prior enforcement |
| Stamps, I1 | Denning CACM 1976; Myers POPL 1999 (Jif); LIO 2011; TaintCheck NDSS 2005 | taint labels, security lattice, **noninterference** | **I1 IS a noninterference/confinement theorem** — declassification through a single channel (Sabelfeld–Myers delimited-release shape), proved by construction (doors) not by lattice typing; telos inverted: bound cones, not withhold secrets |
| Replay-not-store thesis | Zaharia et al. *RDD*, NSDI 2012 (Best Paper); Mokhov–Mitchell–Peyton Jones ICFP 2018; Unison; rr / deterministic record-replay (CACM) | **recompute-from-lineage; early cutoff; store-nondeterminism-replay-determinism** | Spark = the thesis at partition granularity for fault tolerance; we push it to value-level cones with membrane boundaries. rr's spectrum ("storage > recomputation for sparse access") names our tradeoff — we cut it at port crossings |
| Drill-in-by-replay | Lewis ODB, AADEBUG 2003; Ko & Myers *Whyline*, CHI 2004 | omniscient debugging; **interrogative debugging** | we are omniscient debugging's storage-dual: same "why did" query power at record-replay footprint |

## 2. The coeffect frame (adjacent, not yet adopted)

The adopted vocabulary (prospective/retrospective, backward/forward slice,
confinement/declassification) is normative in [`PROVENANCE.md`](../PROVENANCE.md) §8. One
frame stays noted but unadopted:

- **Coeffects** (Petricek–Orchard–Mycroft ICALP 2013 / ICFP 2014; Granule ICFP 2019) —
  effects describe what a computation does TO the world; coeffects what it CONSUMES from
  context. Track ingress ("the consumption to highlight") is coeffect-shaped; graded
  comonads are its type-theoretic home. The vocabulary is currently effect-worded for an
  ingress-centric model — the coeffect frame fits the sealed-preamble reading natively.

## 3. Must-engage prior art (the measuring bar)

1. **noWorkflow** (Pimentel–Murta–Braganholo–Freire, PVLDB 2017; TaPP 2015) — our twin:
   prospective + retrospective provenance from a script's AST + execution, explicitly
   linked, language-grained. Does NOT do purity-collapse-replay, demand-lattice cones, or
   enforced callback isolation — that is the precise novelty bar.
2. **Perera–Acar–Cheney–Levy, "Functional Programs that Explain their Work"** (ICFP 2012)
   + **"Provenance as Dependency Analysis"** (Cheney–Ahmed–Acar, MSCS 2011) + **"A Core
   Calculus for Provenance"** (POST 2012) — the PL community's provenance-in-a-functional-
   interpreter line; the literature any paper here is judged against. Independently
   confirms cone-as-dependency.
3. **DfAnalyzer / Souza–Mattoso** (FGCS) — runtime provenance as live monitoring + user
   steering in HPC workflows. **Contests our novelty claim**: provenance-driven live progress
   monitoring EXISTS. Corrected claim → what remains ours: progress as a *pure fold with
   proved monotonicity* (P2 = the completion door in stream form) and *drill-in unified
   with post-hoc explanation through one replay machinery*.
4. **Lazy provenance materialization** — a named database technique; cite it so the
   storage-optimality claim lands as a principled point on a known tradeoff curve.

**Ciel** (Murray et al., NSDI 2011) — unverified.

## 4. The honest novelty statement

Every ingredient has an owner. The recipe does not. Position the system as the
intersection of five mature lines — prospective/retrospective workflow provenance,
PDG-based dynamic slicing, RDD recompute-from-lineage, hermetic-build/content-addressed
caching, IFC noninterference — whose compound no single line has assembled:

> **Purity-licensed segment collapse + demand-lattice value-cones + construction-enforced
> (not descriptive) callback-track isolation proved as a noninterference-style
> containment + a live progress model that is a pure monotone fold over the same minimal
> port stream that answers post-hoc "why."**

Consistent pattern across all eight PL imports: each classical mechanism re-aimed from
its original job (memory / security / scheduling / control / incremental update) at one
new target — provenance isolation with on-demand replay. The eliminated-dynamics
constraint (no set!, no IO) is what makes every one of the re-aims sound; that single
language decision is the keystone the whole intersection stands on.
