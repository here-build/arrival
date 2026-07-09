> **Historical snapshot (2026-07-08, pre-rework v1 suite).** Files named here may be deleted, renamed, or relocated since (G1/G2/G3 — see `../../REWORK-DAG.md` and `../test-suite-v2/REMOVAL-MANIFEST.md`).

## attestation.test.ts
### attestation registry (attest / isAttested / freshIfSingleton)
- INVARIANT: exempt singletons (nil, void, interned symbols, #t/#f) are never marked attested
- INVARIANT: attest is a no-op on non-AValue inputs (raw strings, undefined) — never throws
- INVARIANT: freshIfSingleton clones only the #t/#f flyweights; the clone can be attested independently while the shared singleton itself never becomes attested
- INVARIANT: freshIfSingleton passes non-singleton values (e.g. numbers) through unchanged

### bakeRosetta return walk (stamp site 1)
- INVARIANT: a SOURCE rosetta's return value is attested
- INVARIANT: a boolean SOURCE return is a fresh attested clone, never the shared flyweight, and the flyweight remains unattested
- INVARIANT: a PURE rosetta's return value is never machine-attested
- INVARIANT: a dict return's wrapper is attested and its entries inherit attestation through get
- INVARIANT: repeated get of the same key returns the same cache-stable, attested box
- INVARIANT: a missing dict key plucks the shared nil, which is never attested
- INVARIANT: materializing a JS array inherits attestation onto every element box
- INVARIANT: a source-returned pair is attested at both the spine and every leaf reached via car/cdr
- INVARIANT: a source-returned vector is attested at both the container and every stored element
- INVARIANT: a value produced by ordinary computation or a bare literal (not a source return) is never attested

### attestDeep
- INVARIANT: attestDeep walks a mixed pair/vector spine, attesting every reachable non-exempt value while skipping the shared nil terminator

## collapse-provenance.test.ts
### collapseProvenance — sound over every structured carrier
- INVARIANT: collapseProvenance collects a bare stamped value's own provenance points
- INVARIANT: collapseProvenance deep-walks a Pair list spine, collecting every element's points
- INVARIANT: collapseProvenance deep-walks a Vector's elements
- INVARIANT: collapseProvenance deep-walks an AJSArray's source elements
- INVARIANT: collapseProvenance deep-walks a raw JS array's elements
- INVARIANT: collapseProvenance unions provenance across multiple arguments and nested structures
- INVARIANT: collapseProvenance is idempotent (mints no fresh ids) and cycle-safe on self-referential structures

### string-append / join carry deep collapse-provenance end-to-end
- INVARIANT: join over a list of stamped values preserves every constituent's provenance point
- INVARIANT: string-append over a nested collapse preserves every constituent's provenance point

## deferred-value-egress.test.ts
### deferred egress — the carrier captures its PRODUCING run (ctx can't undo it)
- INVARIANT: a deferred collection carrier's settledness and interval narrow via a microtask callback that fires independent of any active run context

### deferred egress — un-forced escape is structurally detectable
- INVARIANT: an unforced deferred carrier's toJS representation is a structural interval marker, never the collapsed value [impl-pinning]

### deferred egress — the force mechanism force-on-egress will call
- INVARIANT: force() is idempotent — forcing at two separate call sites returns the same memoized promise

### deferred egress — the exec/membrane boundary
- INVARIANT: an eager (non-speculative) map result is materialized before crossing the exec boundary — never a live deferred carrier
- INVARIANT: under speculate:true, a top-level exec result can escape as a live, unforced deferred carrier (documented gap)
- INVARIANT [todo]: exec must materialize a top-level deferred result before returning, even under speculate:true
- INVARIANT [todo]: force-on-egress must be deep — a carrier nested inside a returned pair/vector must be materialized
- INVARIANT [todo]: a carrier forced at egress must carry its producing run's ctx on its materialized elements
- INVARIANT [todo]: after force-at-egress, a carrier holding another run's captured closures is never refined in a later run

## evaluator-provenance.fuzz.test.ts
### fuzz — evaluator crash safety
- INVARIANT: the evaluator never throws an error outside a whitelisted set of expected runtime errors on any well-formed randomly generated expression

### fuzz — provenance algebra invariants at depth
- INVARIANT: nested N-level union-provenance trees round-trip to the same membership as one flat union of all leaf ids, regardless of grouping order
- INVARIANT: re-unioning a union result through itself is a no-op at depth (idempotence)

## golden-prov-arithmetic.test.ts
### GOLDEN — pure ops over literals mint NOTHING (empty provenance)
- INVARIANT: a pure arithmetic/comparison op over only literal operands produces empty provenance

### GOLDEN — pure ops over ONE source propagate it (pipe)
- INVARIANT: a cardinality observation (string-length) propagates its one source's provenance
- INVARIANT: a pure op consuming the same single source multiple times still carries only that source's provenance
- INVARIANT: a pure op merging one source with a literal carries only the source's provenance
- INVARIANT: a unary pure op passes its single source's provenance through unchanged
- INVARIANT: a predicate over a single (possibly repeated) source mints nothing beyond that source

### GOLDEN — arithmetic merges of ≥2 sources UNION their provenance (merge)
- INVARIANT: an op over two or more provenance-bearing operands carries the union of all their provenance
- INVARIANT: a merge over one source and a one-source pipe still unions to just that source
- INVARIANT: three sources combined across two nested op levels union to all three

### GOLDEN — string collapse path (string-append / join) hoists every point
- INVARIANT: string-append/join over stamped strings unions every operand's provenance, including through nested collapses

### GOLDEN — list element-vs-container provenance (car / cdr / cons)
- INVARIANT: cons unions both elements' provenance onto the resulting cell
- INVARIANT: car projects only the head element's provenance
- INVARIANT: cdr of a dotted pair projects only the tail element's provenance
- INVARIANT: car of a proper list projects only the head element's provenance
- INVARIANT: the second-element accessor projects only that element's provenance
- INVARIANT: cons onto an empty tail carries only the head element's provenance

### GOLDEN — documented asymmetries the eager path exhibits TODAY
- INVARIANT: cdr of a proper list returns the unstamped spine cell, carrying empty provenance, unlike cdr of a dotted pair [impl-pinning]
- INVARIANT: append rebuilds the result spine and drops all element provenance [impl-pinning]

### GATE G2 (equivalence) — static lineage must match these eager goldens [TODO: flag unbuilt]
- INVARIANT [todo]: flag-on merge-union provenance for a two-source addition equals the eager golden
- INVARIANT [todo]: flag-on one-source-pipe provenance for a repeated-operand multiplication equals the eager golden
- INVARIANT [todo]: flag-on collapse-path provenance for string-append equals the eager golden
- INVARIANT [todo]: flag-on element-projection provenance for car-of-cons equals the eager golden
- INVARIANT [todo]: flag-on spine-asymmetry provenance for cdr-of-list equals the eager golden
- INVARIANT [todo]: flag-on rebuild-drop provenance for append equals the eager golden
- INVARIANT [todo]: with the flag off, every program in this file is byte-identical to its frozen snapshot

## golden-prov-fan.test.ts
### GOLDEN (G2 oracle) — pure-map length over a Pair source OVER-ATTRIBUTES today
- INVARIANT: length of a pure-mapped Pair source carries every element's provenance [impl-pinning]
- INVARIANT: a mapped list's own spine carries empty provenance — per-element provenance lives on the elements, not the spine

### GOLDEN (G2 oracle) — filter RUNS the predicate; the count carries the survivors
- INVARIANT: length of a filtered Pair carries exactly the surviving elements' provenance
- INVARIANT: a filtered list's own spine carries empty provenance; survivors keep their own ids
- INVARIANT: keeping all elements in a filter carries all elements' provenance in the count
- INVARIANT: keeping no elements in a filter yields empty provenance in the count

### GOLDEN (G2 oracle) — NESTED fan: length of map-over-filter
- INVARIANT: nesting map over filter, the count's provenance equals the filter survivors' provenance
- INVARIANT: nesting map over an all-pass filter, the count carries all elements' provenance

### GATE G2 TARGET — pure-map length cone is grouping-fact-only
- INVARIANT [todo]: the static cone of a pure-map length is the collection-level grouping fact alone, not every element id
- INVARIANT [todo]: the static value of a pure-map length is unchanged by the cone-pruning rewrite

### GATE G2 TARGET — filter is length-CHANGING, so its cone is kept
- INVARIANT [todo]: the static cone of a filter-length includes the predicate's survivor cone — the filter fan is not pruned
- INVARIANT [todo]: nested map-over-filter's static cone equals the inner filter's survivor cone
- INVARIANT [todo]: the static value of a filter-length is unchanged by the rewrite

### GATE G2 TARGET — flag-off is byte-identical to the eager golden
- INVARIANT [todo]: with the flag off, every program above reproduces the eager golden snapshot byte-for-byte

## golden-prov-infer.test.ts
### GOLDEN (G2 oracle) — a single Rosetta-IN crossing MINTS one leaf
- INVARIANT: a Rosetta-IN source crossing mints exactly one fresh provenance point, independent of its literal argument

### GOLDEN (G2 oracle) — a pure pipe over the source PROPAGATES, never re-mints
- INVARIANT: a pure transform over a minted source propagates the same single point without minting a new one
- INVARIANT: a literal operand alongside one minted source contributes no id — remains a single-point pipe, not a merge

### GOLDEN (G2 oracle) — a MERGE of two infer sources fans both points in
- INVARIANT: merging two independently-minted sources unions both minted points

### GOLDEN (G2 oracle) — a FIELD PROJECTION refines a point
- INVARIANT: projecting one field of a multi-field minted source narrows the cone to only that field's id, dropping sibling fields
- INVARIANT: the member-read operator and the keyword accessor narrow the cone identically over the same field projection

### GATE G2 TARGET — the source end matches the eager golden
- INVARIANT [todo]: a Rosetta-IN crossing's static cone equals the eager golden (exactly one mint point)
- INVARIANT [todo]: a pure pipe's static cone over a minted source equals the bare-mint eager golden
- INVARIANT [todo]: a merge's static cone over two minted sources equals the union eager golden
- INVARIANT [todo]: a field projection's static cone equals the projected slot's id alone
- INVARIANT [todo]: with the flag off, every program above equals the eager golden byte-for-byte

## golden-prov-special-forms.test.ts
### GOLDEN — if provenance
- INVARIANT: when the taken arm is positive, the result's provenance is the chosen value's provenance
- INVARIANT: the predicate's provenance taints the result even when the taken arm is a bare literal
- INVARIANT: when both arms are literal, the result's provenance is solely the predicate's source
- INVARIANT: the result's provenance is the union of the predicate's source and the taken arm's source
- INVARIANT: a merge in the taken branch unions with the predicate's source in the result

### GOLDEN — let transparency
- INVARIANT: a let-binding's provenance is identical to the fully inlined/substituted form
- INVARIANT: nested let threads provenance through every binding
- INVARIANT: let* sequential binding is equally transparent to provenance
- INVARIANT: a let body returning a pure literal carries no provenance — an unused binding never leaks

### GOLDEN — cond provenance
- INVARIANT: a matched cond clause's result provenance unions the matched predicate with the taken arm
- INVARIANT: a failed clause's predicate provenance does not leak into the else/later arm
- INVARIANT: a matched clause with a merge arm unions the predicate with both arm operands
- INVARIANT: only the matched clause's predicate contributes when an earlier clause fails
- INVARIANT: with distinct selector sources per clause, only the matched clause's selector id appears

### GATE G2 (static lineage == eager golden on special forms) — W1
- INVARIANT: the static classifier classifies if to a mux whose cone is the predicate unioned with the arms — the predicate is never dropped
- INVARIANT: the static classifier's fullCone reproduces the eager golden for every captured if case
- INVARIANT: the static classifier treats the let family as transparent, matching the eager/inlined golden byte-for-byte
- INVARIANT: the static classifier reproduces the eager golden for a single-matched-clause cond
- INVARIANT: the static cond cone is a conservative superset of the eager cone — it cannot know the taken branch
- INVARIANT [todo]: byte-identical control-flow provenance (failed-clause non-leak, un-taken-arm exclusion) belongs to evaluator wrappers, not the static classifier
- INVARIANT: classify operates on the surface (unexpanded) special-form AST directly, since this engine never macro-expands if/let/cond

## lineage-assumptions.test.ts
### ASSUMPTION — provenance is minted only at Rosetta crossings
- INVARIANT: a pure op over only literals mints no provenance
- INVARIANT: a pure op propagates rather than mints — one source used twice carries just that source
- INVARIANT: an arithmetic merge propagates both sources' provenance

### ASSUMPTION — let is transparent
- INVARIANT: a let form's provenance equals the inlined form's provenance

### ASSUMPTION — a count is identity-entangled today
- INVARIANT: length of a mapped-identity Pair carries every element's provenance

### ASSUMPTION — a pure-map length over-attributes through the live builtins
- INVARIANT: length of a pure-mapped Pair over live builtins carries every element's provenance

### CAPABILITY — eager map/filter/reduce pipelines yield the documented values
- INVARIANT: a map-then-reduce pipeline yields the mathematically correct sum
- INVARIANT: a filter-then-length pipeline yields the correct surviving count
- INVARIANT: a full map-filter-reduce pipeline yields the correct composed result
- INVARIANT: reduce folds right — a non-commutative reducer's result reflects right-fold direction
- INVARIANT: length over a pure-map chain counts elements correctly

### NEXT-STEP assumptions (designed; unblock as the slices land)
- INVARIANT [todo]: a lost race over a pure fan cancels with no observable effect
- INVARIANT [todo]: a race loser that already fired an effect across the membrane is not silently un-fired
- INVARIANT [todo]: a fold carries an accumulator back-edge (sequential) while a fan does not (parallel), visible on the graph
- INVARIANT [todo]: a reduce parallelizes (tree-reduce) iff its reducer is an associative monoid
- INVARIANT [todo]: each ligature fusion preserves both the result and the lineage cone
- INVARIANT [todo]: evaluating an uneval'd lineage chunk round-trips to the original chunk
- INVARIANT [todo]: a write-set intersecting a later read-set is a detectable back-edge through the membrane
- INVARIANT: classify handles let/if as special forms (not applications) — if becomes a mux with predicate-union-arm cone, let is transparent
- INVARIANT: classify operates on the surface AST since this engine dispatches special forms directly without macro-expansion

### v0.1 FINALIZATION GATES (G1–G7)
- INVARIANT [todo]: provenance memory becomes bounded/O(program-structure) under the static-lineage flag, not O(execution-history)
- INVARIANT [todo]: static-path provenance equals eager provenance on real macro-expanded programs; flag-off is byte-identical to today
- INVARIANT [todo]: AValue carries a single lineage-node reference, retiring the per-op accumulation call sites
- INVARIANT [todo]: every downstream provenance consumer (why/where/dag, seal, studio trace viz) works off the new representation
- INVARIANT [todo]: the purity invariant is enforced at runtime, catching a reopened purity-door or secretly-mutating Rosetta
- INVARIANT [todo]: provenance survives map/filter/length/sort across every carrier type with no silent drop
- INVARIANT: a length-preserving vector-map preserves the collection-level grouping provenance fact across repeated maps; count/convert ops drop it to bare scalar/Pair exactly as the eager engine does today [impl-pinning]
- INVARIANT [todo]: the lineage tree carries a per-node op-tag, per-source call-id, and namer hook sufficient to render a flowchart without a representation redesign

## lineage-checkpoint.test.ts
### lineage checkpoint — runtime stamping derives the SAME cone (correctness)
- INVARIANT: the static lineage skeleton's fullCone, computed from bindings with no evaluation, equals the eager interpreter's actual provenance for the same program

### lineage checkpoint — the static skeleton is constant in N
- INVARIANT: eager retained provenance size scales linearly with collection size
- INVARIANT: the static lineage skeleton's node count is constant, independent of collection size
- INVARIANT [todo]: a minimal count-cone over an N-element fan source stays O(1), pending the collection-grouping vs element provenance split

## lineage-classifier-from-env.test.ts
### classifierFromEnv — reproduces the hand-built classifier from live env state
- INVARIANT: a pure rosetta classifies to a pipe node; a default (undeclared-pure) rosetta classifies to a source node that mints
- INVARIANT: a name declared both as a source and marked pure is demoted to a pipe — pure always wins, never mints
- INVARIANT: purity is inherited through the env chain — a parent's pure rosetta is recognized as pure when classified from a child env
- INVARIANT: map classifies as a length-preserving fan, filter as a non-length-preserving fan
- INVARIANT: a pure builtin classifies as a pure merge/pipe application, never as a source or opaque node

## lineage-field.test.ts
### lineage field — member-read syntaxes normalize to a canonical field node
- INVARIANT: the keyword accessor normalizes to a field node with a named-field step over a leaf
- INVARIANT: the member-read operator with a keyword key normalizes to the identical canonical field node as the keyword accessor
- INVARIANT: the member-read operator with a string key normalizes to the same canonical field step as a keyword key
- INVARIANT: the member-read operator with a literal integer key normalizes to a positional index step, same as the indexed accessor
- INVARIANT: car normalizes to a field node with a car step
- INVARIANT: an indexed accessor with a literal index normalizes to a field node with an index step
- INVARIANT: a list-index accessor with a literal index shares the same index step as the vector one
- INVARIANT: a variable (non-literal) index is not statically a field — falls through to a pure op
- INVARIANT: a computed (non-literal) member-read key is not statically a field
- INVARIANT: cdr and its derivatives remain pipes rather than fields — a deliberate sound over-approximation

### lineage field — nested projection ABSORBS to base + INNERMOST step
- INVARIANT: a field nested directly under another field absorbs to the base plus only the innermost step
- INVARIANT: absorption is keyword-priority — a keyword step anywhere in the chain wins over a transparent positional step
- INVARIANT: triple nesting of keyword field accessors absorbs to a single innermost step
- INVARIANT: positional-over-positional nesting with no keyword anywhere keeps only the innermost positional step
- INVARIANT: a keyword step over a positional child nests two levels deep, preserving the inner positional step under the outer keyword
- INVARIANT: a positional step over a keyword child absorbs — the inner keyword wins and the outer index is dropped

### lineage field — fullCone is NEUTRAL vs the pre-change pipe classification
- INVARIANT: fullCone over a field node equals the cone of its base leaf
- INVARIANT: fullCone through a deeper expression containing a field node is unaffected by the field/pipe distinction
- INVARIANT: fullCone through an absorbed nested field still reaches the base leaf's cone

### lineage field — fieldCone descends the matching field, prunes the siblings
- INVARIANT: demanding a field matching the node's own step follows through to the base leaf's cone
- INVARIANT: demanding a field that does not match the node's step prunes to empty
- INVARIANT: a merge is a demand barrier — a field demand cannot be attributed to one child, so the full cone of all children is returned
- INVARIANT: an opaque node is also a demand barrier, sharing the merge's fallback-to-full-cone behavior
- INVARIANT: a mux is not a demand barrier — a matching field demand crosses into both arms and filters them; a non-matching demand prunes both arms while the selector stays constant
- INVARIANT: an index demand and a field demand of the same name-shape are distinct and never cross-match

### lineage field — fan × lens composes PARAMETRICALLY
- INVARIANT: a field projection inside a fan's per-element lambda nests under the fan as a template, without unrolling per element
- INVARIANT: a field projection wrapping a fan's result wraps the fan node while the fan's own template stays nested underneath
- INVARIANT: a dict-construction template inside a fan carries its nested field projection intact, not flattened
- INVARIANT: a bare-function-symbol fan carries no template — behavior is unchanged from the pre-template classifier
- INVARIANT: fullCone over a field-wrapping-a-fan still resolves to the fan's source cone — the template does not affect the cone
- INVARIANT: a fan's template presence is cone-neutral — fullCone and countCone are identical whether or not the template is attached

## lineage-grounding.test.ts
### Gsec — scalar grounding
- INVARIANT: a bare literal value is ungrounded (zero provenance)
- INVARIANT: a source-derived value is grounded (non-empty provenance)
- INVARIANT: a pure pipe over a grounded source remains grounded — propagation never drops provenance to empty

### Gsec — partial fabrication is per-leaf distinguishable
- INVARIANT: in a structure combining one source-derived leaf and one literal leaf, each leaf's own grounding is independently distinguishable — the literal is never laundered as grounded via the union
- INVARIANT: per-leaf grounding distinguishability holds regardless of the literal's position in the structure

### Gsec — a fully-grounded structure has ALL leaves grounded
- INVARIANT: a structure built entirely from source-derived values has every leaf grounded
- INVARIANT: grounding of a fully-sourced structure holds at every depth of nesting

## lineage-shadow.test.ts
### SHADOW — arithmetic
- INVARIANT: for source-free literal/pipe/merge arithmetic programs, the static lineage fullCone equals the eager per-op provenance stamp, which equals the frozen golden

### SHADOW — string-collapse & cons-union
- INVARIANT: for string-length/string-append/join/cons programs, the static cone equals the eager stamp and the frozen golden

### SHADOW — if mux
- INVARIANT: for if-expressions across a spread of predicate/arm-source combinations, the static mux cone equals the eager stamp and golden

### SHADOW — let transparency
- INVARIANT: for let/let*/nested-let forms, the static transparent-substitution cone equals the eager stamp and golden

### SHADOW — cond single-matched-clause
- INVARIANT: for a single-matched-clause cond with a literal else, the static cone equals the eager stamp and golden

### SHADOW — when / unless mux
- INVARIANT: when the guarded body is taken, when/unless's static one-armed-mux cone equals the eager stamp and golden

### SHADOW — bare fan result spine
- INVARIANT: a bare map/filter result's spine carries empty provenance on both the static and eager paths

### SHADOW BOUNDARY — by-design divergences throw under the flag
- INVARIANT: a program whose static cone legitimately diverges from the eager stamp throws a divergence error under the shadow flag rather than silently passing

### SHADOW SKIP — macro-head / keyword-projection forms abstain
- INVARIANT: a keyword-projection-headed form is skipped by the shadow assertion, never compared
- INVARIANT: a macro-headed form is skipped via the macro-head early-return, never reaching the cone comparison

## lineage-spike.test.ts
### static skeleton + pipe/merge/fan from the parsed AST
- INVARIANT: pipe-vs-merge classification falls out of operand arity — two or more provenance-bearing operands classify as merge, one as pipe
- INVARIANT: fullCone aggregates every leaf across a mixed merge/pipe tree

### one tree, two cone queries
- INVARIANT: the same lineage tree answers both fullCone (includes the fan's mint) and countCone (prunes the mint for a length-preserving map) from one representation

### Rosetta-in mints, opaque is holistic
- INVARIANT: a declared Rosetta-in call classifies as a source node that mints
- INVARIANT: an opaque (black-box) call classifies as a holistic merge unioning all its inputs

### count-cone prunes a MAP fan but NOT a FILTER fan
- INVARIANT: countCone prunes a length-preserving (map) fan's introduced mint while fullCone retains it
- INVARIANT: countCone does not prune a length-changing (filter) fan
- INVARIANT: length over a pure filter's countCone still retains the source
- INVARIANT: length over a map fan's countCone still prunes

### if / cond classify to a mux
- INVARIANT: if classifies to a mux whose cone unions the selector with every arm
- INVARIANT: when both if-arms are literal, the cone is the predicate's source alone
- INVARIANT: cond classifies to a mux whose cone unions the matched selector with the arm
- INVARIANT: cond's arrow-arm threads the test's cone into the arm
- INVARIANT: a multi-clause cond's static cone conservatively unions all selectors and all arms, not just the matched ones

### let family is TRANSPARENT
- INVARIANT: let classifies structurally identically to its fully-inlined/substituted equivalent
- INVARIANT: let* threads bindings left-to-right, classifying identically to the fully-substituted form
- INVARIANT: a let body returning a pure literal classifies as a literal with empty cone

### begin / and / or / lambda
- INVARIANT: begin classifies as a pass-through of its last expression only
- INVARIANT: and classifies as a merge unioning all operands with no predicate-taint distinction
- INVARIANT: or likewise unions its operands
- INVARIANT: a lambda literal at its definition site contributes no provenance

### quote / when / unless / letrec(*)
- INVARIANT: quote classifies as a literal with empty cone
- INVARIANT: when classifies as a one-armed mux whose cone unions the predicate with the body
- INVARIANT: unless classifies as a one-armed mux likewise
- INVARIANT: letrec classifies transparently, identical to its inlined merge form
- INVARIANT: letrec* threads bindings left-to-right transparently like let*

### a NAMED let is recursive ⇒ opaque
- INVARIANT: a named let classifies as opaque over its bindings' right-hand-sides and body, not as transparent substitution

## provenance-algebra.property.test.ts
### unionProvenance — algebraic properties
- INVARIANT: unionProvenance is commutative — any permutation of the same arguments yields the same resulting set
- INVARIANT: unionProvenance is associative — left/right grouping of the same arguments yields the same resulting set
- INVARIANT: unionProvenance is idempotent — unioning a value with itself repeatedly yields the same membership as the value alone
- INVARIANT: unionProvenance is monotonic — the result always contains every input's provenance ids
- INVARIANT: unionProvenance treats empty provenance as an identity element

### unionProvenance — reference fast paths
- INVARIANT: unionProvenance over all-empty inputs returns the shared empty-provenance object by reference [impl-pinning]
- INVARIANT: unionProvenance over copies sharing one non-empty provenance reference returns that exact reference [impl-pinning]
- INVARIANT: reference-equal provenance sets dedupe to the shared reference, while value-equal-but-distinct-reference sets merge into a freshly allocated set [impl-pinning]
- INVARIANT: unionProvenance's result size never exceeds the sum of all input provenance sizes

### pointProvenance
- INVARIANT: pointProvenance(id) returns a singleton set containing exactly that id
- INVARIANT: a pointProvenance value unioned with another value's provenance always contributes its id to the result

## provenance-deep-stamp.test.ts
### jsToScheme deep-stamps every constructed AValue
- INVARIANT: a JS array crossing the membrane becomes a borrowed vector wrapper carrying the crossing's provenance, with each lazily-boxed element carrying it too
- INVARIANT: nested JS arrays deep-stamp provenance through every level of lazy borrowing
- INVARIANT: a plain JS object crossing the membrane becomes a wrapper carrying the crossing's provenance, with lazily-boxed entries carrying it too
- INVARIANT: a primitive string crossing the membrane is boxed with the crossing's provenance
- INVARIANT: a primitive number crossing the membrane is boxed (exact or inexact) with the crossing's provenance
- INVARIANT: with empty provenance, jsToScheme preserves prior no-stamp behavior (shared boolean singletons, allocated strings with empty provenance)
- INVARIANT: jsToScheme is an identity fast path on an already-AValue argument with matching or empty provenance — returns the same instance unchanged

### jsToScheme WeakSet cycle protection
- INVARIANT: a self-cyclic JS array does not stack-overflow when crossing the membrane
- INVARIANT: mutually-cyclic plain JS objects terminate when crossing the membrane

### SchemeJSObject.get — cached boundary-validated boxing
- INVARIANT: repeated get reads of the same key return the identical cached AValue instance
- INVARIANT: an entry read via get carries the wrapper's provenance
- INVARIANT: a missing key returns the shared nil
- INVARIANT: writes to the wrapped object are banned and throw, leaving the underlying source unmodified and the cached read stable [impl-pinning]
- INVARIANT: withProvenance produces a wrapper with a fresh, empty cache — cloned entries box independently under the new provenance
- INVARIANT: a sandbox-blocked key (an inherited Object.prototype method) returns nil rather than leaking the foreign method

### dict-ref / @ / :key all route through SchemeJSObject.get
- INVARIANT: the member-read operator and the keyword accessor return the identical cached AValue instance for the same key on the same object

## purity-doors.test.ts
### purity doors — dynamics are omitted
- INVARIANT: every dynamics primitive (call/cc, dynamic-wind, make-parameter, parameterize, delay/force/make-promise/delay-force) throws a PurityError, directly or via cause, with a message naming it as omitted by design [impl-pinning]

### purity doors — writing methods are omitted (entities frozen)
- INVARIANT: every mutating primitive (set-car!, set-cdr!, vector-set!, vector-fill!, vector-copy!, string-set!, string-fill!, bytevector-u8-set!, bytevector-copy!) throws a PurityError with a message naming it as frozen by design [impl-pinning]

### purity doors — non-mutating copies still WORK
- INVARIANT: vector-copy and bytevector-copy succeed and return fresh values rather than being blocked as mutations

## speculative-eval.test.ts
### speculative eval — equivalence (speculate on/off agree)
- INVARIANT: for the motivating filter/length/if program, speculate:true and speculate:false produce the exact same result value
- INVARIANT: the not-enough-case result agrees between speculate on and off
- INVARIANT: a mapped fan's exact count is available up front regardless of speculation setting, agreeing between on and off

### speculative eval — early collapse
- INVARIANT: with a predicate fan whose trailing slots never settle, the speculative path completes as soon as the decisive threshold is reached while the eager path hangs awaiting all slots, though both would agree on the result

## tap.spec.ts
### evaluation tap
- INVARIANT: the evaluator fires exactly one enter/exit pair per parsed, location-bearing form; atoms and bare symbols never fire
- INVARIANT: enter/exit events nest LIFO and each child's parent pointer is the enclosing invocation
- INVARIANT: after a child invocation exits, currentInvocation is restored to the parent — sibling invocations share the same parent, never each other
- INVARIANT: repeated evaluation of the same AST node (e.g. under map) produces multiple invocations that all reference the identical node object
- INVARIANT: exit fires with a value result for a successful form and never carries an error key
- INVARIANT: exit fires with an error result when a form throws, and every entered invocation receives a matching exit
- INVARIANT: for an async form, enter fires immediately but exit fires only after the underlying promise resolves
- INVARIANT: a quoted form's head fires once; the quoted data itself is never traced
- INVARIANT: a macro call site is traced but the macro-expansion-constructed body is never traced [impl-pinning]
- INVARIANT: a nodeFilter that rejects everything suppresses all tap events entirely

## Summary
- Total invariants: 258
- Impl-pinning: 12
- Test-only API (no obvious production semantics): lineage-spike.test.ts, lineage-classifier-from-env.test.ts, lineage-field.test.ts — all three exercise only `classify`/`fullCone`/`countCone`/`fieldCone`/`classifierFromEnv` from the lineage module, which per in-file comments is not wired into any live code path (test-only until a later slice lands the `--ir-lineage` flag).
