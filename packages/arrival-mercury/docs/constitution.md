# Arrival → TypeScript Transpiler — Design

**Status:** v3 (fused) — the settled design, stated as decisions. Considered-and-rejected alternatives are recorded inline ("X was chosen; Y did not fit because Z") and in Appendix C's decision record. Review provenance: three adversarial triad rounds, a 28-agent component-spec fleet, two empirical probe suites, and a 4-auditor immutability audit — all folded.
**Date:** 2026-07-14
**Companion tracks:** type-strictness iteration (parallel agent; owns lens-leaf precision); foundation extraction plan (owns package/repo identity); the effect-query conflict-detection layer (designed, unimplemented — §2.3 pins the compiler's zero-coupling to it).
**Component specs:** the 9-spec fleet (+ README) that elaborated each subsystem was retired 2026-08-02 after `src/` landed one-to-one against it — the code is canonical now; see `docs/design-history/2026-07-component-spec-fleet.md` for the map and git history for the full texts. This document remains the constitution the implementation binds to.

---

## 0. TL;DR

A **type-directed, registry-driven transpiler** from arrival Scheme to **human-grade TypeScript**, plus a **typecheck layer** with two surfaces (source diagnostics on `.scm` spans; strict `tsc` on emitted output).

Three grounds, each already proven in this repo, combined here:

1. **The symbol registry** — every builtin carries one declaration (`Contract`: `input`/`output`/`type`/`cacheClass`/`provenance`). The compiler adds one field (`emit`) and becomes another reader of the same record.
2. **Type-direction** — the type-lens yields a real `tsc`-inferred type at every node. Emission picks each residual **by proof**: clean where the type justifies it, conservative where it doesn't. This is what makes a Scheme→JS correspondence sound where naive transpilers silently drift.
3. **Mercury's survivor lessons** (knowledge, not code): companion-lens architecture (analysis lives in queries over the tree; the backend is dumb), frame-as-query lookahead (imports derived from the finished body, never threaded as mutable state), DNF-as-variance, hard determinism laws.

Two language laws make the design markedly simpler than a general Scheme compiler: **immutability/no-dynamics** (§2.2 — no mutation, no continuations, by provenance-driven design) and the **declared effect model** (§2.3 — purity is read off the registry, never inferred). Together they license pure-region optimization (CSE, reorder, auto-parallel `infer`), delete whole analysis classes (escape/boxing, mutation-invalidation, const-vs-let census), and make narrowing proofs permanent.

The single load-bearing obligation: **the type pass and the emit pass must agree on Scheme semantics** (§5). The single load-bearing empirical unknown: **type availability on real code** (§9, Gate 1).

Enforcement instrument for everything: a **differential oracle** — the interpreter is the executable spec; compiled output must agree with it on a growing corpus. CI-gated from the first commit. The interpreter substrate was hardened for exactly this role (truthiness, nil-as-array, ratio numerics — Appendix C) and the representation planes now agree by construction.

---

## 1. Product definition

**Input:** an arrival program (entry `.scm` + required files + `.prompt` files + data) and a set of capabilities (the same inputs `buildArrivalSession` takes).
**Output:** a TypeScript project a senior engineer would accept as hand-written — or diagnostics explaining why not.

**"Human-grade", operationally:**

- **(a)** No interpreter scaffolding in output: no boxed values, no membrane calls. Hot symbols emit their idiomatic residual where the type proves it safe; unproven sites emit a *named runtime import* (per (c)) — conservatism is always a legible named call, never inline boilerplate.
- **(b)** Idiomatic residuals for the hot stdlib: `(car xs)` → `xs[0]`; `(map f xs)` → `xs.map(f)`; `(apply + xs)` → a reduce.
- **(c)** The cold tail compiles to **named imports from a runtime module** — which is how humans also write code (`import { assoc } from "./runtime.js"` is human-grade; an inlined 30-line assoc is not).
- **(d)** Explicit type annotations where the type plane knows something; honest `unknown` where it doesn't; never `any`, never a guessed shape.
- **(e)** Deterministic: same (source, config, type-snapshot) → same bytes.

**Two typecheck surfaces (the "typecheck layer" deliverable):**

1. **Source-level:** the type-lens runs as the compiler's front gate. Its diagnostics (span-lifted to `.scm` coordinates by `service-core`) become compiler diagnostics. Errors fail the compile; warnings/suggestions report and proceed (conservative emission covers the unproven).
2. **Output-level:** the emitted project must pass `tsc --strict`. CI gate. A *consequence* check — if residuals and annotations are honest it passes; a failure means a law was broken upstream.

**Totality:** every form either compiles or **doors** — a named, actionable error, never a silent miss or wrong output. Coverage target is **arrival's actual surface** (616 baked symbols, 91 already runtime doors), not R7RS.

**Registers:** `run` (executable: async plane, runtime axis, infer) and `read` (the glass projection: sync, legible). One engine; the register is a config field the emit rules read. **The read register relaxes Law F** — glass is never executed, so it prefers the clean residual even where unproven; legibility is its correctness criterion. The run register enforces Law F strictly. This resolves the conservative-vs-glass tension by product definition.

---

## 2. Grounds

### 2.1 The representation law

> **The compiled world is the membrane's JS face. The rosetta codec table is the representation contract for compiled values.**

The membrane defines, per value kind, what a Scheme value looks like on the JS side (`z.output` face): list → `Array` (`'()` → `[]` — emptiness never flips a list's JS type; and a dotted pair `(a . b)` → `[a, b]` — **lists, pairs, and vectors all lower to arrays** (⚖️ ruled); pair-vs-list is not a compiled-world primitive distinction, matching the membrane's existing one-way fold where `(1 2)` and `(1 . 2)` convert equal. The residual texture — interpreter `(cdr '(1 . 2))` yields the tail atom, compiled `.slice(1)` yields `[tail]` — is a catalogued divergence-by-design row, per-side asserted, corpus-avoided: arrival idiom uses dicts, not dotted alists), string → `string`, `#t/#f` → `boolean`, symbol → interned name, dict → plain object, bytevector → `Uint8Array`, all numbers → `number` (§7; `bigint` is an opaque host pass-through, not a scheme number). A compiled program **lives permanently on the JS side of the membrane**. So:

- The registry's `input`/`output` schemas describe compiled-world values too — one contract, many readers.
- The interpreter's *native* impls (boxed `AValue`s) do **not** transfer to the runtime library; the *rosetta* impls (JS faces) **do**. This predicts which symbols need new runtime-shim code (§4.4).
- Representation questions are answered by the codec table or doored — never invented ad hoc in the emitter.
- The membrane's container law: *ingress permissive (null→nil, arrays→borrowed vectors), egress canonical (nil→`[]`, lists→arrays, exact rationals→divided numbers); round trip is projection∘borrow, not identity.* The interpreter's egress face and the compiled representation therefore **agree by construction** — this is what makes the differential oracle's comparison plane trivial. (Status: enforced in the interpreter and pinned in law tests — Appendix C.)

### 2.2 The immutability law

**arrival-scheme is immutable and no-dynamics by design.** `call/cc`, `dynamic-wind`, and every mutation form (variable `set!`, `set-car!`/`set-cdr!`, `vector-set!`, `string-set!`, all linear-update `!` ops) are **prohibited at the language level** — they are incompatible with **non-exponential provenance** (a mutable cell's lineage becomes writers × readers; a re-entrant continuation makes the provenance DAG unbounded). The interpreter enforces this (purity.ts's invariant, the frozen-by-design doors, the conformance registry's purity exclusions).

Compiler consequences — deletions:
- `set!`/`call/cc`/`dynamic-wind` in source classify as **`Door(prohibited-dynamics)`** — a named door category whose message teaches the provenance rationale.
- **No mutated-binding census exists** (`collectSetBangNames`, const-vs-let analysis — heritage-era relics, deleted not ported). Every user binding emits as `const`, in both the virtual TS and the artifact.
- **No closure boxing or escape analysis exists.** Under immutability, capture-by-value ≡ capture-by-reference — lambdas lower to plain TS arrows capturing directly; the entire closure-conversion problem class never gets built.
- **The compiled world is acyclic by assumption** — without mutation, in-language code cannot construct a cyclic structure, so compiled list operations assume acyclic spines (no Floyd guards, no seen-maps). The interpreter keeps its cycle machinery for its two remaining cycle sources — reader datum-labels (`#0=(… . #0#)`, the sanctioned frozen-construction knot) and host-injected JS cycles through the membrane — neither of which reaches compiled code (no datum labels in compiled inputs is a compile-front check; host cycles behave as native JS does).

Compiler consequences — new soundness:
- **Narrowing proofs are permanent.** The mutation-invalidation trap class (a `set-cdr!` emptying a list after a `nonEmptyList` proof) does not exist. *Permanence is a property of the proof, not the binding* — control flow still narrows types mid-scope, so fact extraction remains per-occurrence (§5.3); what immutability deletes is the **invalidation axis**. Caching facts within a dominated region is a licensed performance optimization, never a semantics change. (The tempting collapse to a per-binding fact census was considered and rejected: it silently loses branch-narrowing precision — the natural misreading of "permanent.")
- **Pure double-evaluation is a perf note, not a correctness bug.** Hygienic temps (`fresh()`) are required only around *effectful* operands; pure conditions may evaluate twice (§5.2 Law T run-side).

### 2.3 The effect model

The language is immutable but not effect-free — and the effect taxonomy is **declared in the registry, never inferred**:

- **`infer` is pure**: contractually deterministic (`cacheClass: "pure"`; randomness is opt-in via reset-verbs), content-keyed and single-flighted by the InferStore — call count is not an observable; budget burn is an explicit side-channel outside semantics. Therefore **CSE across identical `infer` calls is sound**, and **data-independent `infer` calls may auto-parallelize** (`await Promise.all` by right — the fan-out LLM orchestration wants; an ASYNC-IFY pattern).
- **True sinks** (plexus effect-bursts, host writes — `provenance: "sink"`/`"opaque"`) are the ordered, never-deduped, never-reordered class. Their cross-scope discipline is the effect-query conflict-detection layer (queries read pure over the scope's snapshot; effects burst; conflicts detected per scope). **That layer is designed but not implemented in detail, and it is not a compiler dependency:** the compiler couples to exactly two declared registry fields — `provenance` + `cacheClass` — and one conservative rule — *sinks pin program order*. When the conflict layer lands, it refines the runtime's scope discipline; the compiler's contract does not change.
- **Every optimization gate (CSE, dedup, reorder, await-inlining, parallelize) reads `Contract.provenance` + `cacheClass`.** No effect-analysis pass exists or is needed.

### 2.4 Rejections (considered; did not fit)

| Considered | Rejected because |
|---|---|
| General inliner / beta-reduction of TS-source symbol bodies | No inliner exists to inherit (mercury prints user code verbatim); idiomatic-residual-by-inlining is a research subsystem; the rewrite table **is** the product |
| Matryoshka IR (mercury IR1 with an empty model layer) | Dead dual-world machinery that invites pseudo-markers; arrival is single-world |
| `emit` as TS-source string templates | No hygiene, no refactorability, injection-through-config, unparseable until compile |
| Library axis (ramda/lodash/fp-ts) as a compilation axis | It is a **semantics-transformation** axis (~15–35% clean correspondence; guards poison point-free; style is a per-library emission grammar). Survives only as an optional type-gated pure-HOF alt-lowering, post-core (Phase 4+) |
| A CoreForm-level async SCC fixpoint with per-symbol `invokesArg`/`argAsync` roots | The ASYNC-IFY residual-plane cascade replaces it: types are exact there, structure is explicit, and rules stay async-blind (Law W). The fixpoint's math survives inside the cascade |
| Full numeric tower / exact = bigint | One payload type (§7): ratio-of-safe-integers exacts, executed. Bigint representation was ruled and then superseded before its type-side ever shipped — the reversal cost only the interpreter atom |
| Warn-on-coercion channel for numerics | Dissolved by crash-on-overflow: overflow throws (the error is the observability), non-integral division constructs an exact rational (no event), transcendentals are inexact-by-spec-class (silent). Nothing left to warn about |
| Per-binding TypeFacts census ("proofs are permanent, so cache per variable") | False reading of permanence — control-flow narrowing is per-occurrence; collapsing extraction loses branch precision and Gate-1 clean-% (§2.2) |
| Deleting interpreter cycle machinery ("no set-cdr! ⇒ no cycles") | Reader datum-labels and host-injected cycles remain; the machinery is reframed (compiled world acyclic; interpreter keeps guards), not deleted |
| `__scmTruth` as an `is`-typed predicate in v1 | The plain-boolean wrapper is maximum-caution v1; the `x is Exclude<T, false>` predicate is the verified upgrade path (probe-proven: exact Scheme truthiness as narrowing), gated on the `(if x x 'fallback)` oracle family |
| Naive eta-by-default for value position | Eta'd params have no facts (Law F ⇒ guarded forever) and async-branching rules would freeze the wrong branch. `refPolicy` defaults to shim; eta is opt-in with facts from the instantiated use-site signature |
| Dooring improper pairs | Rejected by the representation ruling: lists, pairs, and vectors all lower to arrays — `(a . b)` compiles as `[a, b]`, matching the membrane's existing one-way fold. The residual cdr-of-dotted texture is a catalogued divergence row (§2.1), not a door |
| `residualEpoch` output pinning | Rejected by the regenerable-by-design ruling (§8): epoch pinning forks the compiler into frozen variants and withholds treadmill wins from committed outputs; determinism investment makes regeneration diffs meaningful instead |
| Evolve `@inhuman.tools/mercury` in place | Rejected for bias drift: building inside the old package lets old shapes steer new ones. Greenfield package + copy-as-chunk (§4.5); mercury untouched until cut-over |

---

## 3. Architecture

### 3.1 Pipeline

```
source.scm ──► parse (arrival-sugarcoat, spans on every node)
           ──► desugar + macro-expand (cut, ->, cond/when/unless, syntax-rules)   [engine]
           ──► CoreForm IR  — classify forms, mint node ids, keep spans           [NEW, small]
                  │
                  ├─► scope/naming — lexical-namer adapter (exists)               [keep]
                  ├─► TYPE PASS    — type-emit′ → virtual TS → ts.LanguageService
                  │       ├─ diagnostics → compiler front gate (surface 1)
                  │       └─ TypeFacts   → per-node fact table                    [NEW extraction]
                  └─► TCO / liveness — named-let→while, dead defines              [keep]

     (The two analysis branches are order-independent — Law V: the type pass is
      value-level and never sees async; asyncness is a residual-plane pass below.)
                  │
           ──► PEEPHOLES — named cross-node idiom rewrites over CoreForm (Law C)  [NEW, small]
           ──► EMIT PASS — engine walker (special forms) + registry rules (applications)
                  │            produces a SYNC-SHAPED Residual tree (pure data)   [REWRITE of lower.ts]
                  ├─► ASYNC-IFY — {sync, promise} typed dataflow over Residuals:
                  │            await at Promise-meets-value edges; Arrows flip async;
                  │            cascade to fixpoint (runtime-shim registrations seed)
                  ├─► LEGIBILITY — implicit destruction + pure-region CSE          [NEW]
                  ├─► FRAME — one scan of the finished tree: imports, runtime refs,
                  │            decls, exports, entry print (replaces census flags)
                  ├─► RENDER — Residual → ts.factory → ts printer                 [NEW]
                  └─► FORMAT — prettier/eslint tail (exists)                      [keep]
           ──► OUTPUT GATE — tsc --strict on the emitted project (surface 2)     [NEW gate]
```

### 3.2 CoreForm IR (new, deliberately small)

A classified, id-carrying view over the desugared parse forest:

```
CoreForm = Define | DefineFn | Lambda | If | And | Or | Let | NamedLet | Begin
         | Quote | App | Ref | Lit | Dict | Require | Door
```

There is no mutation node — `(set! …)` classifies as `Door(prohibited-dynamics)` (§2.2). `And`/`Or` are CoreForm nodes, not desugared: `(or a b)` with an effectful `a` needs a hygienic temp (a desugar would double-evaluate it), and condition-position `and`/`or` of predicates must reach the type pass intact for the narrowing-form grammar (§5.3) to compose. `not` stays an ordinary symbol; the grammar recognizes `App(not, [NForm])` structurally.

- **Why it exists:** `lower.ts` and `types-emit.ts` each re-pattern-match heads today — duplicated dispatch, no stable node identity for side tables. CoreForm kills both.
- **What it is not:** a second rich AST. It is a thin classification with spans preserved; unknown shapes classify as `Door(reason)`.
- **Attribute discipline (the Roslyn lesson):** the IR is immutable; every analysis result — resolved names, TypeFacts, async bits, residual decisions — lives in **side tables keyed by node id**. No mutable context bags threaded through emission (mercury's documented `LowerCtx` scar is exactly what this forbids).

### 3.3 TypeFacts — the membrane between tsc and emit

The type pass runs the evolved type-lens and extracts, per CoreForm node, a **closed, pure-data fact vocabulary**:

```ts
interface TypeFacts {
  boolean?: true;              // condition is provably boolean
  nonEmptyList?: true;         // [T, ...T[]] — indexing proven safe
  lengthAtLeast?: number;      // tuple-prefix depth — powers lens warnings on unproven cxr uses (Law U)
  list?: true; pair?: true;    // both array-backed (§2.1 — pairs are not a separate primitive); pair? adds non-emptiness
  elementFacts?: TypeFacts;    // a list's ELEMENT facts (feeds eta'd rules in HOF positions)
  callable?: { arity?: number; paramFacts?: TypeFacts[] };  // instantiated signature at THIS use site
  stringy?: true; numeric?: true;
  // extended only by adding fields; consumers must tolerate absence
}
```

- **Law F (fail-safe facts):** absence of a fact ⇒ the conservative residual. Unmapped spans, `any`/`unknown`, extraction failures — all land safe, never clean.
- **Asyncness is not a TypeFact** — it lives exclusively in ASYNC-IFY (Law W). A `callable.async` fact would be a second source of truth that can disagree; forbidden. (The lens types Scheme's value semantics, where async does not exist — Law V.)
- **Exactness is not a TypeFact** — there is no runtime numeric representation to dispatch on (§7).
- **Value-position facts:** a symbol used as a value (`(map car xss)`) carries the **instantiated signature at that use site** — tsc has instantiated `car<T>` against `xss`'s element type; `callable.paramFacts` delivers it. This is what lets an eta-expanded rule emit clean bodies (§4.2).
- **Why a fact vocabulary instead of `ts.Type`:** (1) layering — emit rules live in arrival core, which must not depend on `typescript` (§4.5); (2) testability — the emit engine runs on synthetic facts, no tsc in the loop; (3) discipline — every new "the type tells us X" idea must be named, reviewed, and oracle-tested before a rule can consume it. **Growth discipline:** a fact lands only as a package deal — leaf change + extraction rule + consuming emit branch + oracle rows, in one reviewed change.
- Extraction mechanics: the existing `Mapper` (ts offset ↔ scheme span) + batched `LanguageService` queries — the same machinery `service-core` runs per keystroke; per-compile cost is a non-issue.

### 3.4 The Residual algebra (what emit rules produce)

A small pure-data expression/statement algebra — the compiler's internal target language:

```
R = Ref(binding) | RuntimeRef(symbol) | Lit(value) | Template(parts)
  | Call(R, R[]) | New(R, R[]) | Method(R, name, R[]) | Index(R, R) | Member(R, name)
  | Bin(op, R, R) | Un(op, R) | Cond(R, R, R) | Arrow(params, body, async?)
  | ArrayLit(R[]) | ObjectLit(entries) | Spread(R) | Await(R)
  | Block(stmts) | Const(pattern, R) | Let(pattern, R) | Assign(pattern, R) | Return(R)
  | While(cond, body) | ForOf(pattern, iterable, body) | Continue | Throw(R)
  | Comment(text, R) | Annotated(R, tsType)

pattern = binding | ArrayPattern(patterns) | RestBinding(binding)
```

The **declaration layer** (module frame) is a separate, smaller set consumed only by FRAME/renderer: `FnDecl | ConstDecl | Import | ImportType | Export` — keeping module structure out of `R` stops the expression algebra creeping toward "all of TS."

~22 constructors, frozen small; additions require a demonstrated emit-rule need + renderer support + oracle coverage. Decisions encoded here:

- **No raw-text node.** Hygiene by construction; every name is a `Ref` to a namer-resolved binding or a `RuntimeRef`.
- **`Let`/`Assign`/`ArrayPattern`-reassign are engine-minted loop machinery only** (named-let→while TCO, ForOf accumulation) — the language has no user mutation (§2.2). `ArrayPattern` assign carries the simultaneous multi-var invariant (`[a,b] = [x,y]`, never sequential). `ForOf` serves the ASYNC-IFY sequential-await rewrites (async `fold` → accumulating for-of; async `for-each` → awaited for-of) and readable multi-list zips. `New` serves the framework message-class residuals. `Continue` is the TCO loop step; no labels — each named-let compiles to its own `while` (`selfTailOnly` refuses cross-loop tail rewrites).
- **`RuntimeRef(symbol)` is the frame-as-query mechanism.** A rule that needs a runtime helper emits a `RuntimeRef`; it never touches imports. FRAME scans the finished tree once and materializes exactly the imports that occur — deleting every mutable census flag in today's `lower.ts`.
- **Expression/statement duality lives in the renderer, once.** A `Block` in expression position renders as an IIFE (async-awaited inline when it awaits); at statement position, a bare block. Rules return the natural shape.
- **Rendering via `ts.factory` + the TS printer**, then prettier — parenthesization/precedence correct by construction (`recv()`-family scars retired structurally); comments ride `Comment` nodes as **leading** synthetic block comments only (trailing attachment + prettier relocation is a known weird-output source; one convention + Phase-1 golden tests).
- **Renderer assertions:** every `Await` is pass-minted (rule residuals are checked await-free at bake — Law W); `Await` under a non-async boundary is an internal error, fail loudly. `Arrow` params admit array patterns (the `destructureTuple` invariant) and rest bindings.
- **Deliberately absent:** `Try` (⚖️ ruled: `guard`/`with-exception-handler` door in v1 with a named category; `Try` is designed in Phase 2 when the first real corpus program demands it — demand-driven, matching the native-tail policy); generic type parameters on emitted functions (the type plane emits monomorphic signatures with honest `unknown`; generics are a later annotation upgrade); source maps (Residual nodes carry origin spans; `.scm`→TS sourcemap emission is v1.5, not gate-load-bearing).

### 3.5 Engine passes (whole-program work no record can decide)

| Pass | Status | Notes |
|---|---|---|
| desugar / macro-expand | keep | macros expand **before** CoreForm — front-end, not registry |
| scope + naming | keep (done) | `scheme-scope.ts` already adapts `@here.build/lexical-namer`; predicate-yields-bare-name ladder preserved |
| special-form emission | rewrite onto residuals | `if`/`let`/`named-let`/`lambda`/`define`/`begin`/`quote` + truthiness-directed conditionals (§5.2); `set!`/`call/cc`/`dynamic-wind` → `Door(prohibited-dynamics)` |
| **PEEPHOLES** | new, small | named cross-node idioms over CoreForm (Law C): `(car (infer …))` scalar-fold, `(apply map list rows)` transpose. Each named, oracle-covered |
| **ASYNC-IFY** | new | post-emit `{sync, promise}` typed dataflow over Residuals (Law W): await at Promise-meets-value edges; `Promise.all` and `ForOf` rewrite patterns; cascade to fixpoint; unknown edges over-await (safe). Seeds: runtime-shim registrations' async bits. **Data-independent pure sources (`infer`) parallelize by right** (§2.3) |
| **LEGIBILITY** | new — first-class invention | (1) *implicit destruction*: an `Arrow` whose param occurs only under `Index(·, Lit(k))` rewrites to an `ArrayPattern` with minted positional names (`[head]` for 0-only; ordinals `[first, second, …]` above), composing with the car-collapse: `(lambda (pair) (+ (car pair) (cadr pair)))` → `([first, second]) => first + second`; (2) *element-name singularization*: HOF callback params minted from the collection's name (`examples.map((example) => …)`; `(:scores c)` → `score`; `acc` reserved) as `fresh(hint)` derivation; (3) **pure-region CSE**: repeated pure subtrees (gate: `provenance`+`cacheClass`, §2.3 — identical `infer` calls included) hoist to a shared `Const` — sound under immutability, directly serves human-grade output. All name-minting feeds the lexical-namer candidate ladder — collision-safety comes from the resolver. The string-regex `destructureTuple` becomes exact-by-construction on the Residual tree |
| TCO named-let→while | keep | simultaneous multi-var reassignment invariant |
| imports / require planning | keep | data-requires keep their loader-registry shapes |
| dead-defines shake | absorbed into FRAME | it *is* a query over the finished tree |
| project assembly | keep | pinned deps (npm-version-pinning rule), collision guard, entry print |
| format tail | keep | prettier/eslint |

---

## 4. The symbol registry

### 4.1 The field

```ts
// on Contract<I, O> (foundations/arrival/arrival/src/common/symbols/_bake.ts)
emit?: EmitRule;

// Compiler-facing metadata (all optional, all static):
narrows?: { witness: string };   // this symbol's leaf narrows (is-predicate / non-empty overload);
                                 // `witness` names the runtime symbol that PROVES it (Law N).
                                 // Also the narrowing-form-grammar exemption set (§5.3).
refPolicy?: "eta" | "shim" | "door";  // value-position behavior; DEFAULT "shim".

interface EmitRule {
  /** Application position: (sym a b …) → residual. The idiomatic rewrite. */
  call(args: R[], ctx: EmitCtx): R;
  /** Value position (rarely hand-written; see refPolicy). */
  ref?(ctx: EmitCtx): R;
}

interface EmitCtx {
  argFacts: TypeFacts[];        // per-argument, Law F applies
  selfFacts?: TypeFacts;        // contextual/expected type when known
  config: EmitConfig;           // register (run|read), framework axis, opinions
  fresh(hint: string): Binding; // hygienic temp via the namer's reservation pass
  runtime(symbol: string): R;   // sugar for RuntimeRef
  door(reason: string): never;  // typed refusal — surfaces as a compile diagnostic
}
```

Rules are **async-blind** (no `argAsync` — Law W owns asyncness) and **effect-blind** (the optimization gates read `provenance`/`cacheClass` at the engine level, not in rules). The field is named `emit` because `lower` is a three-way collision in this codebase (`type-layer/lower.ts`, `EnvCapability.lower()`).

**Value-position policy (`refPolicy`).** Default **`"shim"`**: value position emits `RuntimeRef(sym)` — always a correct function value. **`"eta"`** is opt-in for fact-driven-or-structural rules (`car`, `cdr`, accessors, predicates): eta arity + per-param facts come from the **instantiated use-site signature** (`facts.callable`) — `car` passed to `map` over `xss: [number,…][]` instantiates to `(xs: [number, ...number[]]) => number` → `nonEmptyList` param fact → `xss.map(x => x[0])`. No instantiated signature ⇒ shim (Law F's value-position analog). ⚠ Whether the lens delivers instantiated signatures in argument position is this design's one unverified extraction assumption — a named Gate-3 golden; on failure, eta degrades to shim (sound, less pretty). **`"door"`** is reserved for genuinely un-compilable first-class uses — expected rare, since ASYNC-IFY patches stored-HOF call sites contextually where types hold.

### 4.2 The fallback ladder (per symbol, in order)

1. **`emit.call` rule** — the idiomatic residual (hot symbols; today's `STDLIB` knowledge relocated here).
2. **eta-`ref`** — per `refPolicy`.
3. **`RuntimeRef` shim** — a named import from the runtime module. Correct, readable, honest. The default for the un-ruled tail.
4. **`door`** — a named compile error.

Silence is impossible by construction.

### 4.3 Worked rules (the shape of the knowledge relocation)

```ts
// car/cdr/cons — REPRESENTATION-COLLAPSED: syntax over the array representation,
// not library symbols. No guard, no shim, no mode. Law U: car-of-empty is R7RS
// "is an error" = outside the contract; the lens WARNS at compile time on unproven
// car, the artifact stays clean. The cxr family is pure index arithmetic:
// cadr → xs[1], cddr → xs.slice(2), caadr → xs[1][0].
car:  { call: ([xs]) => Index(xs, Lit(0)) },
cdr:  { call: ([xs]) => Method(xs, "slice", [Lit(1)]) },
cons: { call: ([x, xs]) => ArrayLit([x, Spread(xs)]) },

// map — sync-shaped ALWAYS (Law W: rules never see asyncness). If f is async,
// ASYNC-IFY sees Promise<B>[] meeting a B[]-consumer and rewrites to
// await Promise.all(xs.map(f)) at the consuming edge.
map: {
  call: ([f, ...lists], ctx) =>
    lists.length === 1
      ? Method(lists[0], "map", [f])
      : zipWithResidual(f, lists, ctx),   // multi-list: index-zip (the arity bridge)
}

// + — plain fold (§7: one number type, no dispatch exists)
"+": { call: (args) => foldBin("+", args) },

// infer — the runtime axis collapses into ONE config-branched rule
// (deletes rt-langchain.ts + rt-vercel-ai.ts as files)
infer: {
  call: (args, ctx) =>
    ctx.config.register === "read" ? readInferResidual(args)
    : ctx.config.framework === "vercel" ? vercelInferResidual(args, ctx)
    : langchainInferResidual(args, ctx),
}
```

### 4.4 The runtime module (rung 3)

- **Rosetta symbols:** their `impl` already operates on JS faces — the impl is the shim body.
- **Scheme-bodied builtins (186 `define`-kind symbols): self-host.** `BUILTIN_PREAMBLE` is arrival source; compile it with this compiler. Staged bootstrap: **Stage 0** (Phase 1) — a hand-written shim set for the slice's conservative paths (equality walkers — ~5 modules; no car/cdr/cons, no numeric dispatchers; `quotient`/`modulo` are slice *rules* with fixed inline residuals, not shims). **Stage 1** (Phase 3) — compile the preamble as one compilation unit (intra-preamble calls are local `Ref`s; natives resolve to stage-0 shims); **preamble-closure gate:** zero doors, with a static door-scan of the 186 in CI from Phase 1 so the Phase-3 surface is known early. **Stage 2** — dogfood; hand-polish only with oracle equivalence. `define/overridable` compiles as a plain `const` with the default baked (per-run overrides are an interpreter-session feature). The runtime module is a generated artifact: its *API* is the human-grade surface; its bodies are whatever the emitter produces — not marketed as hand-written.
- **Native contours (260):** boxed-world impls don't transfer. Hot → emit rules; warm → hand shims by corpus frequency; cold → door until demanded. The one place new code is genuinely owed — bounded and demand-driven.
- **cxr family:** `car`/`cdr` get registry rows (retiring the hand-authored `carriers-text.generated.ts` type duplicate); the generative `caddr`/`cddar`… family stays a procedural decoder composing the two rules.

### 4.5 Layering

Per `.claude/rules/env-quasi-packages.md` (split only to isolate an external dep or publish independently):

- **IN arrival core:** `Residual`, `TypeFacts`, `EmitRule`/`EmitCtx` **types** + the emit rules on stdlib Contracts — pure data, dependency-free, leaf modules. No `typescript` import in this layer (the `type-layer/index.ts` co-bundling anti-pattern is the named counter-example).
- **OUT (the compiler package):** everything touching `typescript`, the lens service, `ts.factory`, prettier — reads contracts, interprets residuals. Identity (⚖️ ruled): **a new greenfield package** (working name `arrival-mercury`, matching the spec directory). Evolve-in-place was considered (the asset audit shows ~half of mercury's files survive) and rejected for **bias drift** — building inside the old package lets the old shapes steer the new ones. Surviving knowledge arrives by **copy-as-chunk**: grab mercury files freely as raw material, into the new tree, re-homed and re-judged — never shared imports. `@inhuman.tools/mercury` stays untouched as the production bridge until cut-over.
- **Capability-contributed symbols** (e.g. `infer`) carry their emit rules on their own Contracts; the compiler **harvests** contracts without arming resources (precedent: the lens already harvests host preludes from the same declarations). Builder-form capabilities need a dry-harvest path; emit rules are static by rule — wanting activation state is a bake-time error.

---

## 5. Two-pass soundness — the keystone

The type pass proves facts over **virtual TS** (`__arr.car(xs)`, ambient leaves); the emit pass produces **raw residuals** (`xs[0]`). If the two disagree on semantics, the result is *justified-by-wrong-type drift* — worse than typeless bugs, because it carries a typechecker's blessing.

### 5.1 The live bug this section exists to prevent (and fix)

Interpreter (ground truth, verified): `(if 0 'a 'b)` → `'a`; `(and 0 1)` → `1` — only `#f` is false. Today's mercury emitters compile both with JS truthiness (`0 ? … : …`, `0 && 1`) — live wrong-code, Phase 0's target. On the type side, tsc does **not** type-fold plain ternaries (probe-verified on 6.0.2 + TS7-native); the real hazard is **truthiness narrowing of arm references to the tested value** — `(if x x 'fallback)` narrows the true-arm `x` under JS truthiness, wrongly dropping Scheme-truthy `0`/`""` and minting false facts. Law T's wrap defeats exactly that shape; the oracle's primary type-side proof row is `(if x x 'fallback)`.

### 5.2 The laws

- **Law T (truthiness).** *Type-emit:* wrap every condition in `__scmTruth(c)` **unless** it matches the narrowing-form grammar (§5.3). The wrap is unconditional outside the grammar because self-reference can appear through any alias or refactor. Wrapper signature: v1 `(x: unknown) => boolean` (blocks all condition-value narrowing); the verified upgrade path is `__scmTruth<T>(x: T): x is Exclude<T, false>` — exact Scheme truthiness *as* narrowing (probe-proven; on self-referencing arms its "fold" is the semantically-correct arm type), gated on the `(if x x 'fallback)` oracle family. *Run-emit:* `facts.boolean` → bare `c ? a : b`; otherwise `c !== false ? a : b` (exact Scheme truthiness — `#f` compiles to `false` by the representation law). `not`: `!c` when boolean, `c === false` otherwise. `and`/`or`: all-boolean → `&&`/`||`; **effectful operands** get the guarded form with a `fresh` temp; **pure operands may double-evaluate** (§2.2 — the temp is effect-discipline, not mutation-discipline).
- **Law N (narrowing-as-proposition, mechanical).** Every narrowing leaf — `is` predicates, non-empty overloads, brands — is a proposition **the compiled runtime must prove**. Enforcement is CI, not culture: each `narrows` Contract names its `witness`; the schema-driven fuzzer (§5.4) generates oracle rows from the Contract's own `input` schema; a narrowing leaf without witness + rows is a red build. This lets the types track add leaves aggressively without outrunning the proof burden. Immutability makes every proven narrowing *permanent* (§2.2) — the proposition, once witnessed, cannot be invalidated downstream.
- **Law A (arg-gating).** Residual selection keys on **argument** facts, never result types. `car: (xs: List<T>) => T` returning `T` proves nothing about indexing; `xs: [T, ...T[]]` does.
- **Law C (context patterns).** Cross-node idioms live in **named engine peepholes** over CoreForm (§3.5) — never in rules peeking at parents or result types. Law A stays absolute for rules; Law C is the sanctioned home for the exceptions.
- **Law W (await ownership — ASYNC-IFY).** Rules never mint `Await` and never see asyncness; they emit sync-shaped residuals. One post-emit pass runs a `{sync, promise}` typed dataflow over the Residual tree — seeded by the **runtime-shim registrations' async bits** (asyncness cannot ride `Contract.type`; Law V keeps it value-level) — and applies one local rule: **await lands where a Promise-typed edge meets a value-consuming position**. Enclosing `Arrow`s flip async; the cascade runs to fixpoint. A small rewrite table covers what insertion can't: `Promise<T>[]` meeting a `T[]`-consumer → `await Promise.all(…)`; sequential-await shapes → `ForOf`; `Promise<T> | T` unions just await; **data-independent pure-source calls parallelize** (§2.3). Unknown-typed edges over-await (identity on non-Promises — safe). **Immutability dividend: no state-hoisting temps around awaits** — nothing can change across a suspension, so pure subexpressions inline directly (`g(xs[0], await f(x))`). Renderer asserts every `Await` is pass-minted.
- **Law F (fail-safe facts).** No fact ⇒ the conservative residual (canonical case: no `facts.boolean` → the `!== false` guard). Extraction holes, `any`, unmapped spans land safe. The failure mode of this design is always "uglier output," never "wrong output" — within defined programs (Law U).
- **Law U (undefined behavior).** Forms R7RS declares "is an error" — `(car '())`, out-of-range indexing — are **outside the compilation contract**: compiled behavior is whatever the representation-collapsed JS does (`[][0]` → `undefined`). The oracle corpus contains only defined programs; UB forms live in a diagnostics-check set where the **lens warns at compile time** (the zimmerframe teaches; the artifact stays clean). Intent-over-materialization applied to errors: no editorial guard layer over the platform's semantics.

### 5.3 The pass-agreement contract

- **Law V (value-level lens).** The type pass types **Scheme's value semantics**, where async does not exist (`infer` types as `List<string>`, never `Promise<…>`). The virtual TS carries no async structure; TypeFacts carry no asyncness; there is no async-mirror obligation. Asyncness is an artifact-plane property owned by ASYNC-IFY; the two planes meet only at render (`promiseWrap(schemeType, asyncBit)` for output annotations). One owner per plane — they cannot disagree because they never speak about the same thing.
- **The narrowing-form grammar (Law T's exemption, made semantic).** A condition emits **unwrapped** in the virtual TS iff it is a narrowing form: `NForm ::= App(sym flagged narrows, …) | (not NForm) | (and NForm…) | (or NForm…)` — the boolean algebra lowered to native `!`/`&&`/`||` so tsc's narrowing **composes** (`(if (not (null? xs)) (car xs) …)` and `(if (and (pair? x) (pair? (cdr x))) …)` are the dominant guard shapes; without composition, facts never flip clean and Gate 1 is structurally unreachable). Everything else wraps. The gate is a **static registry flag**, not a type fact — facts don't exist at type-emit time (the pass produces them; fact-gating would be circular). CI: `narrows` ⊆ the Law-N witness registry. User-defined `?` functions are simply not in the registry → wrapped; arrival has no annotation surface with which to smuggle a literal-typed predicate past widening.
- **Fact extraction is per-occurrence and flow-sensitive.** Facts are read at each occurrence's mapped offset — tsc's control-flow type at that position. *Permanence is a property of the proof, not the binding* (§2.2): per-occurrence extraction remains because control flow narrows mid-scope; immutability deletes only the invalidation axis. Mapper holes ⇒ Law F.
- **Cross-pass fixtures.** Gate 2 includes per-node-id diff tests: for each bug-cell program, (virtual-TS snippet, extracted facts, chosen residual) triples asserted against golden — a lens change that silently shifts a fact→residual decision becomes a visible diff. Ownership (⚖️ ruled): **typefacts-extraction's test surface** — the triple's first two elements are its outputs, the residual is a read-only third column; it *reuses* the oracle's `corpus/*.scm` sources as inputs while the oracle itself stays black-box (two tests, one corpus, two owners).

### 5.4 The enforcement instrument: the differential oracle

**The interpreter is the executable spec.** For every corpus program: `eval_interpreter(p) ≡ run(compile(p))`, compared through the membrane's JS face — which the representation law makes trivially shared (both sides are plain values; the interpreter's egress face equals the compiled representation by construction).

- **Seeded** with the bug-cell corpus (Appendix B).
- **Grown by a schema-driven fuzzer:** each Contract's `input` zod schema is a value generator — for every narrowing leaf, generate `(if (pred x) (use-narrowed x) 'skip)` programs across schema-sampled values. A narrowing leaf without oracle rows fails CI (Law N's mechanism).
- **Extended with real programs** (the Gate-1 corpus).
- **Divergence-by-design rows** assert per-side, not equivalence (e.g. exact overflow: interpreter throws, artifact floats on — Appendix B).
- **Error equivalence:** both-throw passes at error-class level; message text may drift.
- **CI-gated from the first prototype commit** — we own a reference implementation; differential testing against it is cheap and merciless.

---

## 6. Preserved-knowledge ledger

Hard-won invariants from the current emitters, each with its landing site. Deleting the code is fine; deleting these is not.

| Invariant | Landing site |
|---|---|
| IIFE-vs-block (expression vs statement position; async IIFE awaited inline) | Renderer, once (§3.4) |
| `recv()` parenthesization, `(await x).f`, immediate-lambda-callee parens | `ts.factory` construction (structural) |
| named-let→while with **simultaneous** multi-var reassignment | TCO engine pass |
| kwargs → single trailing options object | App-emission in the engine walker |
| Determinism orderings (UTF-16 comparator, declaration-order imports, insertion-order maps) | FRAME + renderer; CI double-compile check |
| The arity bridge (multi-list map index-zip; `apply`→reduce with correct identity) | `map`/`apply` emit rules |
| cxr decomposition | pure index arithmetic under the representation collapse |
| Implicit destruction + element-name singularization — the third legibility invention (with lookahead-frame and DNF-fold) | LEGIBILITY pass (§3.5); candidates feed the lexical-namer ladder |
| No closure boxing — capture-by-value ≡ capture-by-reference | §2.2; lambdas lower to plain arrows, permanently |
| infer scalar-fold + cache-key-elide | named engine peephole (Law C) |
| Predicate-yields-bare-name naming tie-break | lexical-namer ladder (already lives there) |
| Over-await is safe, under-await is not | ASYNC-IFY unknown-edge fallback |
| `__tieKnot` is sanctioned frozen-construction (reader datum-labels), not a mutation loophole | interpreter-side; rename to reflect role; never "cleaned up" |
| Doors, not silent misses | `door()` in EmitCtx + `Door` CoreForm |

---

## 7. Numerics — one payload type ✓ EXECUTED

Every scheme number's payload is a JS `number`. **Exact = a safe-integer ratio** `(num, denom)` (both `|x| ≤ 2^53−1`, gcd-normalized, `denom > 0`); inexact = one `number`. Zero bigints in the representation (`bigint` is an opaque host pass-through with an explicit `bigint->number` conversion verb).

- **Exactness is a guarantee:** an exact op whose result components would leave safe range **throws a teaching error** (R7RS §6.2.3 sanctions reporting) — never a silent coercion. The only exits from the exact domain are an authored inexact operand or that error. Non-integral exact division constructs the rational — no event, no warn (the warn channel was considered and dissolved: overflow throws, division is exact, transcendentals are inexact-by-spec-class).
- **Interpreter:** `AExact`/`AInexact` boxes; `exact?`, `eqv?`, printing (`1/3`, `5.0`) faithful. Egress divides: `toJS(1/3)` = `0.333…` (projection∘borrow).
- **Artifact:** plain number arithmetic — `(+ a b)` → `a + b`, `/` = JS division. Exact-rational richness and the overflow guarantee are interpreter-plane; the artifact floats on where the interpreter throws (a catalogued divergence-by-design, like runtime exactness introspection generally, which doors in the artifact). `quotient`/`remainder`/`modulo` keep Scheme sign conventions (operator-identity). `(= 1 1.0)` is natively correct.
- **Status:** landed in full — interpreter atom, encode-edge exactness law, membrane demotion, conformance ledgers re-verdicted, downstream green (Appendix C). The oracle's representation risk is closed. Bitwise ops are doored in both worlds ("here lieth the dragons": JS operators truncate to 32 bits; correct wide bitwise needs the arbitrary-precision ALU the representation deliberately lacks).

---

## 8. Determinism, stability, and the strictness treadmill

- **Within a compile:** pure functions over (CoreForm, facts, config) → same bytes. CI: compile twice, byte-compare.
- **Across type-strictness cycles:** tightening leaf types flips conservative→clean residuals — emitted text changes with no source change. Stance (⚖️ ruled): **always regenerable, by design — for every workflow, eject included.** No `residualEpoch` pinning exists. (An epoch config freezing residual decisions across lens upgrades was considered and rejected: it forks the compiler into epoch-frozen variants and withholds treadmill wins from exactly the committed outputs that live longest.) The investment goes into **deterministic-generation stability** instead — the determinism laws and orderings are what make regeneration diffs small and meaningful, reviewed on the lockfile-churn model; a residual flip in a diff is information (the lens learned something), not noise.
- The type snapshot hash + compiler version ride an artifact header comment — reproducibility is diagnosable.

---

## 9. Migration plan and gates

**Greenfield package, staged cut-over (⚖️ ruled):** the new compiler grows in its own package (`arrival-mercury`, §4.5); `@inhuman.tools/mercury` stays untouched in production until parity. Copy-as-chunk replaces evolve-in-place — mercury's surviving files (parse/desugar/scope/TCO/imports/assembly/format, per Appendix A) are raw material to grab, never shared imports; the genuinely new subsystems (CoreForm, TypeFacts extraction, the Residual renderer, ASYNC-IFY, the registry field) are built clean, free of the old package's shape bias. Every phase oracle-gated.

**Oracle subject-routing (the dual-path rule).** From Phase 1 on, the gate subject is **the new pipeline with `RuntimeRef` fallback for un-ruled symbols** — every bug-cell row runs end-to-end through it (a shim is a legitimate residual; Law F says so). Rows additionally pin which cells must exercise a *rule* rather than a shim (the coverage matrix), because **shim-green ≠ rule-green**: a cell passing on a stage-0 shim proves nothing about the hand residual Phase 2 introduces for it. The legacy string path is a production bridge only — never gate-authoritative, and **no new STDLIB knowledge lands in `lower.ts` after Phase 1 starts**.

**Golden discipline (two golden sets, epoch-stamped).** Phase 0's rebase is a *legacy-path characterization snapshot* — it keeps the production bridge diffable and never judges the new pipeline (string-path bytes vs `ts.factory`+prettier bytes is a guaranteed structural mismatch, not a quality signal). New-pipeline goldens are a separate set, baselined **once at first residual-green** (`goldenEpoch: 1`); thereafter CI rejects any golden byte-change without an epoch-bump entry in `goldens/REBASE_LOG.md`. "Re-base once, explicitly" is a mechanism, not a culture instruction; after Gate 3 locks, golden changes ride lens-snapshot bumps recorded in the same log — expected-flip review under §8's regenerable-by-design stance, never silent drift.

**Substrate status (already landed, ahead of Phase 0):** the interpreter reference is hardened — R7RS truthiness in HOF verdicts, `find`-miss, nil-as-array, ratio numerics with the exactness guarantee, bounds-checked refs, doored bitwise, honest `any?`/`every?` split — and two conformance corpora run green-by-law. The oracle's comparison plane (interpreter egress face ≡ compiled representation) holds by construction — Phase 0 *wires* the existing egress comparator, it does no representation-plane work. Note the **bug-cell corpus is compiler oracle rows** (Appendix B programs through compile+execute), not a re-run of the interpreter conformance ledgers; shared fixtures import only where literally identical. What remains untouched is the **compiler side**: mercury's emitters still carry the truthiness bug.

- **Phase 0 — stop the bleeding (days–1 week; "days" holds only because the oracle-harness spec is the implementation blueprint and the comparison plane is landed).** Fix the live truthiness bugs in current `lower.ts` (`lowerIf`, `and`/`or` `variadicLogic`) and `types-emit.ts` (`__scmTruth` minimal wrapper per Law T). The `lower.ts` fix is knowingly throwaway-by-Phase-3; it stays because the string path serves production until parity and live wrong-code is unacceptable rent. Stand up the **differential oracle harness** against an explicit exit checklist: (1) value-equivalence comparator wired (interpreter egress face vs executed `projectToJs` output); (2) error-class equivalence spec + both-throw comparison at class level; (3) divergence-by-design rows (per-side assertions — exact overflow is the seed case); (4) bug-cell corpus landed, red→green for the truthiness cells; (5) the oracle as a required CI check on main; (6) the double-compile byte-compare determinism check (§8) — trivial, lands with the harness.
- **Phase 1 — the vertical slice (the go/no-go).** Deliverables: CoreForm + TypeFacts extraction + Residual renderer + registry plumbing (`Contract.emit` + harvest, **including the dry-harvest path for capability contracts** — `infer` is in the slice, so §4.5's builder-form constraint is a prerequisite, not a Phase-2 note) + stage-0 shims + **minimal FRAME** (the `RuntimeRef` import scan — without it slice output can't compile standalone, so it cannot wait for Phase 3; Phase 3 only retires the legacy census against it) + **ASYNC-IFY MVP** (shim-registration seeds, await insertion, the `Promise.all` rewrite, over-await fallback — `infer` and the async goldens are unreachable without it) + **the NForm narrowing grammar in types-emit** (§5.3 — a hard prerequisite to *measuring* Gate 1: under Phase 0's unconditional wrap, facts never flip clean and the gate would trigger a false re-scope) + **schema-driven fuzzer MVP** (§5.4's generator + witness-row enforcement — Gate 2 quotes it, so a phase must build it) + **the enforcement spine**: the CI checks the design mandates, each red-gated from Phase 1 — `narrows ⊆ witness registry`; narrowing-leaf-without-oracle-rows fails; static door-scan of the 186 preamble symbols; `tsc --strict` on emitted slice artifacts; cross-pass fixtures; the Law-U diagnostics corpus (lens-warning assertions, disjoint from the oracle's defined-programs corpus); the datum-label compile-front door.
  **Slice symbols — fourteen + two engine forms + `infer`:** `car cdr cons not null? pair? + = / quotient modulo map filter apply`, engine `and`/`or`, `infer`. The four beyond the original ten each cover a residual class the slice must not skip: `cons` (ArrayLit+Spread construction), `not` (NForm grammar closure), `/` + `quotient`/`modulo` (the numeric bug-cell rows — ratio projection, overflow divergence-by-design, sign conventions — must run through the *new* pipeline in Phase 1; quotient/modulo double as the slice's operator-identity representatives), `apply` (the reduce/arity bridge Gate 3 tests). Equality walkers (`eq?`-family, `member`/`assoc`) stay shim-only in Phase 1; their bug cells run on the shim path and are so marked in the coverage matrix.
  **Corpus:** a committed `gate1-corpus` manifest — three named real programs selected by site-density criteria (minimum `car`/`if` site counts, ≥1 `infer` fan-out, ≥1 multi-list map). Three arbitrary programs would yield a dozen-site denominator where 25% = 3 sites — noise; the manifest states expected counts and **Gate 1 fails closed on insufficient sample** (too few sites ⇒ extend the corpus, never re-scope on noise). The type pass rides the existing hand-maintained lens leaves **pinned to a snapshot at Phase-1 start** — gates measure against snapshot S, not whatever the types track landed that morning. Generating the prelude from the registry is Phase 3+.
  - **Gate 1 (type availability — joint with the types track).** Metric, frozen before slice work: *site* = each `App(car|cdr|…)` and each `If`-condition residual decision, register `run`, excluding lens-warned UB sites; *clean* = the idiomatic residual (no `RuntimeRef` shim, no `!== false` guard); *denominator* = all such sites in the manifest corpus; measured by an automated CI script against pinned lens snapshot S, with informational columns for `map`/`filter`/cxr clean-% (the gate keys on `car`/`if`; the columns keep slice breadth visible). Below the 25% band (⚖️ ruled; ±5pt judgment zone) ⇒ the human-grade claim re-scopes before build-out (product becomes "safe + honest"; clean-emit grows with the treadmill).
  - **Gate 2 (soundness), two stages.** **2a (Phase-1 exit):** oracle green on every bug-cell row under subject-routing (rule-exercising cells per the coverage matrix, shim cells so marked); zero Law A/T violations under the fuzzer; cross-pass fixtures green; emitted slice artifacts pass `tsc --strict`. **2b (Phase-2 exit):** the full Appendix B corpus green with *rules* (not shims) for every hot cell.
  - **Gate 3 (quality):** goldens vs the `goldenEpoch: 1` baseline on the hard cases (multi-list map, first-class car via eta — the instantiated-signature golden, async-map→`Promise.all`, `apply` patterns, short-circuit). Rubric split: machine-checked where decidable (IIFE-only-in-expression-position renderer assert, import-order check, guard-form policy: bare ternary iff `facts.boolean`) plus a one-page human sign-off checklist (V), once per gate — not ongoing taste review.
- **Phase 2 — registry build-out.** Relocate `STDLIB` knowledge symbol-by-symbol under the **package-deal discipline extended to the types dependency**: each move = emit rule + lens leaf (where fact-gated) + witness + oracle rows in one reviewed change, with a characterization diff (shim→rule is exactly the drift window the coverage matrix exists for). Entry drill: one mini-batch relocation of ≥3 interdependent symbols (the cxr cluster) before the long tail — exercising the discipline itself, not just symbols. **PEEPHOLES land at Phase-2 opening** (first entries: infer scalar-fold + cache-key-elide) with a rule-lint that emit rules never inspect parent CoreForm (Law C's boundary, enforced). `rt-langchain.ts`/`rt-vercel-ai.ts`/prompt backends collapse into `infer`-family rules. LEGIBILITY lands here (destruction + singularization + pure-region CSE). The string path retires as early as coverage allows — Phase 3 is the deadline, not the target.
- **Phase 3 — the tail.** Preamble self-hosting; runtime module; full FRAME (the minimal Phase-1 FRAME grows to own decls/exports/dead-defines — the shake *is* a FRAME query); **cut over consumers to the new package and delete mercury's emitters** against a kill checklist (`async-analysis.ts`, census flags, string STDLIB, `rt-*` files); PRE/ArrShape prelude generated from the registry.
- **Phase 4+ — optional dialects.** Ramda whitelist (type-gated pure-HOF subset, one library, own gate); read-view polish.

---

## 10. Risks, ranked

1. **Type availability (empirical; the value-prop risk).** `any` is a contagion engine on unannotated code; clean-emit may be a minority on day one. Mitigation: Gate 1 measures before build-out; Law F makes the failure mode ugly-but-correct; the strictness treadmill is the growth path. *Accepted-and-measured, not solved.*
2. **Two-pass drift (the wrong-code risk).** Mitigation: Laws T/N/A/F/V + oracle + fuzzer + cross-pass fixtures; every narrowing leaf is a mechanical proof obligation (cost scales with leaf count — budgeted in the types track).
3. **Types-track coupling.** Compiler output shifts when lens leaves move — silently, clean↔conservative. Mitigation: gates measure against a pinned lens snapshot; goldens carry the type-snapshot hash; leaf additions follow the §3.3 package deal; the Law-N CI blocks leaves outrunning their proof burden.
4. **Dual-emitter drift (the overlap window, Phases 1–2).** Two live emitters means a fix can land on one side only. The greenfield split (§4.5) removes shared-file drift entirely — divergence is product-level, caught by the oracle. Mitigation: subject-routing makes the new package gate-authoritative from Phase 1; mercury is frozen for new knowledge; oracle rows pin their subject; the Phase-3 cut-over ends the window.
5. **Shim-green ≠ rule-green.** A cell passing on a stage-0 shim says nothing about the Phase-2 hand residual. Mitigation: the coverage matrix names each cell's required subject; every shim→rule move ships a characterization diff + oracle rows (Gate 2b).
6. **Residual algebra scope creep.** Constructor budget (~22); additions need demonstrated rule need + renderer support + oracle coverage.
7. **Runtime-module cost for the native tail.** 260 natives whose impls don't transfer. Corpus-frequency prioritization; doors for the cold tail; the self-hosted preamble covers the scheme-bodied 186.
8. **Registry harvesting for builder-form capabilities.** Dry-harvest lands in Phase 1 (the slice includes `infer`); static-rules-only is a new authoring constraint (public-contract change, small).
9. **Spec drift (constitution vs the 9 component specs).** Parallel agents edit both. Mitigation: the constitution wins on conflict; each spec pins the constitution date it reconciled against; a reconciliation sweep runs after every constitution change (practiced — two sweeps to date).
10. **Mercury name collision.** Three names in play: `@here.build/mercury*` (studio emitter), `@inhuman.tools/mercury` (the legacy bridge, dies at cut-over), `arrival-mercury` (this compiler, working name). No code sharing anywhere by design; rename survivors at foundation-extraction time.

## 11. Open decisions

**All constitution-level decisions are closed** (⚖️ ruled 2026-07-14, Appendix C): output regenerable-by-design, no `residualEpoch` (§8) · greenfield package, copy-as-chunk (§4.5) · dotted pairs collapse to `[a, b]`, no door (§2.1) · `guard` doors in v1, `Try` designed in Phase 2 (§3.4) · Gate-1 trigger = the 25% band (§9) · read register stays in v1 (§1) · cross-pass fixtures owned by typefacts-extraction, sharing the oracle corpus (§5.3) · known-red oracle rows use `it.fails` (self-firing promote signal).

Spec-level residue (not constitution-blocking): confirm the new package's name (working: `arrival-mercury`); the ASYNC-IFY `Promise.all` rewrite gains its `provenance` gate when the first sink-async symbol enters the registry (flagged in async-await-plane.md — latent, not Phase 1); the `short-circuit-effect.scm` door row's Phase-0-vs-1 placement (oracle-harness.md OQ8a).

---

## Appendix A — inhuman-mercury fate map (condensed)

Under the greenfield ruling (§4.5), "keep" means **copy-as-chunk into the new package** — raw material, re-homed and re-judged, never a shared import. Mercury itself stays untouched until the Phase-3 cut-over deletes its emitters.

| File | Fate |
|---|---|
| `stdlib.ts` STDLIB table | → registry emit rules (knowledge relocated, mechanism deleted) |
| `stdlib.ts` accessorJs/cxr | → engine decoder composing car/cdr rules (pure index arithmetic) |
| `lower.ts` special-form walker | → engine walker on residuals (invariants per §6); set!/census machinery deleted (§2.2) |
| `lower.ts` census flags | → `RuntimeRef` + FRAME scan |
| `rt-langchain.ts`, `rt-vercel-ai.ts`, `prompt.ts` backends | → `infer`-family emit rules (config-branched) |
| `async-analysis.ts` | **deleted** — ASYNC-IFY replaces the fixpoint (Law W); nothing survives it |
| `type-infer.ts` | keep for output annotations; per-builtin cases → registry `type`s; feeds `Annotated` residuals |
| `types-emit.ts` | evolve per Law T; PRE/ArrShape prelude eventually generated from the registry |
| `scheme-scope.ts`, `names.ts`, `desugar.ts`, `imports.ts`, `format.ts`, `compile-project.ts`, `prompt-ir.ts` | keep |
| `strategy/` | rt/* opinions dissolve into rules; ts-base opinions remain engine config; `strategyHash` keeps artifact identity |

## Appendix B — bug-cell classification (final)

| Cell | Class | Treatment |
|---|---|---|
| `car/cdr` on empty | Law U — representation-collapsed | always `xs[0]`/`.slice(1)`; empty = UB, outside the contract; lens warns on unproven use |
| truthiness | type-PARTIAL | Law T |
| `eq?/eqv?/equal?`, `member/assoc` | operator-identity | fixed per-symbol residuals; never type-directed |
| `quotient/modulo` sign | operator-identity | one correct algorithm |
| multi-list map | syntactic (arity) | rule branches; zipWith bridge |
| variadic `+`, `apply +` | representation-collapsed | plain fold / reduce (§7) |
| `and/or` | engine special form | Law T run-side; temps effect-gated (§2.2) |
| `(= 1 1.0)` | natively correct | `===` → `true` = Scheme's `#t` |
| `(/ 1 3)` | resolved — RATIO | interpreter: exact `1/3`; artifact: `0.333…` = the interpreter's egress face — agreement by construction (§7) |
| exact overflow | divergence-by-design | interpreter throws the teaching error; artifact floats on — oracle asserts per-side |
| mutation-invalidation (`set-cdr!` after a proof) | **cannot occur** (§2.2) | a *negative oracle*: any future regression replacing a proven clean residual with a guard is rejectable by construction |
| `+0.0/-0.0`, `NaN` in `eqv?` | runtime-sentinel | interpreter `Object.is` cases; oracle rows |
| dotted pair `(a . b)` | representation-collapsed (⚖️ ruled) | compiles as `[a, b]` — pairs are not a separate primitive; `cdr`-of-dotted is a divergence-by-design row (interpreter yields the tail atom `b`, artifact `.slice(1)` yields `[b]`) — per-side assertions, corpus-avoided |

## Appendix C — decision record (dates, commits, provenance)

| Decision | When | Provenance |
|---|---|---|
| Type-direction + registry + mercury-lessons grounds; inliner/matryoshka/string-templates rejected | 07-13 | 3 triad rounds + mercury/rosetta/capability code digs |
| Library-axis demoted to optional dialect | 07-13 | triad round 2, 3/3 |
| ASYNC-IFY cascade replaces the SCC fixpoint (Law W); `argAsync`/`invokesArg` deleted | 07-13 | V ruling; spec-rewrite agent; dissolved conflicts C1/C9/C11 |
| car/cdr/cons representation-collapsed; Law U | 07-13 | V ruling ("we collapse the semantics") |
| Numerics: one payload; RATIO exacts; crash-on-overflow | 07-13/14 | V rulings; 4-audit plan review; **executed** `98fd0e2d88` + `9b6ca55958` (bitwise doors) + `ac1b2f4a50` |
| Interpreter substrate hardening (truthiness, nil-as-array, find, any?/every?, bounds, SRFI-1 corpus) | 07-13/14 | nil-audit + conformance sweep; commits `c16dfd2ef7` `9c18286f84` `0e75b87c4d` `772441d48e` `c37f433153` |
| Immutability/no-dynamics law formalized; SetBang/census/boxing deleted from design | 07-14 | V correction (provenance rationale); 4-auditor immutability audit (grok triad + agy) |
| Effect model: declared registry gate; infer pure; sinks pin order; conflict layer decoupled | 07-14 | V refinement |
| Law T narrowing-form grammar; `__scmTruth` v1 boolean + Exclude-predicate upgrade path | 07-13/14 | fleet verify + empirical probe suites (tsc 6.0.2 + TS7 parity) |
| TS 6.x pinned for the compiler; TS7 (no stable API until 7.1) is typecheck-lane only; FactsLens is the swap seam | 07-13 | TS7 GA survey |
| Per-binding fact census rejected; cycle-machinery deletion rejected (reframed) | 07-14 | immutability audit (longcat Win C; composer/4.5 counters) |
| Plan hardened: subject-routing + coverage matrix, two epoch-stamped golden sets, 14-symbol slice (+cons/not///quotient/modulo/apply), ASYNC-IFY+FRAME+NForm+fuzzer+dry-harvest pulled into Phase 1, enforcement-spine CI, Gate 2 split 2a/2b, Gate-1 metric frozen, risks 3/4/5/9 added | 07-14 | 4-agent plan review (grok-4.5 20 / composer 25 / longcat 9 / agy 12 findings; convergence-weighted synthesis; rejected: skip-lower.ts-fix, external sign-off panel) |
| Symbol egress = plain interned name (apostrophe marker retired from ASymbol toJS; stripSymbolMarker deleted; symbol-face corpus row promoted — KNOWN_RED down to the one OQ8a row) | 07-14 | V ruling ("quoted-symbol is just string, as written; both should follow constitution"); consumer census found one real consumer (the strip, itself a footgun on legit apostrophe strings) |
| §11 quiz closed all 8: regenerable-by-design (residualEpoch deleted); greenfield package + copy-as-chunk; dotted pairs → `[a, b]` (door rejected — "lists, pairs and vectors all get lowered to arrays"); guard doors v1 / Try Phase 2; Gate-1 = 25% band; read register stays; cross-pass fixtures → typefacts-extraction; `it.fails` convention | 07-14 | V rulings (two-round quiz); dotted-cdr divergence verified against pair-cycle.test.ts's one-way-fold pins |
