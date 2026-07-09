> **Historical snapshot (2026-07-08, pre-rework v1 suite).** Files named here may be deleted, renamed, or relocated since (G1/G2/G3 — see `../../REWORK-DAG.md` and `../test-suite-v2/REMOVAL-MANIFEST.md`). Notably the LAMBDA brand is deleted (B5, `a484d7c1ab`) and the exit convention is R1's uniform plain-JS exit.

## membrane.spec.ts
### Wrapper Layer > isSchemeValue
- INVARIANT: nil is recognized as a scheme value
- INVARIANT: native AValue subtypes (AExact, AInexact, AString, ASymbol, APair) are recognized as scheme values
- INVARIANT: wrapper types (AJSObject) are recognized as scheme values
- INVARIANT: JS primitives/objects/null/undefined are rejected as scheme values

### Wrapper Layer > isBytevectorLike
- INVARIANT: Uint8Array/ArrayBuffer/DataView are recognized as bytevector-like
- INVARIANT: non-binary types (array/object/string) are rejected as bytevector-like

### Wrapper Layer > fromJS
- INVARIANT: null converts to nil; undefined converts to #void
- INVARIANT: JS primitives (bool/number/string/bigint) materialize into boxed AValue subtypes, never a raw leak
- INVARIANT: a registered symbol (Symbol.for) materializes to ASymbol; a unique symbol materializes to #void
- INVARIANT: fromJS refuses an already-boxed scheme value, throwing "already-boxed" [impl-pinning]
- INVARIANT: arrays are borrowed as AJSArray keeping source identity
- INVARIANT: bytevector-like types pass through unchanged
- INVARIANT: Promises pass through unchanged
- INVARIANT: a borrowed function materializes to #void (not callable, not portable)
- INVARIANT: a non-portable-value materialization emits a console.warn; setMembraneWarnings(false) silences it [impl-pinning]
- INVARIANT: plain objects wrap into AJSObject preserving source identity
- INVARIANT: fromJS caches identity — same input object returns the same wrapper instance
- INVARIANT: fromJS refuses re-entry of an already-wrapped value — double-wrapping is impossible [impl-pinning]

### Wrapper Layer > toJS
- INVARIANT: nil converts to null
- INVARIANT: AJSObject unwraps to its exact source object
- INVARIANT: AString converts to a JS string
- INVARIANT: AExact (safe integer) converts to a JS number
- INVARIANT: AInexact converts to a JS number
- INVARIANT: primitives (AExact/AString/ABool) pass through toJS with unchanged value
- INVARIANT: ASymbol converts via its own protocol to a quoted-name string ("'foo") [impl-pinning]
- INVARIANT: APair converts to a JS array

### Wrapper Layer > SchemeJSObject
- INVARIANT: AJSObject exposes the "arrival/toJS" protocol key [impl-pinning]
- INVARIANT: .get(key) lazily boxes property values into AValue subtypes, inheriting the wrapper's provenance
- INVARIANT: .set()/.delete() are rejected — membrane is read-only, throwing "writes are banned"/"mutations are banned"; nothing crosses the boundary [impl-pinning]
- INVARIANT: a function-valued field materializes to #void on read; getters are invoked and their result boxed
- INVARIANT: .has() reflects own-property existence only
- INVARIANT: .has() blocks Object.prototype-inherited properties (toString/hasOwnProperty/constructor)
- INVARIANT: .keys() returns own enumerable keys
- INVARIANT: .toString() returns the fixed placeholder "#<js-object>" [impl-pinning]

### Wrapper Layer > Identity Preservation (roundtrip)
- INVARIANT: object identity is preserved through the fromJS→toJS roundtrip
- INVARIANT: a borrowed function does not round-trip — it materializes to #void
- INVARIANT: array identity is preserved through the borrow (.source + toJS roundtrip)
- INVARIANT: Uint8Array identity is preserved (pass-through)

