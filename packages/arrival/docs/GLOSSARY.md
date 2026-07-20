# GLOSSARY — arrival's invented vocabulary

One canonical, one-line definition per invented term, so the vocabulary is defined once
and not re-derived across the docs. Reference canon, not a subsystem doc: it mints no
ID series; each entry ends with the doc that OWNS the term (where the full mechanism and
its enforcement sites live). Alphabetical (γ sorts as *gamma*, Σ as *sigma*). When a
definition and its owning doc disagree, the owning doc wins — fix the entry.

---

**BG-series** — grammar.md's section-scoped tags (BG1–BG9) for the let/cond bracket-superset
rules, renamed from the evaluator's file-local `R1`–`R9` numbers so they never collide with
`RULINGS.md`'s global R-ledger. Cited only within grammar.md; not a cross-subsystem ledger.
*(owner: grammar.md §BINDINGS)*

**borrowed wrapper** — an `AJSArray`/`AJSObject`: a thin, read-only view over a host array/object
that keeps the `source` by reference and boxes its elements lazily on first Scheme read, and
egresses back to that source identity. A container is re-presented, never copied. *(owner:
membrane.md §BOXING vs BORROWING)*

**box** — the execution unit of the second (provenance) interpreter: an `AValue` carrying
ctx + provenance. Not a monadic container — the admission ticket to the second interpreter.
Every value is boxed because an unboxed value is a term the provenance reading cannot execute.
*(owner: PRINCIPLES.md P0/P1)*

**burst** — the deferred-effect arm: when `effects` is armed, a `sink` verb enqueues
`{verbName, decodedArgs}` instead of firing; `burst` later drains the ordered,
non-deduplicating log through a host executor in strict index order, one pass, no retry
(the caller owns rollback). *(owner: execution.md §BURST)*

**C3** — C3 linearization (Barrett et al., OOPSLA 1996), the method-resolution-order algorithm
the kernel runs over the capability dependency DAG to a single total apply order: dependents
lead, dependencies trail; the apply loop walks it in reverse so the nearest capability wins a
doubly-bound name (last-write-wins), and disposal is LIFO. *(owner: environments.md §ASSEMBLY)*

**cache class** — a symbol's serialization/replay axis, declared explicitly and never derived
from the provenance role: `view` (a persisted, cacheable boundary snapshot; demands a
serializable contract), `pure` (regenerateable from decoded args, recovery is re-call), or
absent (re-runs on replay). Orthogonal to the provenance role — `infer` is a `source` with
`cacheClass: "pure"`. *(owner: environments.md §AXES; mechanism execution.md §MODE-LAW)*

**capability** — an `EnvCapability`: a named, inheritance-free module singleton contributing five
things — `symbols`, `configuration`, `resources`, `prelude`, `deps`. Everything an arrival env
contains (the R7RS base, every SRFI, every dialect pack, the loader, a domain tool catalog) is
one; a `deps` edge IS the grant. *(owner: environments.md §CAPABILITY)*

**chart** — a representation view a value is read through on the Scheme plane, chosen by the
contract — e.g. the array chart vs the spine chart (`AJSArrayList`) over one borrowed store.
Selecting a chart is an in-plane choice (`AValue` in, `AValue` out), never a membrane crossing.
*(owner: membrane.md §NOT-A-CROSSING; selection environments.md §CONTRACT)*

**conservative narrowing** — the single law of the static plane: every static reader
over-approximates toward the answer a sound runtime would also accept and degrades to the
unconstrained answer on any uncertainty — a wrongly-tightened verdict is a defect, never a
tradeoff. One rule in four voices (type-lens drops-only, Σ never-drops, validator
degrade-to-warning, classifier over-attribute). *(owner: static-plane.md §CONSERVATIVE NARROWING)*

**door** — a boundary rejection that refuses a violation at the moment of crossing and teaches
instead of merely failing (errors-as-doors): an omitted verb is a `notImplemented` door, a bad
grammar shape a coded reader door, an absent-config verb a degradation door. *(owner:
PRINCIPLES.md P5)*

**egress** — two unrelated senses, fenced explicitly. (1) *Membrane egress* — a boxed value
leaving the interpreter's world Scheme→JS, projected total and observationally-plain (bare /
membrane / gated modes). (2) *Provenance egress* — a region/track/wire's OUTPUT PORT in the
lineage graph (`egress(Tᵢ)`, `cone(egress)`, "a sink is a port with no egress wire"). One is a
value crossing out; the other is a graph node. *(owner: membrane.md §EGRESS and §NOT-A-CROSSING;
provenance sense PROVENANCE.md §3)*

**EnvPack** — the kernel-level lowered form of a capability: `EnvCapability.lower(...)` validates
config, turns each resource into a ref-counted `ResourceCell`, computes the symbols record, and
returns a `LoweredPack` — an `EnvPack` whose `apply(env)` wires the membrane-wrapped symbols and
evaluates the prelude. The kernel C3-linearizes a set of packs and applies each once. *(owner:
environments.md §CAPABILITY)*

**γ-replay** — provenance replay: `γ = apply` of a wire lambda to recorded ingress in a hermetic
env (base packs + prelude + ingress bindings) under region discipline, run in a SILENT region
(doors active, stream emission off) as a pure query over a `(template-hash, ingress)` pair. Never
re-invokes a source — frozen retrospective mint records are authoritative. Distinct from
run-model replay (execution.md §MODE-LAW). *(owner: PROVENANCE.md §4)*

