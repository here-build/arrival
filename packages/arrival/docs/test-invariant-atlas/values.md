> **Historical snapshot (2026-07-08, pre-rework v1 suite).** Files named here may be deleted, renamed, or relocated since (G1/G2/G3 — see `../../REWORK-DAG.md` and `../test-suite-v2/REMOVAL-MANIFEST.md`). Notably `clone-identity.test.ts` is retired (survivor: `laws/identity.law.test.ts`), `bridge.ts` is dissolved (`2bfefd7455`), and AHalfBaked is dissolved (`90272a0b99`).

## pair-cycle.test.ts
### APair[Symbol.iterator]
- INVARIANT: iterator yields every list element exactly once, in order
- INVARIANT: a single-element list yields once
- INVARIANT: a nil-valued FIRST element is a legitimate element, not the empty-pair sentinel
- INVARIANT: the empty-pair sentinel (car undefined, cdr nil) iterates to an empty sequence [impl-pinning]
- INVARIANT: iterating a self-cyclic spine throws (cycle-detecting watchdog)

### Pair.toJS — one-way array conversion
- INVARIANT: toJS throws on a self-cycle (cdr points at the head)
- INVARIANT: toJS throws on a mutual two-cell cycle
- INVARIANT: toJS throws on a mark_cycles-annotated cycle too — metadata does not exempt it [impl-pinning]
- INVARIANT: a proper list converts to a JS array
- INVARIANT: an improper (dotted) tail folds into the array — no `{__dotted__}` shape
- INVARIANT: a nested list element converts to a nested array
- INVARIANT: a single-element list converts to a one-element array

### Pair.toString cycle handling (uses ref-marker notation — fundamentally different)
- INVARIANT: toString does NOT throw on a self-cycle; renders via `#0=`/`#0#` markers [impl-pinning]
- INVARIANT: toString does NOT throw on a mutual cycle

## pair-structure-algebra.test.ts
### Pair — Functor (harness: functorLaws)
- INVARIANT: map(id) ≡ id, under structuralEqual
- INVARIANT: map(f∘g) ≡ map(f)∘map(g), under structuralEqual

### Pair — Semigroup (list-append)
- INVARIANT: concat is associative: (a⋄b)⋄c ≡ a⋄(b⋄c)
- INVARIANT: concat preserves element order and is pure (operands untouched)

