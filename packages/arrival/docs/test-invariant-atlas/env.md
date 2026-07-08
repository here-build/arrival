## core-contract-precision.test.ts
### scheme/core Contract precision — author-asserted type override
- INVARIANT: gensym's harvested signature is `(name?: string) => string` via Contract.type override, not the unknown catch-all [impl-pinning]

## overridable.test.ts
### plain define plus validation, through the consumer door
- INVARIANT: a host-supplied override wins over the in-form default
- INVARIANT: absent params fall back to the in-form default
- INVARIANT: omitting config entirely still resolves defaults (params defaults to {})
- INVARIANT: multiple overridable bindings in one program resolve independently
- INVARIANT: a bad override throws naming the binding, declared type, and source [impl-pinning]
- INVARIANT: a bad default throws exactly as loud as a bad override [impl-pinning]
- INVARIANT: an unrecognized type tag doors naming the binding [impl-pinning]
- INVARIANT: a bare name in tag position is an unbound variable, not a type reference [impl-pinning]
- INVARIANT: a tag lowering to an empty schema doors rather than silently permitting any value [impl-pinning]
- INVARIANT: an /optional-suffixed tag is tolerated and still validates
- INVARIANT: overridable/resolve is callable directly as an ordinary runtime verb
### structured s/* forms: enum, object, optional
- INVARIANT: (s/enum ...) validates an override against its declared value set
- INVARIANT: (s/enum ...) rejects a value outside the declared set [impl-pinning]
- INVARIANT: (s/object ...) validates a structured override field-by-field
- INVARIANT: (s/object ...) rejects an override missing a required field [impl-pinning]
- INVARIANT: a nested (s/optional ...) field inside (s/object ...) is genuinely optional

## polyglot-contract-precision.test.ts
### real exported ops reject wrongly-typed output
- INVARIANT: @? (hasMember) output accepts only a real boolean
- INVARIANT: @keys (memberKeys) output accepts only a string array
- INVARIANT: dict output accepts only an ADict, rejecting a plain object/array/scalar

## polyglot.test-d.ts
### representative fixes decode precisely (type-level, synthetic)
- INVARIANT: @ (readMember)'s contract decodes to SchemeValue, not unknown
- INVARIANT: @? (hasMember)'s contract decodes to boolean, not unknown
- INVARIANT: @keys (memberKeys)'s contract decodes to string[], not unknown
- INVARIANT: dict's contract decodes to Record<string, unknown>, not unknown
### wrong-typed impls must NOT compile (negative proofs)
- INVARIANT: a non-boolean impl must not compile against a z.boolean output contract [impl-pinning]
- INVARIANT: a non-string-array impl must not compile against a z.array(z.string) output contract [impl-pinning]
- INVARIANT: an array-returning impl must not compile against a record output contract [impl-pinning]
- INVARIANT: a non-SchemeValue-returning impl must not compile against a z.value output contract [impl-pinning]

## polyglot.test.ts
### @here.build/arrival/polyglot
- INVARIANT: the polyglot capability installs -> / ~> / compose / pipe idiom macros, and they thread correctly
- INVARIANT: polyglot exports a well-formed SchemePackSpec named "scheme/polyglot" whose prelude defines the -> macro [impl-pinning]
### cross-dialect stdlib completion (Bucket A)
- INVARIANT: str concatenates the display form of every argument
- INVARIANT: mapcar matches R7RS map's argument order
- INVARIANT: remove-if / remove-if-not filter with the predicate sense flipped/kept respectively
- INVARIANT: get-in / assoc-in / update-in perform nested dict access and immutable rebuild, creating missing intermediates on demand
- INVARIANT: zipmap builds a dict pairing keys with values at the same position
- INVARIANT: frequencies builds a dict of element to occurrence count
- INVARIANT: group-by builds a dict of (f element) to matching elements, in order
- INVARIANT: partial fixes leading arguments, returning a function of the rest
- INVARIANT: juxt applies every function to the same arguments, collecting results
- INVARIANT: mapv / filterv return an AVector result [impl-pinning]
- INVARIANT: conj prepends onto a list (successive items land at front) and appends onto a vector
- INVARIANT: into pours from's elements into to via conj
- INVARIANT: rest is a cdr that tolerates a non-pair instead of erroring
- INVARIANT: empty? is #t iff the list/string/vector/dict has no elements
- INVARIANT: first / comp / curry are bound elsewhere, not redefined by polyglot
### dict accessor family (Bucket A)
- INVARIANT: dict-ref reads by keyword, symbol, or string key identically
- INVARIANT: dict-ref returns nil when missing and no default given, or the optional default when supplied
- INVARIANT: dict-ref reads through nested dicts
- INVARIANT: dict-ref errors with a door naming the wrong type on a non-dict receiver [impl-pinning]
- INVARIANT: dict-has-key? is #t iff the key resolves
- INVARIANT: dict-keys / dict-values return proper scheme lists composable with map/filter
- INVARIANT: dict-count returns the number of keys
- INVARIANT: dict->alist / alist->dict round-trip through an alist of (key . value) pairs
- INVARIANT: dict-set doors as an immutability guard rather than existing as a mutating function [impl-pinning]
- INVARIANT: dict-update doors as an immutability guard pointing at update-in [impl-pinning]
- INVARIANT: assoc-ref is an alias of dict-ref with the same key handling and default convention