## membrane-symmetry.test.ts
### AValue.fromJs — boxer dispatch produces the expected subtype per typeof tag
- INVARIANT: string → SchemeString via boxer dispatch
- INVARIANT: a safe-integer number → SchemeExact
- INVARIANT: a float number → SchemeInexact
- INVARIANT: bigint → SchemeExact regardless of size
- INVARIANT: boolean with empty provenance reuses the schemeTrue/schemeFalse singletons [impl-pinning]
- INVARIANT: boolean with non-empty provenance mints a fresh ABool carrying that provenance
- INVARIANT: null → ANil instance
- INVARIANT: undefined → AVoid instance
- INVARIANT: array → borrowed AJSArray vector, boxing lazily on access [impl-pinning]
- INVARIANT: plain object → AJSObject wrapper preserving source
- INVARIANT: function → #void — the boxer registry never mints a callable wrapper
- INVARIANT: a LAMBDA-branded function passes through jsToScheme by identity (already a scheme value) [impl-pinning]
- INVARIANT: an unbranded (borrowed host) function still voids through jsToScheme
- INVARIANT: AValue input with empty provenance is returned by identity (fast path)
- INVARIANT: AValue input with non-empty provenance is cloned via withProvenance, carrying the new provenance [impl-pinning]

### jsToScheme → schemeToJs round-trip
- INVARIANT: a string is boxed into AString by jsToScheme
- INVARIANT: string round-trips by passthrough (raw in, raw out)
- INVARIANT: number round-trips by passthrough
- INVARIANT: boolean round-trips by passthrough
- INVARIANT: array round-trips through a Pair chain
- INVARIANT: nested array round-trips
- INVARIANT: plain object round-trips
- INVARIANT: nested object round-trips
- INVARIANT: null does NOT round-trip symmetrically (jsToScheme(null)→nil, schemeToJs(nil)→nil singleton, not null) [fails]

### isSchemeValue completeness — every native AValue subtype is recognised
- INVARIANT: every native AValue subtype (String/Symbol/Character/Exact/Inexact/Bool/Pair/nil/JSObject) is recognized as a scheme value
- INVARIANT: a Nil clone (via withProvenance) is recognized as a scheme value
- INVARIANT: plain JS values (string/number/object/array/null/undefined) are NOT scheme values

### membrane fromJS / toJS — round-trip + wrapper-cache identity
- INVARIANT: a string primitive round-trips through fromJS/toJS
- INVARIANT: a number primitive round-trips through fromJS/toJS
- INVARIANT: bigint materializes to AExact and round-trips to a JS number (bigint-vs-number is normalized away)
- INVARIANT: null round-trips through nil to null
- INVARIANT: an object round-trips through AJSObject preserving the exact source reference
- INVARIANT: a borrowed function does not cross the membrane — materializes to #void
- INVARIANT: the wrapper cache returns the same wrapper instance for the same JS object

## sandbox-escape.test.ts
### CRITICAL: sandbox escape vectors
- INVARIANT: eval defaults to the sandbox env, not global_env, when no env arg is given — and since eval no longer exists at all, the lookup fails Unbound [impl-pinning]
- INVARIANT: an eval-escaped function cannot be invoked to perform host computation
- INVARIANT: host-language verbs (load/set-obj!/new/instanceof) are unreachable via eval
- INVARIANT: SchemeString is marked as an interop/sandbox boundary so its grafted String.prototype methods don't leak past the prototype-chain walk [impl-pinning]

### CRITICAL: accessor isolation leaks
- INVARIANT: :keyword-plucking "constructor" off a lambda does not leak the Function constructor
- INVARIANT: :keyword-plucking "__proto__"/"prototype" off a lambda is blocked
- INVARIANT: accessMember (the live dot-notation/membrane read policy) blocks raw constructor/__proto__/prototype access and inherited built-in proto methods, while benign own-property access still resolves
- INVARIANT: benign :keyword and dot access on a plain object still resolves through the sandboxed env

