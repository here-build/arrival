# `symbol.define` + the static program-validation pass

Why capability vocabulary is declared per symbol instead of authored as a prelude text blob, and how a program is validated against a sealed environment before anything evaluates.

A capability's scheme-bodied vocabulary used to live in `prelude:` — an opaque string of defines with no per-define identity, no contracts, and no static-analysis surface. Decomposed into individual declarations, every define carries a contract, a description, a content hash, and a statically checkable reference discipline — which makes an eslint-style parse-phase validation pass possible: **all errors gathered at once (unbound symbols + capability/config requirements), before execution, never crash-on-first.** This works because the environment is non-dynamic and immutable: a sealed chain's name set is complete and frozen, so "unbound" judged at parse phase cannot be invalidated by evaluation.

The pass also dissolves the strict-vs-teaching-doors question rather than answering it. Without it, a legitimately absent symbol (`require` in a loader-less env) is simply never bound — indistinguishable from a typo. With door-set degradation (§3.7) the symbol binds as an introspectable door carrying its absence-reason as data, and the pass reports every door the program actually references — before evaluation, all at once, with the causal chain. Strictness becomes program-scoped instead of capability-scoped.

## 1. `symbol.define` — the scheme-bodied declaration kinds

### 1.1 Shape

```ts
span: symbol.define`span: (list (take-while pred xs) (drop-while pred xs)) in one pass`(
  { input: [z.lambda, listAlike], output: [listAlike] },   // Contract<I,O> — scheme face
  `(lambda (pred xs) …)`,
)  // → DefineSymbolDef

cut: symbol.defineSyntax`cut: specialize parameters without currying (SRFI-26)`(
  `(lambda args …)`,               // the expander, a scheme lambda over fexpr formals
  { macroAttribute: "opaque" },    // §3.4 — placeholder-token macros are the canonical opaque case
)  // → DefineSyntaxSymbolDef
```

- **Name/description ride the tagged template** (`parseNameDoc`, byte-shared with every other kind); the description is the doc-generation and discovery surface.
- **The body is the RHS EXPRESSION, not a whole `(define …)` form** — the name lives in exactly one place, so name and body cannot drift. A procedure is authored `(lambda …)`; a constant is its value expression. Self-recursion works because the define's own name is in its capability's scope (§2.3).
- **TWO kinds, not one.** `symbol.define` (value/procedure — contract-bearing, role-derived) and `symbol.defineSyntax` (macro/expander — contract-FREE, carrying the ternary `macroAttribute` instead, §3.4). A macro is not a value binding: it has no call-boundary contract, no provenance role, and a categorically different static-analysis story (its "free variables" name the EXPANSION env). One kind whose body's head decides would force every consumer to re-discriminate.
- **Constants vs procedures:** the factory discriminates by contract shape — a `Contract<I,O>` record authors a procedure (validating wrapper at bake); a bare `ZodTypeAny` authors a constant (validated ONCE at bake, bound as a plain value). Constants normalize to the 0-ary-procedure convention (empty `in` tuple, 1-tuple `out`) so vector-shaped readers never special-case them; the explicit `callable` flag tells the bind arm which runtime shape to build.

### 1.2 Contract semantics — ENFORCED at the call boundary, scheme face, skippable

**The contract is enforced from day one.** The evaluated closure is wrapped so every call validates `z.decode` against the normalized input vector on the SCHEME face (a scheme body lives in the value algebra; nothing crosses the membrane) and the return against the output vector. Why enforcement, against advisory type-only schemas: **(a)** an unenforced contract on a scheme body is a declared-vs-actual drift door with no alarm — a JS native's impl is at least compile-time-typed against the same schemas; a scheme body gets NO compile-time check, so the runtime boundary is its only agreement mechanism; **(b)** enforcement keeps the contract honest for every reader that consumes it — the type harvest, the type-lens, the arity checker; **(c)** one semantics across kinds. Note the deliberate asymmetry: `symbol.native` never runtime-validates (its schemas are type-only; the impl is compile-time checked) — an over-tight contract is a runtime regression only on a `define`.