## srfi.test.ts
### @here.build/arrival/srfi
- INVARIANT: each of SRFI-1/13/43/189/128/26/8/2/235 assembles onto an env and its representative verb runs correctly
- INVARIANT: allSrfi exposes the whole set of 13 capabilities, including srfi-1/13/95/235 [impl-pinning]
### srfi-1 — positional accessors
- INVARIANT: first…tenth pick the nth element of a proper list, including the exact-length boundary
- INVARIANT: first…tenth error when the list is too short for the requested position [impl-pinning]
- INVARIANT: first…tenth return the element as-is, preserving nested structure
- INVARIANT: last / last-pair work correctly on a 1-element list
- INVARIANT: last / last-pair follow SRFI-1 semantics on an improper (dotted) list
### SRFI-95 sort — contract element precision
- INVARIANT: sort's receiver is declared as the representation-blind scheme identity (z.value) [impl-pinning]
- INVARIANT: sort's comparator is declared as an optional callable predicate schema, not unknown [impl-pinning]
- INVARIANT: sort's output is declared as the representation-blind scheme identity (z.value) [impl-pinning]
### SRFI-95 sort — end-to-end behavior
- INVARIANT: sort with no comparator sorts a list by the elements' own total order, container-preserving
- INVARIANT: sort with no comparator sorts a vector, container-preserving
- INVARIANT: sort does not honor an explicit less? comparator correctly — scrambles to the wrong order [fails]

## binding-contract-precision.test.ts
### call-with-values Contract.type override — harvest signature
- INVARIANT: call-with-values's harvested signature names producer/consumer params via Contract.type override, not the unknown catch-all [impl-pinning]
- INVARIANT: values carries no type override — its degraded signature is honest, not a degrade artifact [impl-pinning]

## binding.test-d.ts
### values (type-level, synthetic)
- INVARIANT: the OLD shape decoded flat unknown[]/unknown (historical baseline)
- INVARIANT: the NEW shape decodes to SchemeValue[]/SchemeValue, matching Values.from's real signature
- INVARIANT: a wrong-typed impl must NOT compile against the tightened values contract [impl-pinning]
### call-with-values
- INVARIANT: producer/consumer decode as (...args: unknown[]) => unknown, not any-typed
- INVARIANT: call-with-values's output is z.value — it returns the consumer's result, never void (fixes a real R7RS bug)

## bytevectors-contract-precision.test.ts
### real exported ops reject wrongly-typed args
- INVARIANT: bytevector requires every argument to be a scheme number, rejecting non-number/raw-JS-number args; 0-arg call stays legal
- INVARIANT: bytevector-append requires every argument to be a real ABytevector instance, rejecting raw Uint8Array; 0-arg call stays legal
- INVARIANT: bytevector?'s classifier predicate remains deliberately blind, untouched by this fix
- INVARIANT: every native op in the bytevectors pack has migrated off the fully-degraded contract shape — no stragglers
- INVARIANT: utf8->string / string->utf8 remain precise on their own domains as unaffected siblings
- INVARIANT: the bytevectors pack exports exactly 11 symbols [impl-pinning]

## bytevectors.test-d.ts (type-level, synthetic)
- INVARIANT: the OLD bytevector/bytevector-append shapes decoded flat unknown[]
- INVARIANT: the NEW bytevector shape decodes to ANumeric[]
- INVARIANT: the NEW bytevector-append shape decodes to ABytevector[] on the scheme face
- INVARIANT: a wrong-typed rest element must NOT compile against bytevector's tightened contract [impl-pinning]
- INVARIANT: a wrong-typed rest element must NOT compile against bytevector-append's tightened contract [impl-pinning]