### CRITICAL: resource exhaustion (DoS vectors)
- INVARIANT: make-string with an oversized length errors fast (O(1)) instead of allocating ~200MB
- INVARIANT: make-vector with an oversized length errors or completes fast, with no host hang
- INVARIANT: an infinite loop (`(let loop () (loop))`) is bounded by a wall-clock budget (budgetMs) and throws a budget error
- INVARIANT: interned-symbol minting is heap-bounded and charged per run-context; a flyweight hit (re-minting the same name) is free and identity-equal; distinct run contexts intern independently
- INVARIANT: deeply-nested input throws a graceful parse error, never a native "Maximum call stack" message
- INVARIANT: equal? on cyclic structures never throws a native JSON circular-structure error — it returns a boolean or a scheme-level error

### registry poisoning vectors
- INVARIANT: AValue is not reachable from the sandbox via direct lookup
- INVARIANT: AValue is not reachable from the sandbox via (eval (quote AValue))
- INVARIANT: the boxer-registry writer (registerBoxer/fromJs) is not reachable from the AValue class — both are undefined on it [impl-pinning]

### CRITICAL: write-side prototype pollution (S6)
- INVARIANT: minting a symbol named "__proto__"/"constructor"/"prototype" does not pollute Object.prototype
- INVARIANT: accessSet rejects "__proto__"/"constructor"/"prototype" as blocked keys
- INVARIANT: accessSet installs an own data property without firing inherited/poisoned setters
- INVARIANT: the INTEROP_BOUNDARY sentinel is not forgeable via the global Symbol registry (module-local Symbol, never equal to any Symbol.for key) [impl-pinning]

## sandbox-boundary.spec.ts
### sandboxedAccess
- INVARIANT: accessMember returns own properties
- INVARIANT: accessMember returns the NOT_FOUND sentinel for missing properties [impl-pinning]
- INVARIANT: accessMember returns NOT_FOUND for null/undefined targets
- INVARIANT: accessMember throws InteropAccessError for blocked property names (constructor/__proto__/prototype)
- INVARIANT: accessMember throws InteropAccessError for Object.prototype-inherited properties (toString/hasOwnProperty/valueOf)
- INVARIANT: accessMember allows inherited properties from non-boundary prototypes
- INVARIANT: accessMember blocks a method inherited from a boundary-marked ancestor class while own properties and non-boundary-inherited methods on a subclass stay accessible

### sandboxedHas
- INVARIANT: accessHas returns true for own properties
- INVARIANT: accessHas returns false for missing properties
- INVARIANT: accessHas returns false (not throw) for blocked properties
- INVARIANT: accessHas returns false for Object.prototype-inherited properties
- INVARIANT: accessHas returns true for non-boundary inherited properties

### sandboxedKeys
- INVARIANT: accessKeys returns only own enumerable keys
- INVARIANT: accessKeys never includes inherited keys
- INVARIANT: accessKeys returns an empty array for null/undefined

### sandboxedSet
- INVARIANT: accessSet sets own properties
- INVARIANT: accessSet shadows an inherited property by creating an own property instead
- INVARIANT: accessSet throws InteropAccessError for blocked property names
- INVARIANT: accessSet throws TypeError for null/undefined targets

### markAsSandboxBoundary
- INVARIANT: markInteropBoundary marks a class's prototype as a boundary
- INVARIANT: markInteropBoundary marks a plain object as a boundary

### isSandboxBoundary
- INVARIANT: Object.prototype/Array.prototype/Function.prototype are boundaries
- INVARIANT: null is treated as a boundary
- INVARIANT: a custom class prototype is not a boundary by default
- INVARIANT: a class marked with INTEROP_BOUNDARY is recognized as a boundary

### Array access
- INVARIANT: index access and .length on arrays are allowed
- INVARIANT: Array.prototype methods (push/map/filter) are blocked