A shapeless contract (`{ input: z.array(z.value), output: [z.value] }`) stays LEGAL for genuinely variadic any-in/any-out defines, but it is an authored judgment per define, never a default the tooling reaches for. The `validate: false` opt-out exists per declaration for MEASURED hot paths (§4.5) — evidence-gated. LIMIT: enforcement is boundary-only — what enters and leaves the closure, never what the body does in between.

**`z.custom` is forbidden on define contracts.** Define contracts double as the TYPE ORIGIN for compiler emission (emitted TS types derive from the declaration's zod contracts — one type source for runtime validation and emission both), and `z.custom` has no type-level content to emit and, with no predicate, validates nothing. Where the emittable schema subset cannot express a define's honest runtime check, the contract splits, documented per site: the runtime-validate schema (full zod) and the emit-type annotation (the `type?:` override) may differ — a declared, visible split, never a silent widening.

### 1.3 Body parsing, spans, identity

- **Parsed at bake.** The declaration stores the body STRING; bake parses and evaluates it against the assembly env — never at module load (the same laziness posture as resource spin-up).
- **Span totality extends into the body.** The reader is called with `source = "«capability-name»#«symbol-name»"`, so every Pair in a define body is located and errors name `scheme/srfi-1#fold-right:3:8` instead of an anonymous prelude blob. LIMIT: the TS declaration site is not captured — capability#name is the designed address.
- **Per-define content identity.** `bodyHash` = FNV-1a over name + body + the contract's stable text, minted eagerly at declaration construction. Cache-key and cross-deploy identity material (§5).

### 1.4 Provenance role — DERIVED from the body, declaration checked against derivation

The role is derived as a **fixpoint over the capability's whole define set** (the `classifyProgramPrelude` algorithm: classify each body directly, then close "a define calling a port-reaching sibling is itself port-reaching" over the reference graph) — a capability's define set is exactly the "set of named top-level defines" shape that machinery already handles. Port-free ⇒ `pipe`; port-reaching ⇒ the classification's own verdict. This inverts the JS kinds' declare-and-shape-check posture because the ground truth is VISIBLE here: a scheme body is fully classifiable where a JS body is opaque. Deriving from truth beats declaring and alarming on shape.

An optional `provenance:` declaration stays legal as a **drift door**: a declared role contradicting the derived classification throws `ProvenanceRoleShapeError` at bake. Consequence worth naming: capability defines are NOT all pure-prelude material — a define wrapping a port verb carries that role honestly, and the lineage classifier sees through capability vocabulary with the same visibility it has over program defines.

### 1.5 The baked shapes

```ts
export interface DefineSymbolDef {
  readonly kind: "define";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;            // normalized vectors (harvest/arity readers)
  readonly out: z.ZodTypeAny;
  readonly callable: boolean;           // procedure vs constant (§1.1)
  readonly body: string;                // the authored RHS expression
  readonly bodyHash: string;            // §1.3 identity
  readonly provenance: ProvenanceRole;  // DERIVED (§1.4)
  readonly declaredProvenance?: ProvenanceRole;  // drift-door input only
  readonly type?: string;               // harvest override, as everywhere
  readonly preludeOnly?: boolean;       // assembly-time-only helper define
  readonly validate: boolean;           // per-call decode gate (default true)
  // + singleOut / adoptArgs / emit / narrows / refPolicy / metadata — kind-agnostic valves
}
export interface DefineSyntaxSymbolDef {
  readonly kind: "define-syntax";
  readonly name: string;
  readonly doc?: string;
  readonly body: string;                // the expander lambda
  readonly bodyHash: string;
  readonly macroAttribute: "opaque" | "expression" | "binder";  // §3.4
  readonly preludeOnly?: boolean;
}
```

Both join `AEntity`; the capability apply loop evaluates `"define"` bodies against the assembly env and binds the wrapped closure, and `"define-syntax"` expanders through the same door `define-macro` takes. Evaluation order within a capability = declaration order (§2.3).

## 2. Body resolution discipline — wire-locality applied to declarations

### 2.1 The law

For every `symbol.define` body B of capability K:

```
FV(B) ⊆ SPECIAL_FORMS ∪ KEYWORD_SYNTAX ∪ ownNames(K) ∪ ⋃_{D ∈ transitiveDeps(K)} exports(D) ∪ resolverAnswered(K ∪ deps)
```

computed by `freeVars` on the parsed body, checked at bake. A violation is a bake-time teaching door naming the free name, the owning capability, and the fix ("declare a dep on the capability exporting X, or bind X in this capability"). This is the wire-locality law (`FV(wire) ⊆ params ∪ prelude-names`) applied one level down, to the vocabulary itself — it converts assembly-order luck (a body silently calling a co-resident capability's export with no declared edge) into a declared `deps` edge.

`KEYWORD_SYNTAX` is not a parallel hardcoded list — it is the keyword-typed exports of whichever capability binds them (`core` binds every evaluator special form as a `symbol.keyword` value), treated as an unconditional baseline of every vocabulary: no program can run without them, so they are never roster-optional.

`symbol.defineSyntax` bodies are OUT OF SCOPE for this law: a macro body's free names would name the EXPANSION env, a different question. Program-level macro call sites are handled by §3.4's firewall instead — which also closes the placeholder-token leak (`cut`'s `<>` is a pseudo-variable, not a free name) by construction rather than by a placeholder allowlist.

### 2.2 Export sets are first-class — and derived

`exports(K)` = the prefixed keys of `spec.symbols` ∪ the names of define/defineSyntax declarations. A derived, memoized getter, never an authored field (derivable ⇒ derive).

### 2.3 The binding model — one capability = one recursive scope, evaluated in order

**Letrec\*-style NAME VISIBILITY for FV analysis; SEQUENTIAL RHS EVALUATION.** For the §2.1 law, every name in K is visible to every other name in K regardless of textual order (a forward reference from a lambda body resolves at call time; mutual recursion just works). For evaluation, each RHS runs sequentially in declaration order against the accumulating scope — ordinary top-level `define` semantics: an eager, non-lambda RHS sees only what evaluated before it.

**Two-phase binding:** native/rosetta entries bind BEFORE any define/defineSyntax evaluates. A define body may always assume its capability's native/rosetta siblings are bound; the reverse never holds. Bake also enforces the one decidable ordering check: an **eager forward reference** — a non-lambda RHS whose free variables include a LATER own-name — is a bake door with the reordering fix named. Topological auto-reordering is excluded: order is authored, meaningful, and preserved 1:1.

## 3. The static validation pass

### 3.1 Contract

```ts
// src/static-validation/validate-program.ts

/** ONE reference site — where the program touched the problem. */
export interface SiteRef {
  readonly symbol: string;             // the name as referenced
  readonly span: SourceLocation;       // the referencing Pair (spans are total)
}

/** CASCADE FUSION: a Diagnostic is keyed by its CAUSE and carries the COMPLETE list of
 *  sites that cause explains. One missing `fs` key disabling require + require/extension,
 *  referenced 7 times, is ONE diagnostic with 7 sites — never 7 diagnostics. The grouping
 *  key is the CURE: the config key (c), the door (b), the unknown name (a). */
export interface Diagnostic {
  readonly severity: "error" | "warning";
  readonly code:                       // closed vocabulary, additive
    | "unbound-symbol"                 // bucket a
    | "bound-to-door"                  // bucket b
    | "missing-configuration"          // bucket c
    | "arity-mismatch";                // bucket d  (declared; no producer yet)
  readonly sites: readonly SiteRef[];  // every reference this ONE cause explains, in program order
  readonly message: string;            // host-facing: cause first, then the site list
  readonly publicMessage: string;      // agent-facing (the unbound-variable split, reused)
  readonly cause?: DoorCause;          // buckets b/c — the causal chain, structured
  readonly suggestions?: readonly string[];  // bucket a — SOUND subset only (§3.3a)
}
export function validateProgram(
  forms: readonly SchemeValue[],       // reader output — parse already happened
  vocabulary: ProgramVocabulary,       // §3.2
): readonly Diagnostic[];              // NEVER throws; ALWAYS the complete list
```

The eslint discipline is a type fact: the pass returns an array; only the CALLER decides to throw. `exec` aggregates error-tier diagnostics into ONE `StaticValidationError` carrying `.diagnostics`, thrown at parse phase before the first form evaluates — with zero side effects fired.

**Display discipline:** a content hash never appears in diagnostic text. Every identity in a message resolves to `name @ capability` (`require @ arrival/loader`); hashes are addressing keys for machines, and no Diagnostic field carries one.

### 3.2 The core data model — a reference graph with MISSING as first-class nodes

The pass is NOT a traversal that emits messages as it walks. It builds an explicit **reference graph** first — where a missing binding is itself a node — then derives every diagnostic as a graph query. (Traversal-encounter-order reporting yields nonsensical dependency traces; explicit graphs with missing-as-node is the design that survives.) Node kinds: `ReferenceNode` (one free-name occurrence), `BindingNode`, `DoorNode` (carries `DoorCause`), `MissingSymbolNode`, `MissingConfigNode`. The causal chain is a PATH in the graph, not prose — messages are assembled by walking it. Cascade fusion falls out structurally: group ReferenceNodes by the Missing\* node their resolution path terminates in — one missing node, one diagnostic, all sites attached.

```ts
export type VocabularyEntry =
  | { readonly kind: "value" }
  | { readonly kind: "keyword" }       // KEYWORD_SYNTAX — core's symbol.keyword entries
  | { readonly kind: "macro"; readonly macroAttribute: MacroWalkAttribute }
  | { readonly kind: "door"; readonly door: DoorSymbolDef };

export interface ProgramVocabulary {
  readonly names: ReadonlySet<string | symbol>;   // enumerable bindings
  lookupStatic(name: string): VocabularyEntry | undefined;
  readonly hasImpureResolver: boolean;            // §3.5 soundness switch
  readonly degraded: readonly DegradedCapability[];  // §3.7 — informational corroboration
}
```

Two constructors, one pass: **assembled mode** (exec / DiscoveryTool / runProgram) builds from the sealed `CompiledResolutionChain` + the run's session-scope names + the program's own top-level definition names — collected by a **macro-aware first sweep** recognizing `define`, `define-macro`, AND `define-syntax` heads (a sweep matching only literal `define` would report every later call of a program-defined macro as unbound — a guaranteed false positive on legal programs), recursing through top-level `(begin …)` splices. **Roster mode** (compiler front-end, editor tooling) builds from `EnvCapability.exports` over a declared roster, no `lower()` executed.

### 3.3 The buckets

**(a) `unbound-symbol`** — free variables per top-level form, minus vocabulary; one diagnostic per MissingSymbolNode, all sites attached. Suggestions ride the existing typo machinery, with one law on top:

> **Suggestion soundness law:** "did you mean X" may only offer names that would themselves VALIDATE under the present grants and config — the SATISFIED vocabulary subset, never doors. A suggestion that immediately re-errors on the next round-trip destroys agent trust faster than no suggestion. A door whose name is a close miss is not suppressed information: referencing it yields its own bucket-b diagnostic with the cure; the suggestion channel stays sound.

Severity: `error` against a pure chain; `warning` when `hasImpureResolver` (§3.5).

**(b) `bound-to-door`** — the name resolves, but to a door. Two mechanisms make this reportable: doors bind an introspectable `DoorProcedure` (an `AValue` in the `ACallable` union — `is_callable_value`/`z.lambda` stay sound) that throws the same teaching error when applied and exposes `.door` for static readers; and `DoorSymbolDef` carries a structured cause:

```ts
export interface DoorCause {
  readonly owner: string;              // owning capability name
  readonly needs: readonly { kind: "configuration"; key: string; hint?: string }[];
}
```

The door factory cannot know its owning capability (it runs inside a `symbols` record literal, before the `EnvCapability` wrapping it exists), so the capability's door bind arm stamps `cause` at apply time. `needs` carries only the `configuration` kind — the one derivable with no open question; a `dependency` kind would have to name an UNROOTED capability (deps are object edges, not string ids; an unrooted capability's doors never bind), which has no policy yet — the union grows additively when one is designed.

The message is assembled mechanically from the cause chain: `require — declared by arrival/loader, disabled in this assembly: configuration key "fs" was not provided. Referenced at 12:4; this program would crash there. Provide "fs" to enable it.`

**(c) `missing-configuration`** — in assembled mode, a door whose need is config (the message leads with the config key). In roster mode, the fused config schema diffed against the provided config bag. LIMIT: presence is key-membership; value-level validity is lower-time's job (§3.7's absent-vs-invalid line).

**(d) `arity-mismatch`** — declared in the code vocabulary; no producer yet. Scope when built: head-position direct applications of a fixed-tuple contract only — no flow analysis, no argument typing (the type-lens's job).

### 3.4 Macro calls — the false-positive firewall (the attribute is TERNARY)

`freeVars` walks unmodeled heads as plain applications — the correct over-approximation for the §2.1 law (a missed free name is the failure mode there), the **wrong direction for diagnostics** (a false "unbound" is poison: under-trigger, never guess). A macro call's arguments may not be expression space at all.

A boolean transparent/opaque attribute is UNSOUND: it conflates "arguments are ordinary expressions" (the threading family) with "arguments include FORMALS, a binding position" (`receive`, `let-values`, `and-let*`). Walking a binder macro as transparent reports its own formals as unbound — a guaranteed false positive on a legal program, in the error tier. Three surface grammars need three values:

| `macroAttribute` | Walk policy at call sites |
|---|---|
| `"opaque"` (DEFAULT) | interior contributes NOTHING to any bucket — no unbound reports, no arity checks inside. Under-report, never lie. Placeholder-token macros (`cut`/`cute`'s `<>`) are the canonical case; so is anything unaudited. |
| `"expression"` | every argument is ordinary expression space; walk normally. The threading family (`->`, `->>`, `~>`, `~>>`) and other alias/wrapper macros. |
| `"binder"` | treated as `"opaque"` until a binding-aware macro walker exists — the interior is a firewall blind spot, NOT walked as expressions. `receive`, `let-values`, `let*-values`, `and-let*`. |

`"binder"` is declared now because it is the honest classification (and doc/LSP surfaces want it), but it buys no walk precision yet: walking a binder correctly requires knowing WHICH argument positions bind and over WHAT scope — per-macro binding metadata a one-of-three enum cannot carry. Promoting a binder to walked status without that machinery re-opens the exact false positive the ternary closes. LIMIT: an `"opaque"`/`"binder"` interior is a diagnostic blind spot; a genuinely unbound name inside one surfaces only at runtime (the backstop, §3.5).

### 3.5 Soundness statement

**The contract: no spurious `unbound-symbol` errors, MODULO the excluded reachability strictness** — dead-branch references (`(if #f (missing) 42)`, §6.6) report by DESIGN and are not false positives; they are the one deliberate divergence from runtime semantics. Anything else that would produce a spurious unbound is a bug against this contract. The known leak classes are each closed by construction: keyword-syntax heads (the §2.1 baseline), binder-macro formals (the §3.4 ternary), program-level macro names (the §3.2 macro-aware sweep), internal-define sequences (R7RS internal defines have letrec\* semantics — a body-sequence pre-pass collects leading internal-define names before walking the sequence's forms, the same shape as the top-level sweep).

**The tier contract:** the `error` tier is SOUND — an error diagnostic is a proof the program cannot run as assembled. Anything the pass cannot prove degrades to `warning` or is not emitted (the macro firewall). Suggestions are the one explicitly-heuristic channel, labeled as such and bound by the §3.3a law. Every future bucket must declare which side of this line it is on before landing.

**Resolvers:** synthesized names (`c[ad]+r`, `:key` accessors) are absent from `names` by construction. The pass PROBES: for each candidate-unbound name, ask each compiled resolver step — sound iff the resolver is `pure` (name-stable results, exactly the license probing needs). An IMPURE resolver anywhere in the chain flips `hasImpureResolver`: every `unbound-symbol` degrades error → warning ("may be answered dynamically") — honesty over strictness, per-chain, visible, gone when the chain is pure.

**What stays undecidable (the runtime-door backstop, permanent):** computed heads (`((car ops) x)`); `eval`-family lookups; contents of files a runtime `require` loads; firewalled macro interiors (§3.4); glass mode (`{env}` — a live, embedder-mutable frame chain: no seal ⇒ no claims; the pass is simply not offered there). The pass narrows the runtime-surprise surface; it never claims to close it.

### 3.6 Where the pass runs — and why it is OPT-IN at `exec`

| Consumer | Mode | Posture |
|---|---|---|
| `exec` (generator-exec.ts) | assembled | `staticValidation: "on"` runs the pass after parse, before the form loop; error diagnostics throw ONE `StaticValidationError`. **Default `"off"`.** |
| `runProgram` / MCP `DiscoveryTool.call` | assembled | the program-scoped production entry points — they opt IN by passing `"on"`; DiscoveryTool serializes diagnostics as structured output before any eval, so an agent gets the complete list, not first-crash |
| compiler front-end / editor LSP | roster | diagnostics are the compile-error list / the squiggles |

**The opt-in posture is the design, not a staging compromise.** `exec` is the low-level PRIMITIVE that law suites and internal provisioning evals use to exercise RUNTIME behavior — deliberate runtime invariants like "a door resolves at lookup and fires at APPLY" and "an unbound typo throws the runtime did-you-mean at eval". A global default flip conflates the primitive with the program-scoped production entry points and turns those runtime invariants into parse-phase throws. Strictness is CALLER-scoped (§3.7's caller split): the entry points where a program is present to validate pass `"on"`, and `"on"` also opts that run's capability lowering into `degradation: "doors"` — so an absent optional config key surfaces as a parse-phase causal-chain diagnostic instead of a mid-run unbound throw. Glass runs never validate regardless (§3.5).

### 3.7 Door-set degradation — the lower() change that makes bucket (b) reachable

Without degradation, an unsatisfied optional-enabling config WITHHOLDS the symbol entirely — the validator (and the runtime) has nothing to attach a cause to; an unbound `require` looks exactly like a typo. Degradation replaces withholding with a bound-but-doored symbol. The rules:

- **"Assembly always succeeds" is NARROWED to absent-optional-input only.** Only the absence of an OPTIONAL enabling input (a config key whose schema marks it optional) degrades to a door-set. Two failure classes stay throw paths: **(i) present-but-invalid config** — a supplied value failing its schema is a host bug, not a feature-not-enabled state; degrading it would hide an error behind a door; **(ii) pack apply errors** — an exception from a capability's own bind logic is a defect, never a door. *Absent optional enabling inputs degrade; everything else that fails keeps failing loudly.*
- **Required config stays fail-closed.** A REQUIRED key that is absent is a `lower()` throw — degrading it would turn a provisioning error into a program-scoped shrug. This is security-sensitive for host-supplied callables: a required key validated by `z.custom()` with no predicate enforces nothing (absent config passes `lower()` and crashes as a raw TypeError at first call — neither fail-closed nor doored); "required" is only real when the schema actually rejects absence.
- **`degradation: "forbid"` is the DEFAULT; program-scoped callers opt into `"doors"`.** Host-side assembly (server boot, provisioning — assemble once, serve many programs) relies on fail-fast; converting its absent-config crashes into doors would change operational behavior underneath it. Program-scoped entry points (§3.6) opt in, making doors the effective posture exactly where a program is present to validate.
- **The kernel MINTS degradation doors.** A degraded capability binds every symbol it would have bound as a `DoorSymbolDef` with the mechanical cause (`owner` = capability, `needs` = the absent keys). Authored `notImplemented` doors and minted degradation doors are the same kind, different provenance.
- **Degraded capabilities are ENUMERABLE.** The assembly result carries a `degraded: readonly DegradedCapability[]` list — hosts and discovery read WHICH capabilities lowered degraded without probing symbols one by one; a monitoring host can alert on non-empty `degraded` even under `"doors"`.
- **Discovery-surface consequence, named honestly:** doors are enumerable bindings — an agent listing the environment sees `require` as PRESENT-but-doored where a withholding assembly shows nothing. That is the point (present-with-cause beats absent-and-silent), but catalog surfaces must carry the door marker so "present" is never read as "callable".

## 4. Prelude death

### 4.1 The population

The residue after decomposition: a handful of `prelude:` fields whose entire payload is `(require/register-extension …)` calls — genuinely CALL-shaped assembly wiring, not definitions (§4.3). Everything define-shaped is a declaration now.

### 4.2 Decomposition shape — two passes per pack

**Pass 1 — mechanical:** one `symbol.define` per value/procedure define (RHS-expression form, §1.1; `(define (f . a) …)` → `(lambda a …)`), one `symbol.defineSyntax` per macro with its `macroAttribute` audited and declared; adjacent `;;` comment blocks harvested as descriptions. Declaration order = textual order, 1:1.

**Pass 2 — contract authoring:** every define gets a REAL contract, authored per define (§1.2). This is judgment work — what IS `fold`'s honest input vector; which aliases are genuinely variadic-shapeless — and the migration's dominant cost.

**The gate is SEMANTIC EQUIVALENCE, not byte-identity:** enforced contracts WRAP closures, and error surfaces move (a wrong-arity call that failed inside the body now fails at the contract boundary, with a better message). The per-pack gate is the behavior suites + the scheme conformance ledger held exact. A contract faithfully matching a FIXED-ARITY body is equivalence-preserving even where the SRFI text specifies variadic behavior the body never implemented — widening the contract without reworking the body would admit arguments the body then drops, strictly worse than a clear contract-arity error.

### 4.3 The residue: `prelude` narrows to call-only bootstrap wiring

The surviving `prelude:` content is assembly-time registration calls evaluated after symbols bind. A top-level define in it is a teaching door pointing at `symbol.define`. Fully-declarative extension registration (an `extensions:` data field the loader consumes) would empty it entirely, but needs a kernel-level metadata channel nothing else demands — a handful of calls does not justify it.

### 4.4 What survives in the kernel

The phase-gated `preludeScope` overlay and `preludeOnly` survive unchanged: they were never about prelude TEXT — they are the assembly-phase binding channel that both the registration calls and `preludeOnly` defines stand on. Prelude death removes a text-blob idiom, not the phase machinery.

### 4.5 Enforcement cost — the perf budget

Wrapping hot recursive procedures in per-call zod decode is real overhead (identity schemas are `instanceof` checks — cheap; tuple normalization allocates). The hot recursive family (`fold`, `fold-right`, the `map` family — procedures that self-recurse per element, paying the boundary N times per list) carries a measured decode budget; a define that blows it gets the §1.2 `validate: false` valve WITH the measurement cited in a comment. The valve is evidence-gated, never reached for by default.

## 5. What it unlocks

Per-define provenance (the lineage classifier reads capability defines with program-define visibility, §1.4); cross-deploy identity (`bodyHash` gives the chain hash a value axis — scheme bodies are stable text where zod schemas don't hash; the display rule travels with it: hashes address machines, surfaces resolve to `name @ capability`); doc generation and discovery (name + description + contract signature + derived role = the catalog row, mechanically); and compiler lowering — capability defines as declared scheme text make the vocabulary itself lowerable to TS, with the referenced define set (FV ∩ exports, transitively) as the tree-shake.

## 6. EXCLUDED / LIMIT register

1. **Generalized prelude does not survive** — but the narrowed call-only bootstrap channel does (§4.3): registration calls are effects, not definitions.
2. **Full type inference / value-type checking — EXCLUDED, type-lens territory.** This pass = "will it resolve and dispatch"; the lens = "is it well-typed". The contract vocabulary is shared; the labor is divided.
3. **Dynamic `require` validation beyond reference detection — LIMIT.** What a required file binds is invisible statically; require-introduced names fall under the impure-resolver honesty downgrade (§3.5) or runtime doors.
4. **Static macro expansion + the binding-aware macro walker — DEFERRED (§3.4);** the ternary with an audited population is the honest interim.
5. **Glass mode — no claims (§3.5).** The pass is a property of capability-composed sealed envs.
6. **Reachability/flow analysis — EXCLUDED.** `(if #f (missing-fn) 42)` runs, and REPORTS under this pass — strictness by design (dead references are drift), the one place the pass is stricter than runtime semantics; the `staticValidation` knob is the opt-out (§3.6).
7. **TS declaration-site spans — LIMIT (§1.3):** capability#name is the address, not the authoring `.ts` file:line.
