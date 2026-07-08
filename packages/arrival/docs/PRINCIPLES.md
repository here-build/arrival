# Arrival — Foundational Principles

*Ejected 2026-07-08 from the test-invariant audit: every principle below was revealed by a
specific place where the codebase asserts the OPPOSITE of itself (a "lie" — current-broken
behavior pinned green, or two invariants that cannot both be design). The lie is cited under
each principle. When code and this document disagree, one of them is a bug; decide which
before writing a line.*

The one-sentence version: **arrival is a pure-dataflow polyglot value plane where every value
carries its history, every boundary is a loud door, and every representation answers for
itself.**

---

## 0. The keystone

**P0. Execution happens on two layers simultaneously — computation over values, provenance
over boxes — and the tagless algebra is the choreography that keeps the two interpretations
coherent.**

A box is NOT a monadic container. It is the execution unit of a second, higher-order
interpreter that runs the SAME program the value interpreter runs: the value layer computes
*what*, the box layer computes *where it came from*, and every `arrival/tagless-final/*` term
is one instruction with two coherent readings. This is why every item is boxed — not for
wrapping discipline, but because an unboxed value is a term the provenance interpretation
cannot execute: the second interpreter doesn't skip it, it silently ABORTS mid-program while
the first keeps running, and the trace it produces from that point on is fiction.

Consequences, before any other principle applies:
- Dropping a box is not a simplification — it is killing one of the two executions.
- "One algebra, every carrier" (P8) is not an aesthetic: a term whose box discipline varies
  by carrier is a term whose provenance reading is undefined.
- "Provenance total or nothing" (P10) is this principle's conservation law.
- The membrane (P4/P5) is where the two-layer execution legitimately ENDS — the one place a
  value may exist without its box, because past the boundary only one interpreter runs.

*Revealed by:* every provenance lie in the audit, seen at once — append's drop, vector-map's
strip, the unstamped cdr spine. Each looked like a local style inconsistency; together they
are one bug: treating the box as decoration on the real computation instead of the other
computation.

---

## I. The value plane

**P1. Nothing is a value unless it carries ctx + provenance.**
A SchemeValue is a boxed AValue (or an honest peer like a raw ES6 symbol inside ASymbol) —
never a bare JS object, function, or primitive smuggled by tolerance. Callables included:
the impl is JS, the *value* that binds it is an ACallable.
*Revealed by:* the AProcedure arm, the LAMBDA brand passthrough, curry's bare-arrow leak,
`env.defineRosetta`'s legacy form — every one a JS artifact living in value space without
lineage.
*Forbids:* new bare-fn producers; `typeof === "function"` as a value-space callability test;
env bindings whose stored value has no class.

**P2. Values are frozen at construction; the only mutations are named doors.**
Immutability is not a style — it is what makes carried provenance TRUE (a mutated value's
lineage is a forgery). Construction-order-impossible structures (cycles) get one enumerated
knot-tying door (`__tieKnot`); assembly-time env binding is phase-gated and dies at phase
close. There is no third kind of mutation.
*Revealed by:* the dead `forMutation`/`frozen` machinery — guards for a mutation path that
could no longer exist, kept "just in case".
*Forbids:* defensive freeze/guard machinery for impossible states; `set!`-shaped anything;
un-named `Object.assign`/property writes on a constructed value.

**P3. Types tell the truth, including the inconvenient one.**
A declaration that under-describes runtime is a bug even while everything works — it makes
every downstream reader either wrong or a caster. If the runtime stores `string | symbol`,
the field says `string | symbol` and every reader narrows honestly.
*Revealed by:* gensym's ES6 symbol smuggled through `__name__: string` via
`as unknown as string` — the class body handled both arms for years; only the declaration lied,
and two call sites grew apology-casts around it.
*Forbids:* `as any`; casts not provable by an adjacent runtime guard; "it's fine, the code
handles it" as a substitute for the type saying so.

## II. The membrane