### Real-world attack vectors
- INVARIANT: constructor.constructor (Function-constructor) escape is blocked
- INVARIANT: __proto__ manipulation is blocked
- INVARIANT: prototype property access on a function is blocked

### Well-known Symbol blocking
- INVARIANT: well-known symbols (toPrimitive/hasInstance/iterator/asyncIterator/species) are blocked from accessMember
- INVARIANT: non-well-known (user-created) symbols are allowed through accessMember
- INVARIANT: accessHas returns false for blocked well-known symbols
- INVARIANT: accessSet blocks well-known symbols

### Additional boundary prototypes
- INVARIANT: WeakRef.prototype/FinalizationRegistry.prototype/SharedArrayBuffer.prototype are boundaries
- INVARIANT: GeneratorFunction.prototype and AsyncGeneratorFunction.prototype are boundaries

### Cache invalidation
- INVARIANT: markInteropBoundary invalidates the boundary cache for a plain-object prototype — previously-accessible inherited methods become blocked immediately, without affecting own properties [impl-pinning]

### isSandboxBoundary — global-constructor rule
- INVARIANT: a global constructor's prototype not explicitly enumerated (TypeError.prototype) is still flagged as a boundary via the globalThis[name]===ctor rule [impl-pinning]
- INVARIANT: a local (non-global) class prototype is not flagged; its own methods stay reachable
- INVARIANT: an ad-hoc object used as a prototype is not falsely flagged as a boundary
- INVARIANT: boundary detection is identity-checked — spoofing constructor.name to "Object" does not fool it
- INVARIANT: boundary detection reads the own "constructor" descriptor's .value rather than invoking [[Get]], so a hostile accessor never fires and never fools the check [impl-pinning]

## js-interop.test.ts
### JS-interop: numbers
- INVARIANT: numeric scheme values coerce correctly in arithmetic via valueOf
- INVARIANT: exact numbers do not JSON.stringify today — throw due to BigInt backing (documented current behavior) [impl-pinning]
- INVARIANT: inexact numbers SHOULD JSON.stringify to their bare numeric value [fails]

### JS-interop: strings & booleans (boxed scheme faces — the Face split)
- INVARIANT: strings come back as AString, and grafted String.prototype keeps concat/spread/JSON interop natural
- INVARIANT: booleans come back as raw JS booleans

### JS-interop: characters
- INVARIANT: a char SHOULD coerce to the plain JS character [fails]

### JS-interop: symbols
- INVARIANT: a symbol coerces to its bare name in a template literal
- INVARIANT: schemeToJs(symbol) SHOULD unwrap to a plain string [fails]

### JS-interop: lists (Pair)
- INVARIANT: a list is iterable from JS (spread/for-of/Array.from)
- INVARIANT: JSON.stringify(list) throws today due to BigInt elements (documented current behavior)
- INVARIANT: schemeToJs(list) is the working escape hatch to a plain JS array

### JS-interop: vectors
- INVARIANT: a vector is iterable from JS like a Pair; elements coerce via valueOf
- INVARIANT: schemeToJs(vector) is the working escape hatch to a plain JS array

### JS-interop: bytevectors
- INVARIANT: a bytevector is iterable from JS, yielding raw bytes

### JS-interop: dicts / objects
- INVARIANT: JSON.stringify(dict) no longer throws, but is not a meaningful/supported interop path
- INVARIANT: schemeToJs(dict) is the working escape hatch to a plain JS object

## rosetta-environment.test.ts
### LIPS → JS Conversion
- INVARIANT: schemeToJs converts scheme numbers to JS numbers
- INVARIANT: schemeToJs converts scheme lists to JS arrays
- INVARIANT: symbol-keyed properties survive a JS→scheme→JS round-trip alongside unchanged string keys
- INVARIANT: (skipped) empty scheme list should convert to an empty JS array [todo]
- INVARIANT: nested scheme lists convert to nested JS arrays
- INVARIANT: mixed-type scheme lists (number/string/bool) convert element-wise to correct JS types