### Pair — Monoid (nil identity)
- INVARIANT: `Pair['arrival/tagless-final/empty']()` is the nil singleton [impl-pinning]
- INVARIANT: right identity: a⋄empty ≡ a
- INVARIANT: left identity: empty⋄a ≡ a (nil's own concat is the identity)

### Pair — Foldable (reduce)
- INVARIANT: reduce sums elements left-to-right, element-first `fn(element, acc)`
- INVARIANT: reduce collects elements in order
- INVARIANT: reduce on the empty-pair sentinel returns the seed with zero fn calls (no phantom element) [impl-pinning]

### Pair — Filterable (filter)
- INVARIANT: filter keeps only elements matching the predicate
- INVARIANT: filter-all-false yields nil
- INVARIANT: filter on the empty-pair sentinel never calls the predicate [impl-pinning]

### Pair — Traversable (traverse)
- INVARIANT: traverse with an identity `of` visits each element once, terminating at nil [impl-pinning]
- INVARIANT: traverse over an applicative (mock array-like) sequences effects via `ap`

### Pair — Applicative (static of)
- INVARIANT: `of(x)` produces a one-element list `(x)` [impl-pinning]

### Pair — recursors terminate on Nil clones (provenance)
- INVARIANT: map over `Pair(1, nil-clone)` produces `(1)`, fn called once, result cdr is a Nil instance [impl-pinning]
- INVARIANT: reduce over `Pair(1, nil-clone)` folds exactly one element

## clone-identity.test.ts
### nil-clone witness sanity (fixture guard, not a bug)
- INVARIANT: a provenance clone of nil is `instanceof Nil`
- INVARIANT: a provenance clone of nil is is_nil-true via `instanceof` (the fixed path)
- INVARIANT: a provenance clone of nil is NOT `=== nil` (heap-distinct from the singleton)
- INVARIANT: a provenance clone carries the supplied provenance set
- INVARIANT: a provenance clone serializes identically to nil (toJS → null, toString → "()")

### membrane.ts — `=== nil` identity-equality sites
- INVARIANT: `isSchemeValue(nil-clone)` must be true [impl-pinning]
- INVARIANT: `toJS(nil-clone)` must be null [impl-pinning]

### rosetta.ts — `=== nil` identity-equality sites
- INVARIANT: `schemeToJs(nil-clone)` must match `schemeToJs(nil)` [fails][impl-pinning]
- INVARIANT: `schemeToJs(Pair(1, nil-clone))` must yield a proper list `[1]`, not a dotted-pair shape [impl-pinning]

### bridge.ts — `=== nil` identity-equality sites
- INVARIANT: `list-copy(nil-clone)` must not alias the input by reference [impl-pinning]
- INVARIANT: `list-copy(Pair(1, nil-clone))`'s tail must not alias the input's tail [impl-pinning]

### fantasy-land-lips.ts — `=== nil` identity-equality sites
- INVARIANT: `mapPair` over a nil-clone tail produces `(1)` only, fn called once [impl-pinning]
- INVARIANT: `filterPair` over a nil-clone tail calls the predicate exactly once [impl-pinning]
- INVARIANT: `reducePair` over a nil-clone tail calls fn exactly once [impl-pinning]
- INVARIANT: `traversePair` over a nil-clone tail calls `of` exactly once at termination, with nil [fails][impl-pinning]

### sandbox-env.ts — `=== nil` identity-equality sites
- INVARIANT: `@` accessor on a nil-clone key returns nil, not a `String(Nil)` property lookup [impl-pinning]
- INVARIANT: `@?` accessor on a nil-clone key returns false, not a `has("()")` lookup [impl-pinning]

### META — provenance clones break identity-equality systematically
- INVARIANT: documents a fixed 14-entry list of known `=== nil` sites requiring migration (war-story record, not a behavioral assertion) [impl-pinning]

## tagless-final-equals.test.ts
### G1 totality — every AValue subtype defines arrival/tagless-final/equals
- INVARIANT: every representative AValue subtype (Nil/Pair/String/Exact/Inexact/Bool/Character/Symbol/Vector/Bytevector/HalfBaked/JSObject) exposes a callable `equals` [impl-pinning]

### G2 Pair Setoid
- INVARIANT: equal proper lists compare equal through the Pair Setoid
- INVARIANT: unequal lists compare unequal
- INVARIANT: a pair compared to a non-pair (scalar or nil) is false
- INVARIANT: nested lists compare structurally (deep equality)
- INVARIANT: self-cyclic pairs compare equal AND terminate
- INVARIANT: mutually-cyclic pairs compare equal AND terminate
- INVARIANT: an explicit `seen` map argument is honored by the Setoid call [impl-pinning]

### G3 Vector Setoid — cyclic vectors terminate
- INVARIANT: mutually-cyclic vectors compare equal AND terminate [impl-pinning]
- INVARIANT: equal acyclic vectors compare equal; unequal vectors differ

### G4 equal? regression — structuralEqual
- INVARIANT: deep nested structures compare true/false correctly via structuralEqual
- INVARIANT: a cyclic list (including self-equality) terminates via structuralEqual
- INVARIANT: a cyclic vector terminates via structuralEqual
- INVARIANT: Pair and Vector both route equality through their own Setoid method [impl-pinning]

### G5 eq?/eqv? landmine — must stay identity/scalar
- INVARIANT: eq?/eqv? on distinct-but-equal lists is #f; equal? is #t
- INVARIANT: eqv? distinguishes exact vs inexact but not exact vs exact

### G6 equality-suite cleanup
- INVARIANT: eqv? over scalars matches exactness/char/bool identity, and treats distinct-instance same-name symbols and nil clones as eqv
- INVARIANT: `eq()`/`eqv()`'s scalar result equals the term's own Setoid result, across all scalar kinds [impl-pinning]
- INVARIANT: memv/assv find a distinct-instance (uninterned) symbol or nil clone by eqv? semantics, and still match numeric values
- INVARIANT: eq/eqv stay pointer-grade on Pairs (not deep) while equal? is deep
- INVARIANT: eq?/eqv? of a boxed SchemeBool vs a raw JS boolean is #f, even though the Setoid itself is representation-blind [impl-pinning]

## half-baked.test.ts
### HalfBaked — cardinality interval
- INVARIANT: a filter-bounded interval starts `[0,N]` and narrows from both ends as slots settle
- INVARIANT: a map/list-bounded interval is an exact point `[N,N]` before any slot settles

### HalfBaked — early decision (the `(>= … 2)` collapse)
- INVARIANT: `decide` resolves true the instant `lo >= k`, with slots still pending
- INVARIANT: `decide` resolves false early once `hi` drops below `k`
- INVARIANT: a decision requiring full settlement resolves once the fan fully settles

### HalfBaked — force / refine fold
- INVARIANT: collection force flattens settled slot payloads into a Pair, dropped slots contribute nothing
- INVARIANT: number force folds to the settled count, boxed as an AExact (never a raw JS number)
- INVARIANT: force is memoized — repeated calls (and refine) return the same promise instance [impl-pinning]

### HalfBaked — invisibility contract
- INVARIANT: `is_half_baked` recognizes a HalfBaked; `is_promise` does not, so arg-evaluation passes it through unawaited [impl-pinning]

## coercion-soundness.test.ts
### G6 sound — element provenance survives map/filter/sort
- INVARIANT: Pair·map preserves every element's provenance box
- INVARIANT: Pair·filter preserves every kept element's box
- INVARIANT: Pair·sort preserves every element's box (only reorders)
- INVARIANT: SchemeVector·filter preserves every element's box

### G6 sound — collectElements over a SchemeVector (repaired)
- INVARIANT: `length(vector)` counts every element and carries their unioned provenance [impl-pinning]
- INVARIANT: `length(AJSArray)` carries element provenance

### G6 golden(eager-parity) — container-grouping drops the research blesses
- INVARIANT: Pair·length drops the container box but carries the elements' provenance
- INVARIANT: Pair·sort drops the container box; element boxes survive [impl-pinning]
- INVARIANT: Pair·map/filter drop the container box; element boxes survive
- INVARIANT: SchemeVector·map crosses out to the auto-wrapping AJSArray — raw values in `.source`, boxed again on Scheme-level access [impl-pinning]

### G6 sound — sort over a SchemeVector (DR4 fix: container-preserving, box-preserving)
- INVARIANT: `sort(vector)` returns a fresh sorted VECTOR with boxes preserved
- INVARIANT: `sort(vector)` actually reorders (reversed input comes back sorted)
- INVARIANT: `map(AJSArray)` delegates to the cross-out Functor, same shape as a native vector's map [impl-pinning]

### G6 — element-projection (car/cdr/assoc) + reduce across carriers
- INVARIANT: `car(Pair)` projects the head element with its box
- INVARIANT: `car(AJSArray)`: loose projects index 0 with its box; strict throws PortabilityError
- INVARIANT: `cdr(Pair)` tail spine carries the remaining element's box
- INVARIANT: `cdr(AJSArray)`: loose returns the rest as a vector (boxes preserved); strict throws
- INVARIANT: `assoc(key, alist)`'s matched pair carries both key and value boxes
- INVARIANT: `car(SchemeVector)`: loose projects index 0 with its box; strict throws
- INVARIANT: `reduce(AJSArray)` folds the borrowed elements via a vector delegation

### vector?/vector-ref dispatch via the tagless protocol (no instanceof reach-around)
- INVARIANT: `vector?` answers #t for both a SchemeVector and a borrowed AJSArray
- INVARIANT: `vector?` gracefully answers #f (not a throw) for a non-vector
- INVARIANT: `vector-ref` dispatches to the operand's own method, boxing a borrowed array's element lazily
- INVARIANT: `vector-ref` on a non-vector throws (the operation form, unlike `vector?`'s #f)
- INVARIANT: the vector op family works uniformly on a borrowed array via protocol dispatch [impl-pinning]
- INVARIANT: the vector codec accepts a borrowed AJSArray or a boxed AVector, rejects a pair

### strict mode gates generic list-ops on a vector (loose tolerates, strict explains)
- INVARIANT: `map(vector)` works in loose mode, throws PortabilityError naming `vector-map` in strict
- INVARIANT: `filter`/`reduce(vector)` are rejected in strict mode (SRFI-1 list-ops)
- INVARIANT: `sort(vector)` is NOT strict-gated (SRFI-132 accepts vectors)
- INVARIANT: a borrowed AJSArray inherits the strict gate via delegation

## symbol.test.ts
### symbol.native — scheme-identity, no validation
- INVARIANT: native infers impl arg/return types as raw scheme values from identity schemas
- INVARIANT: native runs the impl on the raw scheme term with no decode/validate
- INVARIANT: native does not reject a value the identity schema wouldn't accept — no runtime validation

### symbol.rosetta — JS-land, codec decode/encode
- INVARIANT: rosetta infers impl arg/return types as decoded JS values from codecs
- INVARIANT: rosetta decodes scheme args → JS, runs impl, encodes the return → scheme
- INVARIANT: rosetta rejects a bad arg via the input codec (errors-as-doors)
- INVARIANT: rosetta can skip validation but still runs the codec transform
- INVARIANT: rosetta awaits an async impl

### the number codec family — exactness + range + JS-type declared by the codec
- INVARIANT: `z.number` decodes exact/inexact to JS number, encodes return as inexact
- INVARIANT: `z.number` doors an over-range exact integer (no silent precision loss)
- INVARIANT: `z.number` doors a non-integer exact rational
- INVARIANT: `z.integer` decodes a safe int, encodes return as exact
- INVARIANT: `z.integer` doors a non-safe-integer inexact input
- INVARIANT: `z.bigint` decodes to bigint faithfully beyond safe-integer range, encodes as exact
- INVARIANT: `z.bigint` round-trips bigint → scheme → bigint via re-decode

### variadic + multiple values
- INVARIANT: a `z.array` input decodes to variadic impl args
- INVARIANT: a `z.array` output encodes to a multiple-return-values vector

### symbol.notImplemented — errors-as-doors
- INVARIANT: bakes a door entity carrying the symbol's name and teaching reason

### name/doc parsing
- INVARIANT: splits the tagged-template on the first colon, trims, tolerates a missing colon

### type inference (compile-time; documentation only)
- INVARIANT: a wrong-typed native impl is a compile error [impl-pinning] (asserted via `@ts-expect-error`, not runtime)
- INVARIANT: a wrong-typed rosetta impl is a compile error [impl-pinning]
- INVARIANT: a wrong-typed rosetta return is a compile error [impl-pinning]

## symbol.test-d.ts
### SpecInfer — the shared VectorSpec→z.output traversal
- INVARIANT: a tuple spec infers element-wise decoded types as a mutable tuple
- INVARIANT: a single-schema spec infers a bare decoded type, no tuple wrapping
- INVARIANT: a 1-tuple spec stays a 1-tuple (SpecInfer never collapses, unlike DecodedArgs)
- INVARIANT: a variadic (`z.array`) spec infers the bare element-array type

### symbol contract — decoded arg/return inference
- INVARIANT: native infers the impl arg as the SCHEME term type
- INVARIANT: rosetta infers the impl arg as the decoded JS type
- INVARIANT: the number-codec family decodes to each codec's declared JS type
- INVARIANT: a 1-tuple output collapses to a single decoded return, not a 1-tuple
- INVARIANT: a variadic array-ish input infers the element-array as the impl's rest params

### symbol contract — wrong-typed impls must NOT compile
- INVARIANT: a native impl annotated with the wrong arg type fails to compile [impl-pinning]
- INVARIANT: a rosetta impl annotated with the wrong arg type fails to compile [impl-pinning]
- INVARIANT: a rosetta impl returning the wrong type fails to compile [impl-pinning]

### symbol contract — inputRest: a fixed head + a separately-typed variadic tail
- INVARIANT: head and rest genuinely differ in inferred type (`DecodedArgsWithRest`)
- INVARIANT: a Pair head + SchemeValue rest infers correctly
- INVARIANT: no-rest (`Rest=undefined`) is byte-identical to plain `DecodedArgs` [impl-pinning]
- INVARIANT: apply's declared shape (SchemeValue head + SchemeValue... tail) infers correctly
- INVARIANT: a wrong-typed rest param fails to compile [impl-pinning]

### symbol contract — 2026-07-05 audit: for-each/string-map/string-for-each head+rest precision
- INVARIANT: the OLD flat-array shape decoded with no head/tail distinction [impl-pinning]
- INVARIANT: the NEW for-each shape infers `[callable, ...(Pair|Nil)[]]`, not a flat array
- INVARIANT: the OLD string-map/for-each shape decoded to flat `unknown[]` [impl-pinning]
- INVARIANT: the NEW string-map/for-each shape infers `[callable, ...AString[]]`

### symbol contract — 2026-07-05 audit: filter's contract narrows to a fixed 2-tuple
- INVARIANT: the OLD open-ended tuple+rest shape decoded unbounded [impl-pinning]
- INVARIANT: the NEW fixed 2-element array decodes to a fixed `[pred, seq]` tuple

### symbol contract — 2026-07-05 audit: find's predicate + return precision
- INVARIANT: the OLD predicate slot decoded to bare `unknown` [impl-pinning]
- INVARIANT: the NEW predicate slot decodes as a callable schema
- INVARIANT: the OLD output collapsed to bare `unknown` [impl-pinning]
- INVARIANT: the NEW output collapses to `SchemeValue`
- INVARIANT: a bare-string return not a member of `SchemeValue` fails to satisfy the fixed contract [impl-pinning]

### symbol contract — 2026-07-05 audit: typecheck's fixed 4-tuple
- INVARIANT: the OLD shape decoded an unbounded tail instead of one genuinely-optional slot [impl-pinning]
- INVARIANT: the NEW shape is exactly 4 positions, with the 4th admitting undefined
- INVARIANT: a 5th argument no longer compiles [impl-pinning]

### symbol contract — 2026-07-05 audit: negative proofs
- INVARIANT: a wrong-typed rest element for string-map/string-for-each fails to compile [impl-pinning]

### symbol contract — 2026-07-05 audit: curry's contract
- INVARIANT: the OLD curry shape decoded leading args as bare `unknown` [impl-pinning]
- INVARIANT: the NEW curry shape decodes leading args as `SchemeValue`
- INVARIANT: a wrong-typed rest param for curry fails to compile [impl-pinning]

### symbol.sequence — impl args/return typed via SpecInfer-built types
- INVARIANT: a correctly-typed sequence impl's args/return match the contract's decoded shape
- INVARIANT: a wrong-typed sequence impl fails to compile [impl-pinning]

### AEntity — the baked, discriminated union
- INVARIANT: a baked native def is a member of the `AEntity` union [impl-pinning]
- INVARIANT: `AEntity` is exactly the 8-way discriminated union — a bare `{value:unknown}` binding is excluded [impl-pinning]

## scheme-string-structure-algebra.test.ts
### SchemeString — Semigroup (harness)
- INVARIANT: string-append concat is associative

### SchemeString — Functor (harness)
- INVARIANT: char-map identity: map(id) ≡ id
- INVARIANT: char-map composition: map(f∘g) ≡ map(f)∘map(g)

### SchemeString — Monoid (harness)
- INVARIANT: left identity: `""`⋄a ≡ a
- INVARIANT: right identity: a⋄`""` ≡ a

### SchemeString — structure-algebra behavior
- INVARIANT: concat appends underlying strings
- INVARIANT: `empty()` produces the empty string [impl-pinning]
- INVARIANT: `of(value)` stringifies into a SchemeString [impl-pinning]
- INVARIANT: map transforms each character
- INVARIANT: map iterates by code point — astral chars map as single graphemes
- INVARIANT: concat is pure (operands untouched)

## scheme-vector-algebra.test.ts
### SchemeVector — Setoid (harness)
- INVARIANT: reflexivity, reflexivity-across-clone, symmetry, transitivity of vector equality

### SchemeVector — Semigroup (harness)
- INVARIANT: vector concat is associative

### SchemeVector — Functor (harness)
- INVARIANT: map identity and composition hold under the boxed (materialized-access) equality [impl-pinning]

### SchemeVector Setoid/Semigroup/Functor — boundaries
- INVARIANT: structural value equality holds over distinct heap payloads
- INVARIANT: nested-vector equality recurses through structuralEqual
- INVARIANT: a raw JS array is NOT equal to a SchemeVector
- INVARIANT: concat appends elements and is length-additive
- INVARIANT: map crosses out to the auto-wrapping AJSArray, leaving the source vector untouched [impl-pinning]
- INVARIANT: `toJS`/TO_JS unwrap a vector to a raw JS array

## scheme-vector-serialization.test.ts
### boxed vector/bytevector — Scheme→JS serialization (schemeToJs)
- INVARIANT: a boxed vector unwraps to a raw JS array, no object-shape leak
- INVARIANT: a nested boxed vector unwraps recursively
- INVARIANT: a boxed bytevector unwraps to its Uint8Array

### boxed vector — provenance propagation (jsToScheme)
- INVARIANT: jsToScheme deep-stamps provenance onto both the container and each element [impl-pinning]

## scheme-bool-algebra.test.ts
### SchemeBool — Setoid (harness; entire file is harness-only, no local assertions)
- INVARIANT: reflexivity, reflexivity-across-clone, symmetry, transitivity of boolean equality

## scheme-bytevector-algebra.test.ts
### SchemeBytevector — Setoid/Ord/Semigroup (harness)
- INVARIANT: reflexivity/symmetry/transitivity of bytevector equality, incl. distinct-heap clones
- INVARIANT: reflexivity/totality/antisymmetry/transitivity of lexicographic bytevector ordering
- INVARIANT: bytevector concat is associative

### SchemeBytevector Setoid/Ord/Semigroup — boundaries
- INVARIANT: value equality holds over distinct heap payloads
- INVARIANT: a non-SchemeBytevector other is unequal and incomparable (false for equals and lte)
- INVARIANT: lte: a proper prefix precedes its extension
- INVARIANT: lte: the first differing byte decides, unsigned comparison
- INVARIANT: concat appends bytes and is length-additive
- INVARIANT: TO_JS/toJs unwrap to the raw Uint8Array

## scheme-string-algebra.test.ts
### SchemeString — Setoid/Ord (harness)
- INVARIANT: reflexivity/symmetry/transitivity of string equality, incl. distinct-heap clones
- INVARIANT: reflexivity/totality/antisymmetry/transitivity of lexicographic string ordering

### SchemeString Setoid/Ord — totality boundaries
- INVARIANT: value equality holds over distinct heap instances
- INVARIANT: equals is representation-blind (a boxed string equals content-identical plain JS string); lte stays type-strict
- INVARIANT: lexicographic lte agrees with JS string ordering

## scheme-symbol-algebra.test.ts
### SchemeSymbol — Setoid/Ord (harness; entire file is harness-only, no local assertions)
- INVARIANT: reflexivity/symmetry/transitivity of symbol equality (by `__name__`), incl. distinct-heap clones [impl-pinning]
- INVARIANT: reflexivity/totality/antisymmetry/transitivity of lexicographic symbol-name ordering

## string-contains.test.ts
### string-contains? — boolean predicate
- INVARIANT: true when the substring is present, false when absent
- INVARIANT: the boolean result carries the provenance of the searched string

### string-contains — SRFI-13 index-or-#f
- INVARIANT: returns the index of the first occurrence
- INVARIANT: returns #f when absent; index 0 is still truthy (only #f is false)

## boolean-landmine-regression.test.ts
### boolean landmine — find/filter (stdlib, THE documented landmine)
- INVARIANT: filter excludes elements whose boxed SchemeBool predicate is #f (raw JS truthiness would keep them)
- INVARIANT: find returns the first match under a boxed SchemeBool predicate
- INVARIANT: find returns nil (not a phantom match) when the predicate is #f for all

### boolean landmine — complement (bridge): async + boxed-bool
- INVARIANT: complement of an async scheme-lambda boxed-bool predicate correctly negates through filter
- INVARIANT: complement still works for a native (non-boxed) predicate
- INVARIANT: complement applied directly to a boxed-#f predicate is truthy

### boolean landmine — not / is_false honor SchemeBool
- INVARIANT: `not` correctly inverts a boxed SchemeBool result (not a raw JS `!`)
- INVARIANT: `if`/`cond` treat a boxed SchemeBool(false) as falsy

### boolean landmine — member/assoc (bridge): guard the cmp defuse
- INVARIANT: member finds an element by equal?
- INVARIANT: assoc finds a pair by key

## equality-representation.test.ts
### equality contract — boxed ≡ unboxed (representation-blind)
- INVARIANT: string equality is representation-blind (boxed≡unboxed, symmetric) and content-discriminating
- INVARIANT: boolean equality is representation-blind (boxed≡unboxed) and content-discriminating
- INVARIANT: number equality requires boxed≡boxed and preserves the exact/inexact grade (1 ≠ 1.0); NOT representation-blind to plain JS numbers by design
- INVARIANT: character and symbol equality is content-discriminating (boxed≡boxed)

## comparison-divergence.test.ts
### numeric core — identical in both modes (no divergence)
- INVARIANT: numeric `<`/`=`/`<=`/`>`/n-ary chains compute by value in both strict and loose modes, never JS-lexicographic

### LOOSE: universal ordering
- INVARIANT: strings/chars/symbols order via their own `lte`, without needing `string<?`

### LOOSE: nil-as-bottom (F2)
- INVARIANT: orderings treat nil as strictly less than every non-nil value
- INVARIANT: `=` is nil-punning: nil=nil is #t, nil vs anything else is #f

### LOOSE: cross-type throws
- INVARIANT: incompatible cross-type comparisons throw, never JS coercion

### `=` stays NUMERIC
- INVARIANT: both strict and loose modes reject a non-numeric `=` comparison

### STRICT = R7RS divergence probe
- INVARIANT: strict mode rejects loose-only-typed comparisons (R7RS-numeric only)
- INVARIANT: the same expressions resolve successfully in loose mode (documents the divergence)

### sort shares the nil-as-bottom order (F2 lives in one place)
- INVARIANT: sort places nil at the front, then ascending order

## vector-cycle-equal.test.ts
### equal? on cyclic vectors terminates (cycle-safety regression)
- INVARIANT: two distinct reader-built self-cyclic vectors compare without a stack blow (verdict itself unconstrained)
- INVARIANT: a self-cyclic vector compared to itself terminates
- INVARIANT: acyclic vector inequality still works correctly

## vector-map-promise-leak.test.ts
### vector/string map+for-each await async procs (no raw Promise leak)
- INVARIANT: `vector-map` with an async proc yields settled values, never `[object Promise]`
- INVARIANT: `string-map` with an async proc yields settled chars, never `[object Promise]`
- INVARIANT: `vector-for-each` with an async proc awaits completion before returning

## srfi-13-strings.test.ts
### string-null? — emptiness predicate
- INVARIANT: #t on the empty string, #f otherwise

### string-prefix?/string-suffix? — SRFI-13 affix-first argument order
- INVARIANT: prefix/suffix predicates match correctly, empty prefix always matches
- INVARIANT: the boolean result carries the provenance of the searched string

### string-index — index of first match, or #f
- INVARIANT: a char criterion finds the index or #f
- INVARIANT: index 0 is a real truthy index — #f is the only false value
- INVARIANT: a predicate criterion (scheme callable) finds the index
- INVARIANT: the empty string never matches

### string-count
- INVARIANT: char and predicate criteria count matching characters correctly

### string-take/string-drop and the -right twins
- INVARIANT: normal slices extract the correct substring
- INVARIANT: n=0 and n=length are valid boundary slices
- INVARIANT: an out-of-range n is an error (SRFI-13, not silent truncation)
- INVARIANT: slices carry the source string's lineage

### string-trim family
- INVARIANT: default trim removes whitespace at both/left/right
- INVARIANT: a char criterion trims that char
- INVARIANT: a predicate criterion trims matching chars
- INVARIANT: an all-matching or empty string trims to empty

### string-pad/string-pad-right — to EXACTLY len (SRFI-13 truncation)
- INVARIANT: pads with space on the correct side by default
- INVARIANT: a custom pad char is honored
- INVARIANT: pad truncates when too long — `string-pad` keeps the tail, `string-pad-right` keeps the head
- INVARIANT: len equal to the string's length is identity

### string-reverse
- INVARIANT: reverses the string; empty stays empty

### string-join
- INVARIANT: joins with the default (space) or an explicit delimiter
- INVARIANT: an empty list folds to the empty string
- INVARIANT: the joined result re-stamps the union of every element's lineage

### string-tokenize — maximal runs of TOKEN chars
- INVARIANT: default tokenizes non-whitespace runs
- INVARIANT: a criterion selects which chars count as token chars
- INVARIANT: no matching tokens yields `'()`

### string-split — SRFI-152 literal-delimiter split
- INVARIANT: splits on a literal string delimiter
- INVARIANT: an absent delimiter yields the whole string as one field
- INVARIANT: an empty subject yields `'()` (SRFI-152 refinement over JS `.split`)
- INVARIANT: a trailing delimiter keeps the empty trailing field (JS `.split` semantics)
- INVARIANT: split pieces carry the source string's lineage
- INVARIANT: a character delimiter is accepted, behaviorally identical to the string form
- INVARIANT: a character delimiter still taints pieces with the source string's lineage
- INVARIANT: a non-string, non-character delimiter errors via the type-mismatch door

## srfi-28-format.test.ts
### format — SRFI-28 proper
- INVARIANT: a directive-free string is returned verbatim
- INVARIANT: `~a` substitutes display-style; `~s` write-style; `~d` decimal; `~%` newline; `~~` literal tilde
- INVARIANT: mixed directives fill arguments in order

### format — ~F/~w,dF fixed-point (SRFI-48 bounded subset)
- INVARIANT: `~,Nf` renders N decimal places with no width
- INVARIANT: bare `~f` free-format renders with no width/decimals
- INVARIANT: `~w,df` applies both width and decimals, left-padded
- INVARIANT: width-only `~wf` (no comma) is accepted, left-padded
- INVARIANT: an unsupported SRFI-48 directive (`~r`) errors, naming `~F` in the supported set
- INVARIANT: `~F` and `~f` are case-insensitive and behave identically
- INVARIANT: `~,Nf` on a non-number argument errors, naming the directive
- INVARIANT: rounding follows `toFixed` semantics [impl-pinning]

### format — ~s vs ~a on a string
- INVARIANT: `~a` renders a string bare; `~s` renders it quoted
- INVARIANT: `~s` escapes embedded quotes and backslashes (re-readable write form)

### format — SRFI-48/CL #f destination
- INVARIANT: `(format #f fmt args...)` returns the same string as SRFI-28's plain form
- INVARIANT: a non-string second arg with `#f` destination is an error

### format — non-#f destinations are teaching doors
- INVARIANT: `#t` destination is rejected with an IO-teaching message (string-only, no IO surface)
- INVARIANT: any non-string/non-#f/non-#t destination is rejected the same way

### format — directive and arity errors are clear
- INVARIANT: an unknown directive names itself and lists the five supported directives
- INVARIANT: a dangling `~` at end-of-string is an error
- INVARIANT: too few or too many arguments for the directives is an error
- INVARIANT: `~d` on a non-number argument is an error
- INVARIANT: calling `format` with no arguments at all is an error

### format — provenance (collapsing op)
- INVARIANT: the result carries a single arg's lineage
- INVARIANT: the result carries the deep union of multiple stamped args' lineage
- INVARIANT: a literal-only format still produces a boxed AString with empty (not absent) provenance

## dict.test.ts
### dict constructor
- INVARIANT: `(:key (dict :k v …))` reads back the constructed key/value pairs
- INVARIANT: `(dict)` with no pairs behaves as empty — a missing-key accessor yields nil/absent

### dict? predicate
- INVARIANT: `dict?` is #t for a `(dict ...)`-constructed value
- INVARIANT: `dict?` is #t for a quoted `{...}` reader dict-literal (AJSObject dictForms node) [impl-pinning]
- INVARIANT: `dict?` is #f for a list, string, vector, number, boolean, or nil

## keyword-syntax.test.ts
### LIPS Keyword Syntax Investigation (exploratory — several assertions are vacuous / log-only, not real invariants)
- INVARIANT: bare `:keyword` either evaluates or throws "Unbound variable" (non-asserting; both outcomes pass) [impl-pinning]
- INVARIANT: `(:password obj)` keyword-as-accessor syntax returns the object's field value
- INVARIANT: quoted `':keyword` is merely logged, no assertion made (non-asserting)
- INVARIANT: accessor-syntax comparison across string/quoted-symbol/bare-symbol/escaped-symbol forms is logged only, no assertion made (non-asserting)
- INVARIANT: an escaped `|24|` symbol used as a binding name round-trips through `list`
- INVARIANT: a keyword accessor works as the mapping function in `map`
- INVARIANT: a keyword accessor works as the predicate in `filter`
- INVARIANT: a keyword accessor on a missing key returns an ANil instance [impl-pinning]

## Summary

- **Total named invariants:** ~230 across 28 files.
- **impl-pinning count:** ~62 (concentrated in `clone-identity.test.ts` — nearly every test pins an exact file:line `=== nil` site or private-method existence; `coercion-soundness.test.ts` — pins `AJSArray`/`asVector` internal impersonator shape; `pair-cycle.test.ts`/`tagless-final-equals.test.ts`/`scheme-vector-algebra.test.ts` — mutate `readonly`/private fields (`cdr`, `__vector__`) via `@ts-expect-error` to force cycles; `symbol.test-d.ts` — every negative proof is inherently a compile-time pin).
- **Files whose entire purpose is exercising a test-only/harness API** (no independent local assertions beyond invoking a shared law-suite or type-proof function):
  - `scheme-bool-algebra.test.ts` (pure `setoidLaws` call)
  - `scheme-symbol-algebra.test.ts` (pure `setoidLaws`/`ordLaws` calls)
  - `symbol.test-d.ts` (entire file is `expectTypeOf`/`@ts-expect-error` compile-time proof, never executed at runtime)
  - `keyword-syntax.test.ts` is a partial case: ~half its `it` blocks are console.log-driven investigation with vacuous `expect(true).toBe(true)` assertions rather than real invariants.