**glass** — transparent, reconstructible-on-demand material, shown by re-derivation rather than
stored. In the provenance plane, wire interiors are glass (one γ-step from the stored ports, which
are intent). A *glass env* is a live host-provided environment whose reads are membrane
penetrations recorded under promised-behavior semantics. *(owner: PROVENANCE.md §6; glass-env
sense §4)*

**hermetic environment** — the runtime-and-storage discipline: an assembled env can only be BORN
(assembled) and READ from JS — never mutated or extended. The structural `SchemeEnv` contract
carries `get`/`registerResolver`/`list` and deliberately no `set`/`inherit`/`merge`; two
module-internal minters plus `bindValue` are the only writers. Run-state is likewise data-local
per `exec()`, never ambient. *(owner: environments.md §HERMETIC; run-state execution.md §HERMETIC)*

**ingress** — a wire's inputs: the parameters of the lambda-lifted closed arrival lambda
(`FV(body) ⊆ params ∪ prelude-names`, checked at emission). At replay, γ applies the wire to
*recorded ingress* — the frozen port payloads that actually crossed at runtime. *(owner:
PROVENANCE.md §1)*

**membrane** — the single seam where the second interpreter's world ends: inside it every value is
a boxed `AValue` both interpreters can execute; outside it only plain, observationally-JS values
exist and the provenance reading stays behind in the run's trace. Conversion is total and uniform
in both directions, only there. *(owner: membrane.md; PRINCIPLES.md P4)*

**mint vs forward** — the load-bearing provenance choice at a crossing: a `source` MINTS a fresh
provenance point off the invocation (external data enters), a `pipe` FORWARDS the input-provenance
union and mints nothing. A `pipe` that minted would fabricate an origin — the seal-laundering bug
class. *(owner: membrane.md §SPINES; environments.md §AXES)*

**mode law** — the record × replay × cache-class table governing the membrane: in `record` mode
the impl fires and its result is written; in `replay` mode a hit answers WITHOUT firing. Behavior
per cache class (`view`/`sink`/`pure`/undeclared) is fixed here — the single home for the
record/replay table. *(owner: execution.md §MODE-LAW)*

**prelude-only** — a symbol bound only for the duration of assembly (the C3 bake): it rides a
per-assembly overlay answered by a base-env resolver during the C3 loop, then is dropped at seal —
post-seal a plain unbound variable everywhere, including from closures a prelude defined. A prelude
carries a prelude-only value into runtime by capturing the VALUE (`(define x (the-verb …))`), never
the verb. *(owner: environments.md §PRELUDE)*

**provenance box** — the box seen from the second interpreter: the same `AValue` unit, named to
emphasize the ctx + lineage it carries so the box layer can execute the program. See *box*.
*(owner: PRINCIPLES.md P0)*

**region** — a `RegionScope`: a token `{open, pending, signal}` minted for ONE symbol invocation
that binds every reverse-crossed callable (a Scheme lambda handed to host JS) so it re-enters the
two-layer execution inside a real frame; call-after-return and return-with-calls-in-flight throw
teaching doors. The same region is provenance's replay container — a wire replays as a track under
a fresh region. *(owner: membrane.md §REGION; replay-container role PROVENANCE.md §4)*

**Σ∩T narrow** — constrained decoding's next-token mask: the intersection of Σ (the bound-symbol
set the oracle proves legal by SCOPE and STRUCTURE) with T (the subset the type lens proves
TYPE-VALID at the slot). Both halves are drops-only, so the intersection is a sound
over-approximation — a token is forbidden only when both readers would. *(owner: static-plane.md
§THE Σ∩T NARROW)*

**source / pipe / sink** — three of the seven provenance roles a symbol declares (one per symbol,
data in string-key space): `source` mints a fresh origin (external data crosses in), `pipe`
forwards its inputs' lineage and mints nothing, `sink` has no egress at all (an effect, void by
law). The full vocabulary adds `fan`/`transparent`/`loop`/`opaque`. *(owner: PROVENANCE.md §2; live
meanings environments.md §AXES)*

**spine** — the cons-cell backbone of a list/pair value (the car/cdr chain). *Spine adoption*
projects a borrowed JS array onto an `AJSArrayList` — an `APair` view over the same store, O(1),
same provenance — before an impl that field-reads `.car`/`.cdr` runs; it is a chart choice, not a
crossing. (Distinct: the *rosetta spine* is the `schemeToJs → fn → jsToScheme` crossing skeleton.)
*(owner: membrane.md §NOT-A-CROSSING; rosetta-spine sense §SPINES)*

**tagless term** — an `arrival/tagless-final/*` method on a value class: one instruction of the
tagless-final algebra implementing BOTH readings (value + box) in one place. Tagless-final is the
property that lets N interpreters (value, box, and the static readers) share one program; a term's
instruction keys are strings so every interpreter consumes them as data. *(owner: PRINCIPLES.md
P0/P7)*

**teaching door** — a door whose message teaches the fix and routes the caller to the correct
subsystem rather than merely rejecting — e.g. `RegionEscapeError` naming the escaped invocation, a
bad-key reader door steering to the prefix form, a degradation door naming the missing config key.
See *door*. *(owner: PRINCIPLES.md P5)*

**wire** — a maximal pure connected subgraph of the provenance wireframe, folded to ONE closed
arrival lambda (parameters = ingress, `FV(body) ⊆ params ∪ prelude-names`). Ports break wires by
definition, so a wire body contains no source/sink/gensym/port-coupled mux — purity by
construction. Replayed by γ. *(owner: PROVENANCE.md §1)*