### JS → LIPS Conversion
- INVARIANT: JS arrays convert to borrowed AJSArray vectors (not lists) and round-trip via schemeToJs
- INVARIANT: an empty JS array converts to an empty AJSArray vector, not nil
- INVARIANT: nested JS arrays round-trip correctly through jsToScheme/schemeToJs
- INVARIANT: JS objects convert to AJSObject with lazily-boxed field access and round-trip via schemeToJs

### Rosetta Function Wrapping
- INVARIANT: a JS function wrapped via createRosettaWrapper is callable from scheme with automatic arg/result conversion; an array result crosses back as an AJSArray
- INVARIANT: a rosetta wrapper handles a complex JS operation (object-returning function) and its result round-trips via schemeToJs

### Environment.defineRosetta
- INVARIANT: env.defineRosetta extends the environment with a callable rosetta function usable from scheme source
- INVARIANT: multiple defined rosetta functions can be chained/composed from scheme source

### Real-world Use Cases
- INVARIANT: a rosetta function receiving scheme-converted JS objects can filter on a nested style property and results round-trip correctly
- INVARIANT: a rosetta function can aggregate scheme-converted JS objects into a stats object that round-trips correctly

## dataflow-thesis-probes.test.ts
### PROBE — DROP: does (length (map f xs)) compute f today?
- INVARIANT: BASELINE — map dispatches eagerly; f runs once per element even though length ignores the values
- INVARIANT: TARGET — length through a lazy map runs f zero times [fails]

### PROBE — ATTRIBUTION: does a count's provenance depend on which elements it counted?
- INVARIANT: MEASURE — a count's (length) provenance is entangled with the identity of every counted element, not minimal to cardinality [impl-pinning]

## contract-precision-fixes.test.ts
### 2026-07-05 audit — runtime Contract precision on the REAL exported ops
- INVARIANT: for-each's rest-argument schema requires a proper list (Pair|Nil); a non-list is rejected
- INVARIANT: string-map's rest-argument schema requires a real AString; a raw JS string is rejected
- INVARIANT: string-for-each's rest-argument schema requires a real AString; a raw JS string is rejected
- INVARIANT: filter's input schema is a fixed 2-tuple; a 3rd element is rejected

### 2026-07-05 audit — scheme/equality: symbol=? input precision (boolean=? deliberately unchanged)
- INVARIANT: symbol=?'s input schema requires both arguments to be real ASymbols; a mix of symbol/non-symbol or two non-symbols is rejected
- INVARIANT: boolean=?'s input schema deliberately stays z.unknown() because its impl branches on boxed ABool vs raw JS boolean — both representations, and a mix of both, are accepted [impl-pinning]

## polyglot-rich-errors-typo.test.ts
### polyglot-rich-errors/registry — richErrorFor (unit, no eval)
- INVARIANT: a one-character typo of a bound well-known symbol yields a "did you mean" hint
- INVARIANT: a one-character typo of a stubbed well-known symbol yields a "did you mean" hint
- INVARIANT: a one-character typo of a famous-but-absent well-known symbol yields a hint naming the suggestion plus "not implemented in this runtime"
- INVARIANT: a canonical-form match (dash/underscore/case variance) yields a "did you mean" hint
- INVARIANT: an arbitrary non-well-known identifier gets no hint
- INVARIANT: an exact well-known name gets no hint
- INVARIANT: the well-known-symbols table has no duplicate canonical names