**P4. Exactly one representation per side; the membrane is the only converter.**
Inside: boxed AValues. Outside: plain JS. A value changes representation at a membrane
crossing and nowhere else — in BOTH directions, for EVERY type, with no per-type exceptions.
*Revealed by:* strings crossing out boxed while booleans cross raw (two invariants pinning
opposite exit contracts); representation-blind `equal?` and `boolean=?`'s deliberate
`z.unknown()` — tolerance machinery that exists only because bare values leak inward.
*Forbids:* representation-blind comparisons (once the bare-value purge completes, blindness
INVERTS to a strict-door throw); "accepts boxed or raw" contracts; any instanceof-chain
converter competing with the protocol (P7).

**P5. Boundaries fail loudly at the moment of crossing.**
A violation is refused where it happens — type-level `never` where expressible, runtime throw
always, message that teaches (errors-as-doors). Never tolerated inward to fail three calls
later as a weird problem.
*Revealed by:* `fromJS`'s old already-boxed pass-through masking which-side-am-I-on confusion;
`isLipsPair` duck-typing patching a hole the loud door would have exposed.
*Forbids:* silent pass-throughs "for robustness"; duck-typed structural sniffing at
boundaries; catch-and-continue on a crossing violation.

**P6. Effects are region-bound to their invocation.**
Anything that crosses the membrane carrying the ability to re-enter (a reverse lambda, a
handle, a port) is scoped to the symbol invocation that produced it: call-after-return
throws, return-with-calls-in-flight throws, run abort cancels re-entries. Escaping the
region is not a relaxation — it is a separate, named capability.
*Revealed by:* (preemptively — the reverse-membrane design) callbacks with no ctx, no owner,
no abort path, working by accident through `Reflect.apply` fallbacks.
*Forbids:* callbacks stashed for later; event-handler patterns without the named capability;
`CONSTANT_CTX` as the lazy answer to "whose invocation is this?".

## III. Representation authority