## chars-contract-precision.test.ts
### the 10 comparison ops reject a wrongly-typed element
- INVARIANT: char=? accepts real ACharacter args and rejects raw JS strings
- INVARIANT: char<? accepts real characters and rejects raw JS strings
- INVARIANT: char-ci<? accepts real characters and rejects raw JS strings
- INVARIANT: every one of the 10 char comparison ops accepts 0/1/n real-character arrays and rejects a same-length raw-string array
- INVARIANT: every native op in the chars pack rejects an arbitrary-shape raw-JS-garbage array — no stragglers
- INVARIANT: the chars pack exports exactly 22 symbols [impl-pinning]

## lists-contract-precision.test.ts
### genuinely REFINED schemas reject wrongly-shaped values
- INVARIANT: make-list's output must be a proper list (pair or nil); fill stays representation-blind, k must be a scheme number
- INVARIANT: nth's index must be a real scheme number; obj deliberately stays representation-blind (array|pair polymorphism)
- INVARIANT: list->array's output must be a real array, rejecting a Pair or other non-array value
### STATIC-only fixes (documented, not runtime-provable)
- INVARIANT: cons's car/cdr accept any scheme value at runtime unchanged — the fix is static-only
- INVARIANT: map's head gained a real callable (z.lambda) refinement creating a genuine arity floor, rest/output stay permissive
- INVARIANT: list-tail / list-ref's output stays representation-blind since a sublist/element can be any scheme value
- INVARIANT: list-set! has been doored this session — no longer a native op at all [impl-pinning]
- INVARIANT: list-copy's input/output were already fully precise before this audit
- INVARIANT: memq/assq's search key stays deliberately representation-blind (eq?'s raw identity compare)
- INVARIANT: memv/assq/assv/member/assoc's output models "match or the boxed #f sentinel", requiring a real boxed schemeFalse on the false arm
- INVARIANT: memq's output is tighter than its siblings — genuinely rejects raw JS false and any non-pair value
- INVARIANT: member/assoc accept any scheme value for obj; compare's declared return type is unknown, not boolean
### regression guard: unaffected/already-precise siblings stay untouched
- INVARIANT: list stays fully variadic over scheme values, unchanged
- INVARIANT: length's output must stay representation-blind, not narrowed to a scheme-number union (AHalfBaked case)
- INVARIANT: append/reverse untouched — reverse genuinely rejects a raw JS array; append/list remain fully variadic
- INVARIANT: apply/for-each already migrated to inputRest; apply's head is now a real z.lambda creating a genuine arity floor
### blanket sweep
- INVARIANT: every native/sequence op in the lists pack is precise except the two deliberately fully-polymorphic constructors (list, append) [impl-pinning]
- INVARIANT: the lists pack exports exactly 23 symbols [impl-pinning]
### behavior spot-checks: is_pair-shadow swap is byte-identical at runtime
- INVARIANT: list-tail walks k cdrs by reference; 0 steps returns the list itself unchanged [impl-pinning]
- INVARIANT: list-ref returns the k-th car [impl-pinning]
- INVARIANT: list-copy produces a fresh spine with the same elements, cloning nil to the shared singleton [impl-pinning]
### Contract.type overrides — harvest signature
- INVARIANT: map's harvested signature is fn-first over a representation-agnostic sequence rest, generic over fn's return [impl-pinning]
- INVARIANT: for-each's harvested signature is fn-first over a list-only rest, returning void [impl-pinning]
- INVARIANT: member's harvested signature is obj+list+optional compare returning the matched sublist or #f [impl-pinning]
- INVARIANT: assoc's harvested signature is obj+alist+optional compare returning the matched entry or #f [impl-pinning]