### unboundVariableError — the `enriched` structured marker (unit, no eval)
- INVARIANT: .enriched is true for a typo of a bound well-known symbol
- INVARIANT: .enriched is true for a typo of a stubbed well-known symbol
- INVARIANT: .enriched is true for a typo of a famous-but-absent well-known symbol
- INVARIANT: .enriched is true for a canonical-form match
- INVARIANT: .enriched is false for an arbitrary non-well-known identifier
- INVARIANT: .enriched is false for an exact well-known name
- INVARIANT: .enriched is false below the edit-distance length floor
- INVARIANT: `.enriched` is a pure addition — `.message`/`.publicMessage` exact wording is unchanged [impl-pinning]

### polyglot-rich-errors — LIVE enrichment at the arrival throw site (default env)
- INVARIANT: a typo of a bound symbol throws with the rich "did you mean" hint, live from exec
- INVARIANT: a typo of a stubbed symbol throws with the rich hint, live from exec
- INVARIANT: a canonical-form miss throws with the rich hint, live from exec
- INVARIANT: an arbitrary unbound identifier throws the plain, unenriched message with no fabricated hint [impl-pinning]
- INVARIANT: the original enriched Error survives as `.cause` on the wrapped ArrivalError; `.cause.enriched` is true when a hint fired
- INVARIANT: `.cause.enriched` is false for a bare, unenriched unbound-variable throw

### length floor — short names never get edit-distance suggestions
- INVARIANT: single-character unbound names get no suggestion
- INVARIANT: two-character unbound names get no edit-distance suggestion
- INVARIANT: real typos of length-≥3 structured names still fire

## polyglot-rich-errors-stubs.test.ts
### well-known-stubs — one representative door per family
- INVARIANT: each well-known CL/Racket/Clojure stub (type-of, <>, make-hash, make-hasheq, hash-ref, gethash, getf, println, print, loop, nreverse, for/list, for/fold) fires a PurityError door whose message routes to the correct bound alternative
- INVARIANT: setf/defun fire their door when called with already-bound arguments (limitation: unbound-argument calls surface "Unbound variable" instead, since these are procedures, not macros)

### well-known-stubs — the pack upgrades a WALL into a DOOR
- INVARIANT: every stub symbol doors with "is not available." in the DEFAULT env, because the pack ships in BASE_PACKS [impl-pinning]

## oracle-contract.spec.ts
### oracle Layer-S — corpus loaded
- INVARIANT: the fixture corpus has more than 20 entries [impl-pinning]

### oracle Layer-S — agrees with the canonical reference on every prefix
- INVARIANT: arrival's structural scanner agrees field-for-field (depth/inString/inComment/midToken/position/closeable/closeSuffix/overClosed) with the inlined canonical S-only reference reader, over every prefix of every corpus entry

### oracle Layer-S — feasible() matches structural feasibility (no over-close)
- INVARIANT: structuralScanner.feasible() matches the reference's !overClosed on every prefix of every corpus entry

### oracle Layer-S — analyze() exposes the full contract surface with graceful Σ/T
- INVARIANT: with no env injected, validSymbols()/expectedType() are null and produces() is always true, across every prefix
- INVARIANT: appending closeSuffix to a well-nested, non-truncated prefix always reaches depth 0
- INVARIANT: validClasses() includes "end" iff closeable, and includes "close" iff depth>0 outside string/comment

### oracle Layer-S — resumable session agrees with from-scratch analyze (the §A1 property)
- INVARIANT: driving a session char-by-char produces state identical to analyze(prefix) at every step (depth/inString/inComment/midToken/position/formKind/strict/closeable/closeSuffix/overClosed)
- INVARIANT: Layer S never eagerly evaluates — session.lastClosed stays null and session.failed stays false throughout
- INVARIANT: session.clone() branches share no mutable state — advancing the branch never affects the base

### oracle Layer-S — char-vs-token gap (the load-bearing subtlety)
- INVARIANT: a mid-token prefix ("(net") and its completions are structurally feasible, while the mid-token prefix itself is not closeable and excludes "end" from validClasses
- INVARIANT: an over-close (extra closing paren) is infeasible