**P7. The class is the sole authority on its own representation.**
Conversion (`arrival/toJS`), printing (`arrival/print`), equality
(`arrival/tagless-final/equals`), and every other term live ON the value as protocol methods.
Consumers — membrane, rosetta, zod codecs — dispatch the protocol; a codec is a guard + a
contract refinement + a protocol call, never a competing description of the conversion.
*Revealed by:* `schemeToJs`'s instanceof chain with a duck-typed hole where APair should be;
codec encode/decode arms re-describing what classes already know.
*Forbids:* external switch/instanceof conversion chains; a second place that knows how a
vector serializes; codecs with hand-written transform bodies for representation (contract
refinement — ranges, arity, element types — is the codec's real job and stays).

**P8. One algebra, every carrier.**
A term has ONE semantics across all representations: if `map` preserves element boxes on a
Pair, it preserves them on a Vector and a borrowed AJSArray. Representation chooses storage
and iteration, never meaning.
*Revealed by:* vector-map stripping boxes (the DR4 "cross-out impersonator") while
vector-FILTER preserves them and pair-map preserves them — three answers to one question on
overlapping carriers, each pinned green by its own test.
*Forbids:* per-carrier semantic divergence "for interop convenience"; blessing an accident as
"deliberately softer"; goldens that freeze the divergence.

**P9. Conversions are one-way unless a round-trip is PROMISED.**
Where no isomorphism is promised, the conversion is a total, honest projection — a dotted
pair folds into the array, no `{__dotted__}` escape shapes, no partial idempotence. Where a
round-trip IS promised (the studio bifunctor lens), it is exact and tested as a law. Nothing
in between.
*Revealed by:* toJS's retired dotted-pair shape — a half-promise of reversibility that
serialized structure nobody could round-trip anyway.
*Forbids:* marker objects encoding "what the value really was"; conversion outputs that vary
by whether the input was reconstructible.

## IV. Provenance

**P10. Provenance is total or it is nothing.**
Every derivation propagates lineage. The ONLY sheds are named, explicit, semantic:
`exact->inexact` (lossiness opt-in), egress past the membrane (the trace keeps it; the JS
value doesn't). An op that "rebuilds and therefore drops" is a bug, full stop — rebuilding is
an implementation detail and P10 outranks implementation details.
*Revealed by:* `append` rebuilding the spine and dropping every element's provenance; `cdr`
of a proper list returning an unstamped spine cell — both pinned GREEN as "documented
asymmetries the eager path exhibits today".
*Forbids:* green tests asserting provenance loss; "the container was fresh so the lineage is
empty" reasoning; fixing a drop by blessing it.

**P11. Mint at the edge, propagate inside.**
Provenance points are created ONLY at membrane crossings (a rosetta source, an infer call, a
borrowed value's entry). Pure interior computation propagates and unions — it never mints,
and a pure op consuming one source twice still carries exactly that source. `pure: true` is
a provenance CONTRACT, not an optimization hint.
*Revealed by:* (the healthy half of the audit — golden-prov enforces this correctly; kept as
a principle because everything else leans on it.)
*Forbids:* interior ops minting "fresh" lineage; sources declared pure to skip stamping cost.

**P12. Tracing is core, not equipment.**
The trace spine (EvalTrace, scope-ids, snapshots) lives in the interpreter and is always
available — analysis lenses and reactivity adapters layer on top, downstream. If tracing is
optional, provenance is optional, and P10 dies.
*Revealed by:* the spine living in an opt-in package a consumer could simply not wire.
*Forbids:* core features whose lineage story depends on an external package being installed;
observability frameworks (mobx et al.) as core dependencies — adapters wrap the seam outside.

## V. The language surface

**P13. The platform's own grain decides the surface; departures are named supersets.**
R7RS semantics faithfully; Racket/Clojure forms only where R7RS leaves undefined behavior,
each a deliberate, documented, compile-coherent choice (bracket bindings, curly dicts,
keyword accessors). No LIPS-style "JS is the real semantics underneath".
*Revealed by:* the whole LIPS stratum — dotted-symbol object walks, `-->`/`set-obj!`,
JS-truthiness harnesses asserting `===` as `equal?`.
*Forbids:* host-language semantics reachable from scheme without a membrane crossing; syntax
whose meaning is "whatever JS does".

**P14. No shadow features.**
Every capability is reachable from a production entry, or it is explicitly STAGED — an
`it.todo`/gate-spec ledger naming what lands and when. A flag no entry can set, guarded by a
meticulous test suite, is the codebase lying to itself about what it ships.
*Revealed by:* ~40 curly-infix invariants enforcing a feature `ExecOptions` cannot enable;
the lineage classifier wired to nothing but its own tests (correctly staged — the G-gates —
which is exactly the difference).
*Forbids:* dead flags with live test suites; "we'll wire it later" without the gate ledger.

## VI. Test discipline

**P15. Green means design. Nothing else is ever green.**
The suite's truth table is uniform: green = intended behavior; `it.fails` = documented gap
(flips loudly when fixed); `it.todo` = spec'd future. Asserting current-broken behavior green
— even annotated "documented current behavior" — is a lie that will fight whoever fixes it.
*Revealed by:* exact-number JSON.stringify throwing pinned green while its inexact sibling
was honestly `[fails]`; the provenance drops of P10.
*Forbids:* "documents today's behavior" as a test category; rebaselining a golden to a bug.

**P16. Pin behavior, not internals — and pin the harness on purpose.**
An invariant names observable semantics. Impl-pinning (exact error strings, private fields,
class identities) is reserved for two deliberate uses: drift alarms (pack-symbol counts,
anti-vacuity floors) and harness self-checks (chibi's registries). A test that can only be
satisfied by one implementation is a refactoring tax, not a guarantee.
*Revealed by:* the ~220 impl-pinning invariants — concentrated exactly where refactors
hurt most (clone-identity's 14 pinned `=== nil` file:line sites), thin exactly where the
suite is strongest (provenance: 12 of 258).
*Forbids:* asserting private state when a public observation exists; documentation-as-test
(war-story ledgers belong in docs); vacuous both-outcomes-pass assertions.

---

## Precedence

When principles collide, the order is: **P0 (two-layer coherence) > P10/P11 (provenance
truth) > P4/P5 (membrane strictness) > P8 (algebra uniformity) > P7 (representation
authority) > everything else.** Rationale: the two-layer execution IS the machine — the rest
describe how to keep it running. Provenance is the product; the membrane is what makes
provenance sound; a uniform algebra is what makes the membrane's promises statable; authority
placement is how the first three stay maintainable. Convenience never appears in this list.
