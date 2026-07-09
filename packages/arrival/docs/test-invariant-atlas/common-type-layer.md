> **Historical snapshot (2026-07-08, pre-rework v1 suite).** Files named here may be deleted, renamed, or relocated since (G1/G2/G3 — see `../../REWORK-DAG.md` and `../test-suite-v2/REMOVAL-MANIFEST.md`).

## capability-prelude-only-symbol.test.ts
### EnvCapability.lower().apply() — routing preludeOnly symbols onto ctx.preludeScope
- INVARIANT: a preludeOnly rosetta binds onto ctx.preludeScope, not onto the runtime env
- INVARIANT: an ordinary (non-preludeOnly) rosetta binds onto the runtime env, unaffected by preludeOnly wiring
- INVARIANT: a preludeOnly symbol with no ctx.preludeScope present falls back to binding on env (no silent drop)
- INVARIANT: a preludeOnly native symbol also routes onto ctx.preludeScope, kind-agnostic (native and rosetta share the routing rule)

## capability-rosetta-symbol.test.ts
### EnvCapability.lower() — the rosetta SymbolDef arm
- INVARIANT: lower().apply() decodes scheme args, runs impl, and encodes the result back to scheme through the bound verb
- INVARIANT: an invalid arg is rejected via the input codec (errors-as-doors) before impl runs
- INVARIANT: a bound rosetta verb mints provenance off ctx.currentInvocation, marking the point and stamping the output
- INVARIANT: a rosetta returning a structured (list) output deep-stamps every reachable element with the minted origin
- INVARIANT: without a ctx invocation, the result forwards the input's provenance rather than minting a new one
- INVARIANT: a `function` impl (not an arrow) reads run-state (abort signal) off `this.runCtx` via the CallCtx binding [impl-pinning]
- INVARIANT: a pure arrow impl ignores `this` entirely; behavior is byte-identical with or without a ctx/runCtx [impl-pinning]
- INVARIANT: `pure: true` forwards input provenance even with a ctx invocation — a transform never mints, only a source does