## lists.test-d.ts (type-level, synthetic)
- INVARIANT: cons's car/cdr decode as [SchemeValue, SchemeValue]
- INVARIANT: map's tuple(fixed,rest) contract decodes head+rest as SchemeValue-typed, output as SchemeValue
- INVARIANT: make-list's fill decodes as SchemeValue|undefined, output decodes as a proper list (APair|null)
- INVARIANT: list-tail/list-ref's output decodes as SchemeValue
- INVARIANT: list-set!'s stored 3rd argument decodes as SchemeValue
- INVARIANT: memq/memv/assq/assv/member/assoc's output decodes as SchemeValue | false
- INVARIANT: member/assoc's obj decodes as SchemeValue; compare's declared return type is unknown
- INVARIANT: nth's index decodes as a scheme number, obj deliberately stays unknown
- INVARIANT: list->array's output decodes as SchemeValue[]
- INVARIANT: flatten's output decodes as APair|null|unknown[]
- INVARIANT: the shared inputRest mechanism (apply's declared shape) is unperturbed by any addition in this file [impl-pinning]

## numeric-contract-precision.test.ts
### real exported ops reject wrongly-typed args
- INVARIANT: + accepts scheme numbers and rejects a non-number rest element, both in and out
- INVARIANT: - rejects a wrongly-typed head or tail element
- INVARIANT: quotient rejects a non-scheme-number arg; output is a genuine bigint codec, not unknown
- INVARIANT: abs accepts exact or inexact scheme numbers and rejects a non-number
- INVARIANT: zero?'s output schema models a real boolean, not unknown
- INVARIANT: floor/'s output is a genuine 2-tuple of scheme numbers, rejecting wrong arity or element type
- INVARIANT: truncate/ shares floor/'s 2-tuple output shape
- INVARIANT: inexact/exact's output pins the specific tower member (AInexact vs AExact), rejecting the other
- INVARIANT: every numeric native op's contract has migrated off the degraded fully-unconstrained shape
- INVARIANT: aliased ops (**, %, |, &, ~) bind the identical impl object as their canonical sibling; == and = are deliberately distinct [impl-pinning]
- INVARIANT: the numeric pack exports exactly 81 symbols [impl-pinning]

## numeric.test-d.ts (type-level, synthetic)
- INVARIANT: pure-variadic ops (+) decode rest args and return as ANumeric
- INVARIANT: fixed-head-plus-rest ops (-) decode as [ANumeric, ...ANumeric[]]
- INVARIANT: fixed-2-arity ops (quotient) decode args/return as bigint
- INVARIANT: fixed-1-arity-over-AnyNum ops (abs) decode as number|bigint, not unknown
- INVARIANT: boolean-output predicates (zero?) decode return as boolean, not unknown
- INVARIANT: multi-value output (floor/) decodes as a 2-tuple of ANumeric
- INVARIANT: the shared inputRest/apply mechanism is untouched by the numeric-pack-local additions [impl-pinning]

## strings-contract-precision.test.ts
### 2026-07-05 audit: fixes on the real exported ops
- INVARIANT: string accepts real ACharacter elements, rejecting raw JS strings
- INVARIANT: every one of the 10 string comparison ops accepts real-AString arrays of any arity and rejects a same-length raw-string array
- INVARIANT: string-append accepts real AString elements, rejecting raw JS strings
- INVARIANT: string->list's output must be a proper list, rejecting a raw string
- INVARIANT: list->string's input must be a proper list, rejecting a raw string
- INVARIANT: join's second argument must be a proper list, rejecting a raw string
- INVARIANT: concat (migrated to symbol.rosetta) accepts real AString elements, rejecting raw JS strings
- INVARIANT: no native op in the strings pack accepts an arbitrary-shape raw-JS-garbage array — no stragglers
- INVARIANT: the strings pack exports exactly 32 symbols [impl-pinning]
- INVARIANT: string-map/string-for-each's earlier inputRest fix remains intact — regression pin
### Contract.type overrides — harvest signature
- INVARIANT: string-map's harvested signature is proc-first over a string rest, returning string [impl-pinning]
- INVARIANT: string-for-each's harvested signature is proc-first over a string rest, returning void [impl-pinning]

## strings.test-d.ts (type-level, synthetic)
- INVARIANT: string's element schema decodes to ACharacter[], not unknown[]
- INVARIANT: comparison/string-append/concat's element schema decodes to AString[], not unknown[]
- INVARIANT: string->list/split's list-shaped output decodes to APair|null
- INVARIANT: list->string's list-shaped input decodes to [APair|null]
- INVARIANT: join's second-arg slot decodes as [AString, AListAlike]
- INVARIANT: a wrong-typed char-rest impl must NOT compile against string's tightened contract [impl-pinning]
- INVARIANT: a wrong-typed (bare-string) return must NOT compile against string->list's tightened contract [impl-pinning]
- INVARIANT: a wrong-typed (string) param must NOT compile against list->string's tightened contract [impl-pinning]

## vectors-contract-precision.test.ts
### real exported ops reject wrongly-typed args (z.svector-backed fixes)
- INVARIANT: vector-append's elements must be vector-protocol objects, rejecting a non-vector
- INVARIANT: vector-ref's vec argument must be a vector-protocol object, rejecting a non-vector
- INVARIANT: vector-map's rest (vector) elements must be vector-protocol objects, genuinely variadic over 2+ vectors
- INVARIANT: vector-for-each shares vector-map's rest-precision fix
### sanity: the six fixed ops still accept well-formed calls
- INVARIANT: vector still accepts a flat list of scheme values (static-only precision gain)
- INVARIANT: vector-ref's output stays representation-blind by design
- INVARIANT: vector->list's input stays gated on z.svector while its output stays representation-blind
### Contract.type overrides — harvest signature
- INVARIANT: vector-map's harvested signature is proc-first over a vector rest, returning a new vector [impl-pinning]
- INVARIANT: vector-for-each's harvested signature is proc-first over a vector rest, returning void [impl-pinning]

## vectors.test-d.ts (type-level, synthetic)
- INVARIANT: vector's element schema decodes to SchemeValue[]
- INVARIANT: vector-append's element schema decodes to (AVector|AJSArray)[] on the scheme face
- INVARIANT: vector-ref's vec argument decodes as AVector|AJSArray, not unknown
- INVARIANT: vector-ref/vector->list's output decodes as SchemeValue, representation-blind by design
- INVARIANT: a wrong-typed (string) rest element must NOT compile against vector-map/vector-for-each's tightened contract [impl-pinning]
- INVARIANT: the shared inputRest/apply mechanism stays sound for a non-vector shape [impl-pinning]

## srfi-1-contract-precision.test.ts
### Contract harvest precision — author-asserted type: replaces the z.custom degrade path
- INVARIANT: find's harvested signature recovers arity, arg names, and the List<unknown> receiver via Contract.type override [impl-pinning]
- INVARIANT: filter's harvested signature composes directly from z.lambda's printer image, needing no type override anymore [impl-pinning]

## srfi-13-contract-precision.test.ts
### author-asserted type: recovers the List-of-string domain
- INVARIANT: string-join's harvested signature is (list: List<string>, delimiter?: string) => string via override [impl-pinning]
- INVARIANT: string-tokenize's harvested signature returns List<string> via override [impl-pinning]
- INVARIANT: string-split's harvested signature returns List<string> via override [impl-pinning]
### already-precise ops stay zod-derived (regression guard)
- INVARIANT: string-null?/string-prefix?/string-take/string-reverse keep their exact zod-computed signatures with no redundant override [impl-pinning]
- INVARIANT: string-index/string-count deliberately keep criterion as unknown since the membrane accepts either a char or a one-arg predicate [impl-pinning]

## srfi-95-contract-precision.test.ts
### author-asserted type: replaces the z.custom degrade path
- INVARIANT: sort's harvested signature recovers arity and the optional binary comparator while keeping seq/return representation-blind via override [impl-pinning]

## srfi-95.test.ts
### 2026-07-06 audit — sort's element precision (real exported op)
- INVARIANT: sort's seq slot is wired to a custom (z.value) schema, not the old bare unknown [impl-pinning]
- INVARIANT: sort's optional comparator slot is wired to a callable custom schema, not the old bare unknown [impl-pinning]
- INVARIANT: sort's output is wired to a custom (z.value) schema, not the old bare unknown [impl-pinning]

## Summary

- 23 files covered (6 in `env/__tests__/`, 13 in `env/r7rs/__tests__/`, 4 in `env/srfi/__tests__/`) — full coverage of all three directories.
- 193 invariants named, 64 tagged `[impl-pinning]`, 1 tagged `[fails]` (SRFI-95 `sort` comparator, documented broken).
- Files whose entire purpose is exercising a test-only/synthetic API (not the real exported symbol, per each file's own header caveat — `NativeSymbolDef.in`/`.out` erase `I`/`O` on any real export): `polyglot.test-d.ts`, `binding.test-d.ts`, `bytevectors.test-d.ts`, `lists.test-d.ts`, `numeric.test-d.ts`, `strings.test-d.ts`, `vectors.test-d.ts` — 7 files. These build a hand-mirrored synthetic contract from `scheme-zod.ts` schemas and prove the shared `DecodedArgs`/`DecodedReturn`/`DecodedArgsWithRest` mechanism, not the actual pack export; the runtime-observable half of each fix lives in the sibling `*-contract-precision.test.ts` file. `srfi-95.test.ts` also reaches into a private zod internal (`_zod.def.type`) rather than the public API, but it does target the real exported `sort` symbol.