### oracle Layer-S — formKind / strict (arrival-only contract additions)
- INVARIANT: top level is formKind "top" and strict
- INVARIANT: a quoted form is formKind "quote" and lazy (non-strict)
- INVARIANT: an if-branch is formKind "lazy-arm" and non-strict
- INVARIANT: an ordinary application argument is formKind "application" and strict
- INVARIANT: the operator slot of an application is position "operator" with formKind "application"

### oracle Layer-Σ — graceful degradation when no env is injected
- INVARIANT: with no env injected, validSymbols() stays null on every shape, identical to the Layer-S scanner

### oracle Layer-Σ — env-backed validSymbols (live when an env is given)
- INVARIANT: at operator position, an env-bound callable is valid and a non-callable bound name is excluded
- INVARIANT: at argument position, any bound symbol (callable or not) is valid
- INVARIANT: a never-bound name is never in the valid set at either position
- INVARIANT: makeOracleEnv enumerates the parent environment chain and resolves nearest-binding callability correctly

### oracle Layer-Σ — lexical scope: a let-bound name is in scope inside BODY, absent outside
- INVARIANT: a let-bound name is in validSymbols() inside its body
- INVARIANT: a let-bound name is absent from validSymbols() once the let form has closed
- INVARIANT: a lambda parameter is in scope inside the lambda body
- INVARIANT: a curried define binds both the function name and its parameters in the body's scope
- INVARIANT: a top-level define is visible to subsequent sibling forms
- INVARIANT: inside a quote, Σ is disabled (validSymbols() is null)
- INVARIANT: at top level, Σ stays null regardless of prior top-level forms

## rosetta-pure-marker.test.ts
### rosetta pure marker
- INVARIANT: env.defineRosetta's `pure: true` marker round-trips into the pure registry; default (no flag) is absent from it
- INVARIANT: a pure rosetta fn classifies as a "pipe" (propagates input provenance, mints nothing); a default rosetta fn classifies as a "source" (mints a fresh provenance leaf)

## sandbox-unification.test.ts
### host-language verbs are non-existent
- INVARIANT: every host-language verb (eval/load/set-obj!/set-special!/new/instanceof) is genuinely Unbound in the inference env
- INVARIANT: no host-language verb appears as a key on the env's own surface [impl-pinning]

## Summary

- Invariant count: ~205 (13 files, describe-group breakdown above).
- Impl-pinning count: 27 — concentrated in membrane.spec.ts (exact error-string/sentinel/singleton pins: 7), membrane-symmetry.test.ts (boxer internals: 5), sandbox-escape.test.ts (marker/registry-surface pins: 3), sandbox-boundary.spec.ts (cache/descriptor-read mechanism: 2), js-interop.test.ts (1), contract-precision-fixes.test.ts (1), polyglot-rich-errors-typo.test.ts (2), polyglot-rich-errors-stubs.test.ts (1), oracle-contract.spec.ts (1 — fixture-size pin), sandbox-unification.test.ts (1), dataflow-thesis-probes.test.ts (1).
- `[fails]`-tagged: membrane-symmetry.test.ts (1, null↔nil asymmetry), js-interop.test.ts (3: inexact JSON, char coercion, symbol schemeToJs), dataflow-thesis-probes.test.ts (1, lazy-map target).
- `[todo]`-tagged: rosetta-environment.test.ts (1, `it.skip` empty-list case).
- Files whose purpose skews toward exercising a not-yet-production-consumed API: **rosetta-pure-marker.test.ts** — the `pure` marker and `rosettaPureOf` registry round-trip is real, but the `Classifier`/`classify`/`fullCone` consumer wiring is built inline in the test itself ("richer role taxonomy and live runtime propagation are deferred" per the file's own header) — no production caller reads this classification today. **dataflow-thesis-probes.test.ts** is explicitly a falsification-probe file for an unimplemented design note (half its assertions are `it.fails` against a feature that doesn't exist yet), not a behavior gate on shipped code.