## capability.test-d.ts
### SymbolDeclaration — the raw pre-bake authoring-time union
- INVARIANT: a baked AEntity is assignable to SymbolDeclaration (its own distinct type from `symbol.js`'s AEntity, no name collision)
- INVARIANT: a bare `{ value }` binding object is assignable to SymbolDeclaration
- INVARIANT: a bare function is assignable to SymbolDeclaration

## capability.test.ts
### EnvCapability
- INVARIANT: resources are pre-spawned lazily — wiring a method does not spawn; first touch does
- INVARIANT: a resource is spawned only once across repeated touches (single-flight cache)
- INVARIANT: windDown() releases live resources while keeping the verb wiring intact
- INVARIANT: a touch after windDown() re-spawns the resource on demand (pause, not destroy)
- INVARIANT: resume() after windDown+re-touch is idempotent against an already-live resource cell
- INVARIANT: lower() validates capability config through zod, throwing on an invalid enum value
- INVARIANT: a method-less prelude-only capability requires an evalScheme function, rejecting with "no evalScheme" when absent

## collect-prelude.test.ts
### collectPrelude
- INVARIANT: returns a single capability's own prelude verbatim
- INVARIANT: a dependency's prelude is ordered BEFORE its dependent's own, matching lower()'s apply order
- INVARIANT: a diamond-shaped dep graph's shared prelude is deduplicated, appearing exactly once
- INVARIANT: a capability with no prelude contributes no entry (no stray blank lines)
- INVARIANT: empty input yields an empty string

## env-pack-prelude-scope.test.ts
### assembleEnv — kernel-internal phase-gated preludeScope
- INVARIANT: ctx.preludeScope is always present on every pack apply, even with no option passed
- INVARIANT: a binding set by an earlier pack resolves through the base's resolver during a later pack's apply (same C3 run)
- INVARIANT: the phase-gated resolver goes silent (answers undefined) once assembly completes
- INVARIANT: no resolver is registered when no preludeOnly binding is ever set during assembly (lazy, common case untouched)
- INVARIANT: two separate assemblies over the same base register distinct resolver ids, each spent after its own assembly
- INVARIANT: a non-resolver-host base is tolerated — preludeScope.set() is a quiet Map write with no consultation
- INVARIANT: the phase flips back to closed even when a pack's apply throws (no half-open prelude scope escapes)

## env-pack.test.ts
### env-pack assembly core (P0)
- INVARIANT: a linear dep chain a→b→c orders C3 highest-precedence-first, applies deps-first, each pack exactly once
- INVARIANT: a diamond dep graph linearizes via classic C3 and applies the shared root exactly once
- INVARIANT: a pack reachable via 3 distinct paths is applied exactly once (dedup)
- INVARIANT: a cycle in deps throws AssembleCycleError with the path
- INVARIANT: two packs sharing a name with divergent config throw AssembleConfigConflictError
- INVARIANT: two packs sharing a name with equal config dedup silently (no conflict)
- INVARIANT: an async pack apply resolves before assembleEnv returns, its bindings visible after
- INVARIANT: onDispose callbacks run in LIFO order (reverse of apply order)
- INVARIANT: a throwing pack apply rolls back — prior packs' disposers run and the whole assembly rejects with AssemblePackError
- INVARIANT: an apply that never resolves trips AssemblePackTimeoutError under ASSEMBLE_PACK_TIMEOUT_MS [impl-pinning]
- INVARIANT: a pack listing the same dep twice dedups without spuriously throwing AssembleLinearizationError
### createRuntimeAssembler
- INVARIANT: require() applies a pack onto a live env, deps-first
- INVARIANT: a second require() of the same pack is a no-op (applies once, idempotent)
- INVARIANT: two concurrent requires of the same pack apply exactly once (single-flight)
- INVARIANT: a failed apply can be retried — re-require after failure applies successfully
- INVARIANT: dispose() runs runtime-applied disposers in LIFO order
### C3 spec-parity vs Python MRO
- INVARIANT: the classic K1/K2/K3/Z diamond hierarchy linearizes identically to Python's documented C3 MRO
- INVARIANT: an inconsistent hierarchy Python's C3 rejects is also rejected here, via AssembleLinearizationError

## input-rest-runtime.test.ts
### Contract.inputRest runtime — UNIT (direct def.run): a fixed head + variadic tail
- INVARIANT: a fixed head plus a 0-length variadic tail decodes correctly
- INVARIANT: a fixed head plus a 2-element variadic tail decodes each tail element through inputRest's own codec
- INVARIANT: a 3-element tail proves the split is genuinely variadic, not a fixed 2-slot shape
### Contract.inputRest runtime — INTEGRATION ((tool head r1 r2 …) through a real env + exec)
- INVARIANT: a real scheme call with a 0-length tail reaches the impl correctly through exec
- INVARIANT: a real scheme call with a 2-element tail reaches the impl correctly through exec
### Contract.inputRest runtime — bake-time GUARD: inputRest requires a fixed tuple `input`
- INVARIANT: combining inputRest with a non-tuple (bare single-schema) input throws a contract-authoring error rather than silently ignoring it

## kwargs-runtime.test.ts
### z.kwargs runtime — UNIT (direct def.run, manually-built pluck pairs)
- INVARIANT: interleaved :key/value pairs decode into one constructed object argument
- INVARIANT: keyword pair ORDER at the call site is independent of the shape's declared field order
### z.kwargs runtime — INTEGRATION ((tool :k v …) through a real env + exec)
- INVARIANT: a real scheme `(tool :a v :b v2)` call invokes the impl with the constructed {a,b} object
- INVARIANT: keyword order at the call site is independent of declared order, through real exec
- INVARIANT: an optional kwarg omitted leaves it undefined with no decode failure
- INVARIANT: a required kwarg missing doors with a per-field validation error naming the missing key, not a whole-array type mismatch

## prelude-overlay.test.ts
### preludeOnly — the kernel's phase-gated prelude scope (design §1.3)
- INVARIANT: a preludeOnly verb is unbound at runtime, but a later capability's prelude can call it during assembly
- INVARIANT: an ordinary prelude `define` lands in the runtime env, observable after assembly
- INVARIANT: the prelude scope accumulates across a chain of dependents in C3 order — a shared Map, not rebuilt per capability
- INVARIANT: a lambda defined by a prelude cannot reach a preludeOnly verb at runtime — only capturing the call's result bridges to runtime, never the verb itself

## resources.test.ts
### ResourceCell — the port factory
- INVARIANT: a ResourceCell is lazy — no acquire runs until the first get()
- INVARIANT: N concurrent get()s share exactly one acquire (single-flight)
- INVARIANT: windDown() disposes the live handle; the next get() opens a fresh handle (reconstruct)
- INVARIANT: spinUp(signal, true) eagerly pre-warms the resource
- INVARIANT: a pre-aborted signal makes get() reject and opens nothing
- INVARIANT: an abort mid-open disposes the just-opened handle rather than leaking it
- INVARIANT: a failed acquire can be retried — the next get() opens again
- INVARIANT: the port() helper wires Symbol.asyncDispose to the given close callback

## scheme-env.test.ts
### schemePacks — bootstrap + wire, in dependency order
- INVARIANT: a single pack evaluates its bootstrap THEN runs wire, in that order
- INVARIANT: a dependency's bootstrap runs before its dependent's (C3 order)
- INVARIANT: schemePacks produces a plain kernel EnvPack that composes with pure-JS packs
- INVARIANT: a bootstrap-less pack runs only its wire step, never evaluating anything

## scheme-zod.test-d.ts
### scheme-zod collection faces (interpreter vs JS)
- INVARIANT: z.list(E)'s scheme face is AListAlike (interpreter container); its JS face is an array of the element's JS image
- INVARIANT: z.cons(car, cdr)'s scheme face is AListAlike; its JS face is a 2-tuple of the two element JS faces
- INVARIANT: z.vector(E)'s scheme face is AVector|AJSArray; its JS face is a plain array
- INVARIANT: z.array(E) is a plain-array codec with its own scheme/JS face, distinct from the z.vector/z.list container union
- INVARIANT: nested collections (list-of-lists, a union including nil) compose their JS faces correctly
- INVARIANT: a list-in/vector-out contract shape decodes natives to the SCHEME face and rosettas to the JS face
- INVARIANT: bare z.list() (no element) still yields AListAlike scheme face / SchemeValue[] JS face

## scheme-zod.test.ts
### scheme-zod collection functions (Zod style)
- INVARIANT: z.list(element) decodes a real pair-spine into a JS array via the element codec, and encodes back to a pair-spine
- INVARIANT: z.cons(car, cdrSchema) validates a dotted pair, decoding to a 2-tuple, and rejects a cdr failing its schema
- INVARIANT: z.cons is exactly one cons cell — a 2+ element proper list's cdr (a Pair, not the tail schema) is rejected, never treated as a recursive typed-tail list
- INVARIANT: z.vector(element) accepts and decodes both AVector and AJSArray; encode canonically produces AVector
- INVARIANT: z.array is zod's own plain array re-export, decoding a JS array of codec-typed elements — not a scheme list/vector container
- INVARIANT: element codecs apply during list decode/encode (e.g. AString ↔ string)
- INVARIANT: a homogeneous z.list rejects an improper list (non-nil, non-pair cdr terminator)
- INVARIANT: z.list([A, B]) requires exactly the declared heads, nil-terminated — too few or too many elements rejected
- INVARIANT: z.list([A, B], E) accepts the fixed heads plus zero-or-more E-typed tail elements, rejecting a wrongly-typed tail element
- INVARIANT: sugar z.list(E) is equivalent to explicit z.list([], E) — cross-checked by round-tripping through each other
### scheme-zod z.symbol codec
- INVARIANT: decode then encode round-trips to the SAME ASymbol instance, not merely an equal one (opaque brand, no data loss)
- INVARIANT: two distinct ASymbol instances decode to two distinct JS symbols (no collision)
- INVARIANT: encoding a JS symbol the codec never minted throws rather than silently producing a wrong value
- INVARIANT: the codec's ASymbol cache holds the ASymbol strongly as long as its JS symbol is reachable, surviving a real GC cycle [impl-pinning]
### scheme-zod z.dict(shape)/z.dict() — keyed to ADict.get()'s own protocol
- INVARIANT: a shaped z.dict round-trips a real ADict's keyed fields to a plain JS object and back
- INVARIANT: a dict-shaped AJSObject is also accepted on decode (isDictShaped structural check, not just instanceof ADict)
- INVARIANT: bare z.dict() (open-record) matches ADict['arrival/toJS']() unmodified
### scheme-zod z.box — whole-object unwrap, not decomposition
- INVARIANT: z.box round-trips the SAME object reference — class identity and methods survive, unlike z.dict's decomposition
### scheme-zod z.procedure — contract-aware marshaling
- INVARIANT: decode direction marshals JS call args through scheme and back to a JS result when input/output codecs are given
- INVARIANT: encode direction mirrors decode — a JS function becomes a scheme callable that marshals scheme args → JS → scheme
- INVARIANT: with no input/output codecs, decode round-trips raw scheme values through the callable unchanged (untyped fallback)
- INVARIANT: with no input/output codecs, encode round-trips raw scheme values unchanged (untyped fallback)
### scheme-zod z.value — exhaustive predicate, passthrough on both faces
- INVARIANT: z.value accepts every concrete scheme value kind, including symbol/dict/vector/bytevector (completeness)
- INVARIANT: z.decode(z.value, x) === x — passthrough only, z.value never transforms
### scheme-zod z.nil
- INVARIANT: z.nil round-trips ANil ↔ JS null
- INVARIANT: the empty-list role is absorbed by z.list's own decode (ANil parses to []) with no separate schema needed
### scheme-zod z.undefinedResult / z.error — real codecs
- INVARIANT: z.undefinedResult round-trips undefined ↔ AVoid
- INVARIANT: z.error round-trips R7RSError ↔ Error, mapping irritants ↔ cause in both directions, defaulting to empty irritants when cause is absent
### scheme-zod number codec family — boundary cases (z.exact / z.inexact / z.integer / z.schemeNumber / z.number / z.bigint)
- INVARIANT: z.exact round-trips a safe integer via both bigint and number encode inputs
- INVARIANT: z.exact doors a non-integer exact rational (denom !== 1n) on decode
- INVARIANT: z.exact doors encoding a non-safe-integer JS number
- INVARIANT: z.inexact decodes AInexact.real and accepts lossy bigint/number on encode
- INVARIANT: z.integer decodes a safe AExact or AInexact integer and canonicalizes encode to AExact
- INVARIANT: z.integer doors a non-safe-integer AInexact on decode
- INVARIANT: z.integer doors an out-of-range exact integer on decode (precision-loss guard)
- INVARIANT: z.integer doors a non-integer exact rational on decode
- INVARIANT: z.schemeNumber's union decodes each branch (exact/inexact) through its own codec
- INVARIANT: z.schemeNumber's encode always tries the exact branch first — a genuine float throws rather than falling through to inexact [impl-pinning]
- INVARIANT: z.number decodes exact/inexact to a JS number and canonically encodes to AInexact
- INVARIANT: z.number doors an over-range exact integer (no silent precision loss)
- INVARIANT: z.number doors a non-integer exact rational
- INVARIANT: z.bigint round-trips arbitrary precision beyond the safe-integer range, canonically encoding to AExact
- INVARIANT: z.bigint doors an exact rational with no integer bigint form
- INVARIANT: z.bigint doors an inexact value with a fractional part
### scheme-zod z.lookupName / named() — survives combinators, incl. the .refine() parent-walk
- INVARIANT: lookupName resolves the declared name of a function-constructed schema (e.g. z.list(z.char) → "list")
- INVARIANT: lookupName resolves through .optional() (a fresh wrapper holding the original by reference)
- INVARIANT: lookupName resolves through .refine() via the _zod.parent back-link, the one combinator with no innerType to unwrap [impl-pinning]
### scheme-zod z.array — guard: still zod's own plain re-export
- INVARIANT: z.array parses a bare JS array of already-JS values directly, with no scheme container involved

## carriers.test-d.ts
### R3 carrier model — slot-kind probes and bite-guards (no describe blocks; type-only assertions)
- INVARIANT: a List-typed parameter type-checks against list()/cons()-built values, including cons-prepend and map-produced lists
- INVARIANT: a vector (readonly number[])-typed parameter type-checks against a plain JS array
- INVARIANT: SlotKind resolves to "list" for a List param, "vector" for an array param, "string" for an enum param, "scalar" for a number param
- INVARIANT: ElemOf recovers the element type of a List param, including through nested List<List<T>>
- INVARIANT: AcceptsBareWord is true for a plain string param and false for a List param
- INVARIANT: IsStringTyped is true for a string-literal-union (enum) param
- INVARIANT: a dict-shaped keyword call lowers to an object literal that type-checks against a `{ name, age }` param; deep algebra (filter→map→reduce) composes across carriers
- INVARIANT: a scalar argument where a list is expected is a type error
- INVARIANT: a wrong-element-typed list where a string list is expected is a type error
- INVARIANT: an enum member outside the declared set is a type error
- INVARIANT: a plain vector/array where a list is expected is a type error (vector ≠ list)
- INVARIANT: a wrong-typed or missing required dict field is a type error

## diagnose.test.ts
### createDiagnoseLens — diagnostic mechanics over a typed prelude
- INVARIANT: a TS2345 positional-mismatch diagnostic extracts the expected and actual type strings
- INVARIANT: a TS2554 arity diagnostic extracts the callee's full signature string
- INVARIANT: a TS2561 excess-property diagnostic extracts the offending property name and the closed candidate key set
- INVARIANT: a TS2551 typo'd bracket-access read extracts a bare (unquoted) property name and candidate suggestions
- INVARIANT: a non-whitelisted diagnostic code is kept bare (code + span + message only, no expected/actual/property payload)
- INVARIANT: a clean, well-typed program produces no diagnostics
- INVARIANT: a diagnostic's span is reported in scheme source coordinates, at or after programStartOffset
- INVARIANT: contextDefines shift programStartOffset forward, and context-region diagnostics are excluded from the program's own span
- INVARIANT: diagnose never throws on unparseable scheme input — it degrades to an empty diagnostics result

## lower.test.ts
### lower — scheme → TS emitter
- INVARIANT: application forms keep the head and scheme argument order when lowered
- INVARIANT: a non-identifier head (e.g. `+`, `string-append`) routes through the escaped `_` namespace member
- INVARIANT: a `:keyword value` run lowers into a trailing object-literal argument `{ key: value }`
- INVARIANT: leading positional args stay positional; trailing keywords fold into one object argument
- INVARIANT: a bare keyword with no value lowers to `{ key: undefined }`
- INVARIANT: car/cdr lower to functional carrier-global calls, not field reads
- INVARIANT: list/cons/quoted-list forms lower to the carrier constructors
- INVARIANT: a vector literal `#(...)` lowers to a native TS array literal
- INVARIANT: `(dict ...)` lowers to an object literal; a keyword-headed read `(:key obj)` lowers to a bracket field access
- INVARIANT: a lambda lowers to a TS arrow function
- INVARIANT: string/number/boolean atoms lower to their literal TS forms
- INVARIANT: multiple top-level forms lower to `;\n`-separated statements
### lower — quoted data recurses (the false-positive killer)
- INVARIANT: a quoted nested list recurses as quoted data at every level, never mistaken for an application
- INVARIANT: a flat quoted list lowers unchanged to `list(...)`
- INVARIANT: a dotted quoted pair lowers to `cons(...)`
- INVARIANT: deep nesting recurses correctly at every level
- INVARIANT: a multi-element dotted list folds right through the proper elements into nested cons calls
### lower — quasiquote degrades to quoted data, unquote stays live
- INVARIANT: a quasiquoted list with no unquote lowers exactly like an ordinary quote
- INVARIANT: an (unquote e) node inside a quasiquote emits the live expression, not further-quoted data
- INVARIANT: unquote-splicing also emits the live expression
- INVARIANT: a nested quasiquoted list still recurses as quoted data
- INVARIANT: a stray unquote outside a quasiquote degrades to the live inner expression
### lower — top-level define lowers to a const statement
- INVARIANT: `(define x e)` lowers to `const x = e`
- INVARIANT: `(define (f a b) body)` lowers to a const-bound arrow function with `any`-typed params
- INVARIANT: a multi-form function body folds to a comma sequence expression
- INVARIANT: a zero-arg function define lowers to a zero-arg arrow
- INVARIANT: `(define x)` with no value lowers to `const x = undefined`
- INVARIANT: multiple top-level defines lower to separate const statements
- INVARIANT: a nested define inside a lambda body still uses the application-call lowering (not a separate const form)
- INVARIANT: a defined helper's real arity mismatch is caught by tsc against its real parameter types (TS2554)
### lower — s.* combinators (TS reserved-word forms)
- INVARIANT: if lowers to `s.if(cond, then[, else])`
- INVARIANT: let lowers to `s.let(v1, v2, (a,b) => body)`
- INVARIANT: named let lowers to `s.namedLet(v, (loop, i) => body)`
- INVARIANT: let* lowers to nested s.let calls preserving sequential scoping
- INVARIANT: letrec/letrec* lower identically to let (advisory fidelity, not distinguished)
- INVARIANT: cond lowers to `s.cond([test, e], …)` with else rewritten to a literal true test
- INVARIANT: do/case lower to parse-safety-only `s.do`/`s.case` calls with incidental shape
- INVARIANT: a reserved word in argument/value position always routes through the `_` namespace, never printed bare
- INVARIANT: a lowered `if` type-checks and narrows correctly through the carrier `s` namespace
- INVARIANT: a lowered `let` type-checks and infers the bound variable's type correctly
- INVARIANT: a lowered `cond` type-checks correctly
### lower — integration: lowered call ∩ harvested prelude
- INVARIANT: a valid lowered call (list-typed arg matching a real proper-list literal) type-checks clean against the harvested prelude
- INVARIANT: a vector literal where a list-typed slot is expected is rejected by tsc
- INVARIANT: a string where a number-typed slot is expected is rejected by tsc
### lower — per-statement span-map (additive)
- INVARIANT: lower() preserves the `{ ts }` emitted string verbatim
- INVARIANT: a single-statement program's tsRange slices the whole output and its schemeSpan covers the whole source form
- INVARIANT: a multi-statement program's per-statement tsRange/schemeSpan each slice exactly their own fragment/source form
- INVARIANT: a `#(...)` vector literal fuses into one statement span covering the `#` mark plus the list

## name-escape.test.ts
### name-escape — the bifunctor lens
- INVARIANT: unescapeName(escapeName(x)) === x for every name in the R7RS-flavoured corpus (round-trip law)
- INVARIANT: escapeName's image is always a valid TS identifier for every corpus name
- INVARIANT: an already-identifier-safe name is a fixed point of escapeName (escape = id)
- INVARIANT: named tokens encode readably (e.g. `nil?` → `nil$question$`, `+` → `$plus$`, `set!` → `set$bang$`)
- INVARIANT: a leading digit is guarded (prefixed) while mid-name digits stay literal
- INVARIANT: a literal `$` in a name is itself escaped so the sigil never becomes ambiguous
- INVARIANT: an ECMAScript reserved word is never a fixed point of isTsIdentifier, though it still round-trips through escape/unescape
- INVARIANT: a TS contextual (non-reserved) keyword (e.g. "string", "type", "get") IS a fixed point — a valid bare identifier

## prelude.test.ts
### assembleHarvestedPrelude — grant tool defs → lens prelude
- INVARIANT: emits the carrier vocabulary plus one `declare const` per harvested tool
- INVARIANT: a valid lowered program type-checks clean against the harvested prelude
- INVARIANT: a wrong lowered program (vector where list expected; string where number expected) bites under tsc
- INVARIANT: a kwargs tool's valid `:key value` call type-checks; a wrong value type, an out-of-enum value, or a missing required property each bites

## query.test.ts
### getTypeValidCandidates — kebab/operator-named callees narrow
- INVARIANT: a kebab-named callee's list slot narrows — drops a provably-void-returning candidate, keeps a list-returner and an unresolved local
- INVARIANT: a kebab-named callee's string slot narrows — drops a list-returning candidate, keeps the unresolved local
### kwargs / object-value slots narrow to the property type
- INVARIANT: a string-valued kwarg's slot resolves to that property's scalar string type, not the whole object type
- INVARIANT: an enum-valued kwarg's slot narrows to its declared enum members
- INVARIANT: at a string-valued kwarg slot, a number-returning candidate is dropped while an unresolved local is kept (drops-only)
### getTypeValidCandidates — the Σ∩T mask is DROPS-ONLY
- INVARIANT: at a list slot, a provably-non-list candidate is dropped while the list-returner and unresolved local are kept
- INVARIANT: at a list slot, the generic carrier `list` head is kept (its return is itself a list)
- INVARIANT: at a string slot, non-string-returning candidates are dropped while the string-returner and unresolved local are kept
- INVARIANT: at a number slot, the string-returning candidate is dropped while the number-returner and unresolved local are kept
- INVARIANT: at top level (no enclosing call), every candidate is kept unconditionally
- INVARIANT: at the operator slot (cursor at the call head), every candidate is kept unconditionally
- INVARIANT: an unknown callee yields an unresolved slot where every candidate is kept (conservative default)
- INVARIANT: across every resolvable slot, a valid or uncertain candidate is never dropped — only the provably ill-typed candidate is ever absent (the governing Σ∩T invariant)
- INVARIANT: an empty candidate list returns empty without invoking tsc
### getSlotArrayKind — the 3-way value verdict
- INVARIANT: a list-typed param resolves to "list"
- INVARIANT: a vector (number[])-typed param resolves to "vector"
- INVARIANT: a scalar number-typed param resolves to "scalar"
- INVARIANT: a string-typed param resolves to "scalar" (string folds into scalar for the array-kind verdict)
- INVARIANT: an unresolved slot (unknown callee) resolves to null
- INVARIANT: a top-level (no-call) cursor resolves to null
### getSlotElementType — the ENUM / closed-domain narrow (the highest-value axis)
- INVARIANT: a direct enum-typed param's element domain is its literal members (isStringy null)
- INVARIANT: an array-of-enum param's element domain recovers the element's enum members
- INVARIANT: a free-form string param resolves isStringy true with a null enum
- INVARIANT: a number-typed param resolves both isStringy and enum to null
- INVARIANT: a List<unknown>/vector<number> param resolves both isStringy and enum to null (element isn't a string domain)
- INVARIANT: an unresolved slot or a top-level cursor resolves both isStringy and enum to null (superset-safe)
### getSlotAcceptsBareWord — a bare word is admissible as a string
- INVARIANT: a free-form string slot accepts a bare word (true)
- INVARIANT: a closed-enum slot does not accept an arbitrary bare word (false)
- INVARIANT: a list/vector/number slot does not accept a bare word (false)
- INVARIANT: an unresolved slot or top-level cursor returns null (never a guessed boolean)
### getSlotIsStringTyped — the slot is a string subtype, not an array
- INVARIANT: a free-form string slot is string-typed (true)
- INVARIANT: a closed-enum slot is string-typed (true — an enum is a string subtype)
- INVARIANT: a number/list/vector slot is not string-typed (false)
- INVARIANT: an unresolved slot or top-level cursor returns null

## reachability.test-d.ts
### list-slot reachability gate — CouldBeList bite-guard (no describe blocks; type-only assertions)
- INVARIANT: CouldBeList is true for a resolved List<T> type
- INVARIANT: CouldBeList is true for a union of List types (models an (if …) branch union)
- INVARIANT: CouldBeList is true for `unknown` (the nuke-guard admitting generic/if/car returns)
- INVARIANT: CouldBeList is false for a vector (readonly T[]) type — vector and list are disjoint
- INVARIANT: CouldBeList is false for scalar types (number, string)
- INVARIANT: an (if cond a b)-shaped call, an append call, and deep nested list-returning expressions all fill a list slot without error
- INVARIANT: car of a List<List<T>> resolves to List<T> and fills a list slot
- INVARIANT: a provably-non-list-returning call (add, upcase, car-of-a-plain-list) at a list slot is a type error

## schema-to-ts-collections.test.ts
### printType — named-generic collections (List<T> / Pair<Car, Cdr>)
- INVARIANT: printType(z.list(z.string)) prints the named generic "List<string>", not the structural Cons<string>|null
- INVARIANT: bare z.list() prints "List<unknown>" (element defaults to `value`)
- INVARIANT: z.list(z.char) prints "List<string>" (char's JS image is a 1-char string)
- INVARIANT: z.cons(string, boolean) prints the named generic "Pair<string, boolean>", not a structural tuple
- INVARIANT: a fixed-heads z.list([A, B]) (no single element) falls through to the structural tuple printer — no COLLECTION_ELEMENT registration exists for it
### scheme-zod — COLLECTION_ELEMENT registry (name + element lookup)
- INVARIANT: lookupName/lookupCollectionElement resolve list's declared name and element schema by identity
- INVARIANT: lookupName/lookupCollectionElement resolve cons's declared name and its [car, cdr] pair
- INVARIANT: lookupName/lookupCollectionElement resolve through a .optional() wrapper via the core walk
- INVARIANT: lookupCollectionElement returns undefined for a fixed-heads list (no single element to report)

## schema-to-ts.test.ts
### printType — native identity primitives (scheme primitive → plain-TS image)
- INVARIANT: printType(z.pair) prints "Cons<unknown>" so z.pair|z.nil composes to "List<unknown>"
- INVARIANT: printType(z.string) prints "string"
- INVARIANT: the numeric tower prints exact as "bigint" and inexact as "number" via the name-keyed image, not the raw union
- INVARIANT: symbol/vector/bytevector/nil/boolean/char each print their documented plain-TS image
- INVARIANT: z.value (representation-blind) prints as "unknown"
- INVARIANT: z.lambda prints as a callable signature `(...args: unknown[]) => unknown`, not degraded to unknown
- INVARIANT: a union of primitives prints as "A | B" with the name-override applied per member
- INVARIANT: the list union z.pair|z.nil prints as "Cons<unknown> | null" (= List<unknown>)
### printType — unregistered custom leaf hardens to unknown, never throws
- INVARIANT: a bare unregistered custom leaf degrades to "unknown" rather than throwing
- INVARIANT: inside a union, only the unregistered member degrades to unknown — sibling members print unaffected
### printType — rosetta codecs (decoded JS side, io:output)
- INVARIANT: string/boolean/char codecs print their decoded JS type
- INVARIANT: the number-codec family (number/integer/bigint) prints by its declared JS type
### printType — compounds
- INVARIANT: z.object prints as a single-line member list with no dangling semicolon
- INVARIANT: z.array prints as variadic "T[]" with the element decoded
- INVARIANT: z.array of an identity primitive prints "T[]" using the primitive's image
- INVARIANT: a tuple prints as "[A, B]"
- INVARIANT: a tuple mixing a codec member and an identity-primitive member prints both correctly
- INVARIANT: a union prints as "A | B"
### sTagToTsType — the s/* schema-DSL tag → TS type-string bridge
- INVARIANT: an object tag's scalar fields print with a trailing `[x: string]: never` index signature (from additionalProperties:false)
- INVARIANT: a field description prints as a JSDoc comment
- INVARIANT: a nested array field prints correctly
- INVARIANT: a nested object field prints correctly, itself carrying the never-index signature
- INVARIANT: an optional field's `/optional` suffix marks it TS-optional (`?:` with `| undefined`)
- INVARIANT: a malformed/unrepresentable tag degrades to "unknown" rather than throwing
### signatureOf — the args-vector → function-signature composer
- INVARIANT: an author-asserted `type` override on the contract takes precedence over the zod-schema-derived signature (decoupled from the runtime membrane) [impl-pinning]
- INVARIANT: a native def composes as scheme-value args with a synchronous (non-Promise) return
- INVARIANT: a rosetta def composes as decoded-JS args with an async (Promise-wrapped) return
- INVARIANT: a multi-value rosetta output composes as a tuple inside Promise
- INVARIANT: a multi-value native output composes as a bare (sync) tuple
- INVARIANT: a variadic z.array input composes as a rest parameter
- INVARIANT: a 0-arg contract composes as "()"
- INVARIANT: a notImplemented/door def renders its signature as "never" (not callable)
- INVARIANT: a kwargs (inputRest object) input composes as a single plain-object parameter with optional fields marked `?:`

## evaluator-benchmark.spec.ts
### Evaluator Benchmarks — LIPS (promise-based) performance
- BENCHMARK: ops/sec of the LIPS evaluator executing "(+ 1 2)" 1000x via string parse+exec
- BENCHMARK: ops/sec of the LIPS evaluator executing a pre-parsed AST 1000x (isolates parse cost from eval cost)
- BENCHMARK: elapsed time for the LIPS evaluator on a 100-level deeply nested expression, 100 iterations
### Evaluator Benchmarks — Generator (flat trampoline) performance
- BENCHMARK: ops/sec of the generator evaluator executing a hand-built simple-call AST 10000x
- BENCHMARK: elapsed time for the generator evaluator on a 100-level deeply nested expression, 100 iterations
- BENCHMARK: whether the generator evaluator completes a 10000-level deeply nested expression without stack overflow; also asserts the numeric result is correct
### Evaluator Benchmarks — Side-by-side comparison
- BENCHMARK: compares LIPS vs generator wall-clock time and speedup ratio on simple arithmetic "(+ 1 2 3 4 5)"; cross-checks both produce the same correct result
- BENCHMARK: compares LIPS vs generator wall-clock time and speedup ratio on nested function calls "(+ (* 2 3) (* 4 5))"; cross-checks both produce the same correct result

## capabilities-assembled.test.ts
### Capabilities.assembled (3b.3 — assembled base sentinel)
- INVARIANT: refFrame of any name owned anywhere in the base chain resolves to the same stable globalRoot sentinel, whether owned on the base leaf (user_env) or the chain root (global_env)
- INVARIANT: an unbound name has no base claim — refFrame returns undefined
- INVARIANT: globalRoot is the base TOP (user_env), one stable identity surviving the topology cut [impl-pinning]

## fresh-env.test.ts
### freshEnv (capability-assembled test env)
- INVARIANT: freshEnv() resolves builtins regardless of source — native value-domain, BASE_PACK scheme layer, cxr-kernel unfold, and still-inline global_env builtins all work uniformly
- INVARIANT: each freshEnv() call is isolated — a definition made in one fresh env is invisible in a second fresh env

## oracle-contract.spec.ts
### oracle Layer-S — corpus loaded
- INVARIANT: the scout corpus fixture is non-trivial (more than 20 entries)
### oracle Layer-S — agrees with the canonical reference on every prefix
- INVARIANT: arrival's structural scanner agrees with the canonical S-only reference reader on depth/inString/inComment/midToken/position/closeable/closeSuffix/overClosed, for every prefix of every corpus entry
### oracle Layer-S — feasible() matches structural feasibility (no over-close)
- INVARIANT: feasible() equals ¬overClosed per the reference reader, for every prefix of every corpus entry
### oracle Layer-S — analyze() exposes the full contract surface with graceful Σ/T
- INVARIANT: with no env injected, every prefix's validSymbols()/expectedType() are null and produces() reports true (graceful Σ/T degradation)
- INVARIANT: appending closeSuffix to a well-nested, non-truncated prefix always closes it to depth 0
- INVARIANT: validClasses() includes "end" iff closeable, and includes "close" iff depth > 0 (outside string/comment)
### oracle Layer-S — resumable session agrees with from-scratch analyze (the §A1 property)
- INVARIANT: a char-by-char driven session's live state equals structuralScanner.analyze(prefix) at every step, for every prefix of every corpus entry
- INVARIANT: Layer S never eagerly evaluates — session.lastClosed stays null and session.failed stays false throughout
- INVARIANT: clone() branches share no mutable state — advancing a branch leaves the base session's state untouched
### oracle Layer-S — char-vs-token gap (the load-bearing subtlety)
- INVARIANT: a mid-token prefix like "(net" is feasible, and remains feasible after appending a plausible token completion
- INVARIANT: a mid-token prefix is not closeable, is classified midToken with position "operator", and validClasses() excludes "end"
- INVARIANT: an over-close (e.g. ")", "(a))") is the one structurally-infeasible case; a balanced close ("(a)") is feasible
### oracle Layer-S — formKind / strict (arrival-only contract additions)
- INVARIANT: top level is formKind "top" and strict true
- INVARIANT: a quoted form (both `'(...` and `(quote ...` shapes) is formKind "quote" and strict false
- INVARIANT: an if-branch argument is formKind "lazy-arm" and strict false
- INVARIANT: an ordinary application argument is formKind "application" and strict true
- INVARIANT: the operator slot of an application is position "operator" with formKind "application"
### oracle Layer-Σ — graceful degradation when no env is injected
- INVARIANT: makeOracle() with no env keeps validSymbols() null on every prefix shape, identical to the bare Layer-S scanner
### oracle Layer-Σ — env-backed validSymbols (live when an env is given)
- INVARIANT: at operator position, only callable env-bound names are valid; a non-callable bound name is excluded
- INVARIANT: at argument position, any bound symbol (callable or not) is valid
- INVARIANT: a never-bound name is never in the valid set at either position
- INVARIANT: makeOracleEnv enumerates the full parent chain and resolves nearest-binding callability for inherited and own-frame names
### oracle Layer-Σ — lexical scope: a let-bound name is in scope inside BODY, absent outside
- INVARIANT: a let-bound name is in validSymbols() inside its body
- INVARIANT: a let-bound name drops out of validSymbols() once its form has closed
- INVARIANT: a lambda parameter is in scope inside the lambda body
- INVARIANT: a curried define binds both the function name and its parameters inside the body
- INVARIANT: a top-level define is visible to subsequent sibling forms
- INVARIANT: inside a quote, Σ is disabled entirely (validSymbols() null) since quoted data may name any symbol
- INVARIANT: at top level, Σ is null — a free-standing datum head is unconstrained by the bound set

## contract-precision-fixes.test.ts
### 2026-07-05 audit — runtime Contract precision on the REAL exported ops
- INVARIANT: for-each's rest elements must be a proper list (Pair|Nil); a non-list value is rejected by the input codec
- INVARIANT: string-map's rest elements must be a real AString; a raw JS string is rejected
- INVARIANT: string-for-each's rest elements must be a real AString; a raw JS string is rejected
- INVARIANT: filter's input is a fixed 2-tuple; a 3rd element is rejected (no unbounded rest)
### 2026-07-05 audit — scheme/equality: symbol=? input precision (boolean=? deliberately unchanged)
- INVARIANT: symbol=?'s input requires real ASymbol values; a raw string in place of a symbol is rejected
- INVARIANT: boolean=?'s input stays representation-blind (z.array(z.unknown())) — both boxed ABool and raw JS boolean, and a mix of the two, are accepted, since the impl's own unwrap() branches on both representations [impl-pinning]

## Summary
- Invariant count: ~342 (excludes the 8 benchmark entries, which are measurements/comparisons, not pass/fail invariants).
- impl-pinning count: 9 (capability-rosetta-symbol.test.ts ×2 — CallCtx `this` binding, pure-arrow ignoring `this`; env-pack.test.ts ×1 — timeout env-var mechanism; scheme-zod.test.ts ×3 — z.symbol GC-cache direction, z.schemeNumber encode-tries-exact-first union-resolution order, lookupName's `_zod.parent` refine-walk; schema-to-ts.test.ts ×1 — `type` override precedence over schema-derived signature; capabilities-assembled.test.ts ×1 — globalRoot === user_env identity; contract-precision-fixes.test.ts ×1 — boolean=?'s representation-blind z.unknown() left deliberately unfixed).
- Files whose entire purpose is exercising a test-only API: `fresh-env.test.ts` (guards the `freshEnv()` test helper itself, not a production module). The `.test-d.ts` files (capability, scheme-zod, carriers, reachability) are pure type-level bite-guards but they exercise real production types (`capability.ts`, `scheme-zod.ts`, `carriers.ts`), not test-only surfaces.
- Scope actually covered: all of `src/common/__tests__/` (13 files) and `src/type-layer/__tests__/` (9 files) per instruction; `src/__benchmarks__/evaluator-benchmark.spec.ts`; plus from `src/__tests__/` — `capabilities-assembled.test.ts`, `fresh-env.test.ts`, `oracle-contract.spec.ts`, `contract-precision-fixes.test.ts`. Deliberately excluded as out-of-topic despite superficial `EnvCapability`-type-import or "oracle"/"capability" string hits: `clone-identity.test.ts`, `coercion-soundness.test.ts`, `tagless-final-equals.test.ts`, `vector-provenance.test.ts` (use `EnvCapability` only as a type annotation for pulling stdlib ops; actually test coercion/cloning/equals/provenance semantics), `golden-prov-*.test.ts`/`lineage-*.test.ts` ("oracle" there means eager-engine-as-golden-oracle for provenance, unrelated subsystem), `polyglot-rich-errors-*.test.ts` (a stdlib error-stub registry, uses assembleEnv only as infra), `dict.test.ts`, `default-exec-cut.test.ts`, `chibi-r7rs.spec.ts`, `srfi*.test.ts`, `speculative-eval.test.ts`, `cond-case-do-bracket-clause.test.ts`, `attestation.test.ts`.
