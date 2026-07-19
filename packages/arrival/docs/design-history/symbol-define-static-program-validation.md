# `symbol.define` + the static program-validation pass — prelude death by decomposition

**Status:** EXECUTED (W0–W4 landed; 2026-07-10). W0 landed 98641484b3; W4 migration landed
across H1–H3 (3d8b55d585, 42402bf473, 925e428cdc), the external packs (ad17669d5c) and the
polyglot dialect split (4fc9d4b33d); W4-H4 (the closing wave — contract review, the
default-flip ruling, residuals, census regen) is folded below. Every pack's define/macro
prelude is migrated to `symbol.define`/`symbol.defineSyntax`; the only surviving `prelude:`
fields are the 5 extension-registration calls (§4.3 residue, call-only). The static-validation
pass is LANDED and PROVEN but stays OPT-IN at the `exec` primitive — the production posture is
per-caller opt-in (§3.6/§3.7, the W4-H4 default-flip ruling below), NOT a global default flip.
Rev 2 was the last DESIGN revision; below it, W4-H4's ledger records what actually shipped.
Every cited symbol was re-verified against HEAD for the rev-2 revision; the tree moved all day.
**Thesis (V, verbatim intent):** "Drop prelude in favor of
`` symbol.define`name: description`(contract, bodyString) ``. Preludes aren't generalized
scheme — purely series of defines; decompose them into individual declarations. This gives
stricter definitions, more descriptive power, and static analysis detects the dependent
symbols. Target UX: 'You tried to use `(require file.scm)` inside `(runPrompt …)`. However,
the filesystem was not provided in the exec configuration, so we cannot run it' — detectable
STATICALLY: exec can throw at parse phase with 'require referred at X; requires configuration
Y — this program will crash'. Critically: ESLINT-STYLE — ALL errors gathered at once (unbound
symbols + capability/config requirements), before execution, never crash-on-first. Possible
because the environment is non-dynamic and immutable. This DISSOLVES the strict-vs-teaching-
doors question rather than solving it."

**Lineage:** `hermetic-symbols-static-declarations.md` (sibling, 2026-07-10 — the
`this.configuration`/`this.resources` fusion + config-fusion door; this design assumes its
Phase A ships but does not block on it) · `environment-is-capability-composition.md` (sibling
— `Env.assemble`, the roster as identity; this design's validator is a consumer of its
`chain`) · `rosetta-registry-dissolution.md` (WO-1/WO-2 — `symbol.define` is WO-2's missing
target for scheme-expressible verbs) · PROVENANCE.md Q6 (span totality) / Q7
(`classifyProgramPrelude`) / Q8a (`freeVars`) · `arrival-symbol-api.md` (the declaration
vocabulary this kind joins) · the errors-as-doors / declared-doors law ·
`symbol-define-prior-art.md` (the survey sibling — three of its findings land here as
CHOSEN architecture rows: cascade fusion §3.1, missing-as-node §3.2, suggestion soundness
§3.3a; plus the Unison hash-display rule §3.1/§5.3 and the Dialyzer soundness contract §3.5).

---

## 0. The finding in one paragraph

Every piece of the validator already exists at HEAD as separately-landed machinery; what does
NOT exist is the declaration kind that makes capability-owned scheme code visible to it.
`freeVars` (Q8a, scope-correct over the modeled special-form set — see §3.5's SPECIAL_FORMS
fix, one gap in "scope-correct" this revision closes) computes what a program references;
`CompiledResolutionChain.names` (`eval/CompiledResolutionChain.ts:93`, landed 2026-07-09,
3d5a4e225e — corrected citation, rev 2) enumerates what a sealed env answers;
`suggestFromVocabulary` (`src/unbound-variable.ts`) already derives typo suggestions from that
enumeration; `classifyProgramPrelude` (Q7, `provenance/prelude.ts:137`) already derives the
TRANSITIVE port-reach fixpoint over a set of top-level defines (its single-node primitive,
`reachesPort`, `provenance/prelude.ts:89`, only tests one already-classified body — §1.4 was
under-specified about which of the two does the work a capability's define SET needs); the
reader already stamps `SourceLocation {line, col, offset, source?}` on every Pair
(`Symbol.for("__location__")`, extract-defines.ts), total through macro expansion (the Q6
span-totality law). W0 (commit 98641484b3, LANDED 2026-07-10, folded into rev 2 — see the
changelog) closed link (2) below almost entirely: `DoorSymbolDef` now carries an optional
`cause: {owner, needs}` and doors bind an introspectable `DoorProcedure`
(`values/primitives/ACallable.ts`), not a bare closure. The missing links, restated for rev 2:
**(1)** prelude text is an opaque string, so its defines have no contracts, no descriptions,
no per-define identity, and no statically-checkable reference discipline — `symbol.define`
fixes that; **(2)** [W0 LANDED] doors are now introspectable and cause-carrying, but nothing
yet MINTS a `needs` entry for door-set degradation (§3.7, W2) and the validator (W3) does not
yet consume `.cause`/`.door`; **(3)** an unsatisfied *optional-enabling* config/dep today
degrades by WITHHOLDING the symbol entirely (verified, see below) rather than throwing —
door-set degradation replaces withholding with a bound-but-doored symbol so the validator has
something to report ON, and narrows (§3.7) so a genuinely *required* config stays a throw.
This doc designs the remaining links plus the pass that composes them, and the migration that
kills `prelude`.

**The flagship case, corrected against HEAD (rev 2 — rev 1's framing was wrong):** rev 1 told
this as "assembly throws on missing fs" vs "teaching doors." Verified against
`arrival-scheme-env-loader/src/loader-capability.ts` (the actual `arrival/loader` capability,
a sibling package rev 1 never opened): both `configuration.fs` and `configuration.loader` are
`.optional()` (lines 154, 157), and `require`/`require/extension` are added to the symbol set
`if (loader !== undefined)` (line 242) — **absent, they are never bound at all.** The file's
own header states the posture in these words: *"a loader-less env has no `require` symbol at
all, so a program's `(require …)` is a plain unbound variable, not a policed call"* — WITHHOLD,
not throw, is what ships today. There is no "strict lower" path for `require` to contrast
against; the real gap is that withholding gives the validator (and the runtime) nothing to
attach a cause to — an unbound `require` looks exactly like a typo. The dissolution claim,
restated correctly: today's choice is *silent withholding* (a missing-but-legitimate symbol
reports identically to a misspelled one) vs what this design adds — *doored presence* (the
symbol is bound, introspectable, and its absence-reason is attached as data). The static pass
makes the default path: assembly always lowers (withheld symbols become doors instead of
absences), and exec's parse phase reports every door the program actually references — before
evaluation, all at once, with the causal chain. Strictness becomes program-scoped instead of
capability-scoped.

**The actual security-sensitive change this design must guard, found while correcting the
above:** not every absent config is like `fs` (optional, safe to withhold-then-door). Verified
against `llm-plane-arrival-env/src/infer.ts:136`: `arrival/infer`'s `configuration: { infer:
z.custom<InferFn>() }` carries no `.optional()` — authored as REQUIRED. But `z.custom()` with
no predicate accepts anything, including `undefined`; there is no schema-level enforcement,
and no separate invariant checks it. So today this is not even "fail-closed throw at lower()"
— it is silent pass-through at lower(), then a raw uncaught `TypeError` at the first `(infer
…)` call, the worst of both worlds (no assembly-time signal, no teaching door, a JS crash
instead of a Scheme one). This is the concrete instance of the required-vs-optional split
§3.7 must make explicit: `fs`-shaped OPTIONAL-ENABLING config is safe to degrade to a door on
absence; `infer`-shaped REQUIRED config must not — its absence should throw at `lower()`
(fail-closed, unchanged from what the schema author evidently intended), never silently
degrade to a door, and (a fix this design surfaces but does not itself ship, noted in §8) its
schema should stop being a silent no-op. §3.7 states the resulting rule precisely.

---

## 1. `symbol.define` — the scheme-bodied declaration kind

### 1.1 Shape

```ts
// common/symbols/define.ts — joins the namespace barrel (index.ts) beside native/rosetta/…
symbol.define`fold-right: right fold over a list — (fold-right kons knil lst)`(
  { input: [z.lambda, z.value, z.value], output: [z.value] },   // Contract<I,O> — scheme face
  `(lambda (kons knil lst)
     (if (null? lst) knil (kons (car lst) (fold-right kons knil (cdr lst)))))`,
)
// → DefineSymbolDef (a new AEntity member)

symbol.defineSyntax`receive: (receive formals expr body…) — SRFI-8 multiple-value binding`(
  `(lambda (formals expr . body)
     \`(call-with-values (lambda () ,expr) (lambda ,formals ,@body)))`,
  { macroAttribute: "binder" },   // §3.4 — formals are BINDING space, not expression space
                                  // (rev 2: receive is the ternary's worked binder example —
                                  // boolean transparent:true here would report formals unbound)
)
// → DefineSyntaxSymbolDef
```

- **Name/description ride the tagged template** — `parseNameDoc` (`_bake.ts:476`), byte-shared
  with every other kind. The description is REQUIRED-by-convention for new declarations
  (migration may leave it empty where no adjacent comment exists — a minority of the tiny
  packs, per §4's script-regenerated census); it is the doc-generation surface (§5.4).
- **The body is the RHS EXPRESSION, not a whole `(define …)` form.** CHOSEN because the name
  must live in exactly one place; a whole-define body carries the name twice and the pair can
  drift (the same reason `parseNameDoc` owns naming for every other kind). A procedure define
  is authored `(lambda …)`; a constant define is its value expression. Mechanical
  decomposition (§4.2) rewrites `(define (f . args) body…)` → `(lambda args body…)` — the
  standard synonym `extract-defines.ts` already recognizes. Self-recursion works because the
  define's own name is in its own capability's scope (§2.3).
- **TWO kinds, not one.** `symbol.define` (value/procedure — contract-bearing, role-derived)
  and `symbol.defineSyntax` (macro/expander — contract-FREE, carries the ternary
  `macroAttribute` static attribute instead, §3.4). EXCLUDED: one kind whose body's head decides — a macro is not a
  value binding; it has no call-boundary contract, no provenance role, and a categorically
  different static-analysis story (its "free variables" name the EXPANSION env). Conflating
  them would force every consumer of `DefineSymbolDef` to re-discriminate. The census (§4.1)
  shows both populations are large (~90 defines, ~15 macros) — neither is an edge case.

### 1.2 Contract semantics — ENFORCED at the call boundary, scheme face, skippable

**CHOSEN: the contract is enforced** — the evaluated closure is wrapped so calls validate
`z.decode` against the normalized input vector on the SCHEME face (`Face = "scheme"`,
`z.input` — the same face `symbol.native` projects: a scheme body lives in the value algebra,
nothing crosses the membrane) and the return against the output vector; validation is
skippable per the same `BakeRuntimeOpts.validate` knob rosetta has. Judged over the
alternative (native's "zod for TYPES purely" — advisory schemas, no runtime check) for three
reasons: **(a)** an unenforced contract on a scheme body is a declared-vs-actual drift door
with no alarm — a JS native's impl is at least typed by `Impl<I,O>` against the same schemas
at compile time; a scheme body gets NO compile-time check, so the runtime boundary is the
only agreement mechanism it can ever have; **(b)** enforcement is what makes scheme defines
first-class citizens of the typed membrane — the harvest (`schema-to-ts.ts`), the type-lens,
and the arity checker (§3.3d) all read the same contract, and only enforcement keeps that
contract honest; **(c)** uniformity — `exec(src, {typecheck})` (a DESIGN TARGET, not landed:
the symbol-api doc names the knob, verified absent from `ExecOptions` at HEAD — rev 2
labels this explicitly so no reader greps for it) gets ONE semantics across kinds when it
lands.

**Cost honesty + the migration posture (rev 2 — the shapeless MIGRATION DEFAULT is
EXCLUDED, superseded by V's ruling 2026-07-10; the ruling STANDS, this paragraph now
matches it):** wrapping srfi-1's hot recursive procedures in per-call zod decode is real
overhead (identity schemas are `instanceof` checks — cheap, but tuple normalization
allocates). Rev 1 chose a shapeless contract (`{ input: z.array(z.value), output:
[z.value] }`) as the migration default, tightened opportunistically — **V ruled the
opposite: contracts are ENFORCED FROM DAY ONE; every migrated define gets a real contract
authored during W4 (~200 contracts), no ratchet debt.** The shapeless form remains LEGAL in
the vocabulary (a genuinely variadic any-in/any-out define is honestly shapeless — some
polyglot aliases ARE that) but it is an authored judgment per define, never a default the
tooling reaches for. The cost valves that survive: a bake-level `validate: false` opt-out
exists per declaration for MEASURED hot paths (the knob already exists for rosetta), and
§4.5 adds an explicit per-call decode perf budget for the hot recursive family. LIMIT:
enforcement is boundary-only — it checks what enters and leaves the closure, never what
the body does in between (that is §1.4's derived classification and, eventually, the
type-lens).

**Constants:** a non-callable define (polyglot's aliases, core's `true`/`NaN`) declares a
single plain schema as its contract (`VectorSpec`'s single-schema member); the value is
validated ONCE at bake, no wrapper. Discriminator: contract-is-a-`ZodType` (the same sound
`instanceof z.ZodType` split `RestSpec` already uses) vs contract-is-a-`Contract` record.

### 1.3 Body parsing, spans, identity

- **Parsed at bake, memoized on the def.** `define()` stores the body STRING; the first
  `lower()` that binds it calls the reader (`reader/parse.ts` — pure leaf, env-free) and
  memoizes the parsed form + evaluated closure per def object. Module-level capability
  constants mean N assemblies parse once. EXCLUDED: parse at module load (startup cost for
  packs an app never assembles — the same laziness posture as resource spin-up).
- **Span totality extends into the body.** The reader is called with
  `source = "«capability-name»#«symbol-name»"` (the `SourceLocation.source?` field,
  extract-defines.ts) — so every Pair in a capability define's body is located, and a
  declaration-site error (bake drift door, runtime throw inside the body, wireframe span
  attribution) names `scheme/srfi-1#fold-right:3:8` instead of an anonymous prelude blob.
  Today `evalScheme(env, spec.prelude)` passes NO source label — prelude spans are
  line-numbers into an invisible string; this is a strict improvement Q6's law extends to
  cover (a new law case: every Pair of a parsed define body is located with the
  capability#name source). LIMIT: the TS declaration-site (file/line of the `.ts` file) is
  NOT captured — that would need Error-stack heuristics; the capability#name label is the
  designed address, and the capability name → file mapping is grep-trivial.
- **Per-define content identity.** `def.bodyHash` = FNV-1a over the body string + contract's
  stable text — the SAME small hand-rolled idiom `CompiledResolutionChain.ts`'s `hashSteps`
  (`eval/CompiledResolutionChain.ts:158`) and `provenance/wireframe/hash.ts`'s private
  FNV-1a both already use (prefix tag + `|`-joined canonical parts, zero-padded hex).
  **Correction (rev 2):** `hashSteps` is FILE-PRIVATE (no `export`, only called at
  `CompiledResolutionChain.ts:122`) — `wireframe/hash.ts`'s own comment says so explicitly
  ("NOT imported from there"). `bodyHash` re-implements the same ~10-line FNV-1a idiom
  locally rather than importing a name that doesn't exist across the module boundary — a
  fourth copy of a codebase convention, not a new one. This is the §5.3 cross-deploy
  identity input. Cache key material, minted at declaration construction (string hash —
  cheap, eager).

### 1.4 Provenance role — DERIVED from the body, declaration checked against derivation

**CHOSEN: derived — as a FIXPOINT over the capability's whole define set, not a single-body
check (rev 2 correction).** Rev 1 under-specified this as "run Q7's machinery on the parsed
body — `classify(body, classifier)` + `reachesPort`" — that pairing is `reachesPort`'s OWN
single-node job (`provenance/prelude.ts:89`: is THIS already-classified tree port-reaching,
structurally), not the transitive one a capability's define set actually needs. Q7's
`classifyProgramPrelude` (`provenance/prelude.ts:137`) is the function that does both passes
— Pass 0 classifies each define's own body directly (`classify` + `reachesPort`, one call
per define), Pass 1..N is a fixpoint over the REFERENCE graph (`referencedSymbols`, coarse
over-approximation) closing "a define calling a port-reaching sibling is itself port-reaching"
— and it is THAT shape the bake classification needs, run over one capability's own
`symbol.define` set (a define whose body merely calls a port-reaching co-define must NOT
derive `pipe`; it must inherit the sibling's wireframe verdict). CHOSEN: bake reuses
`classifyProgramPrelude`'s algorithm directly (it already operates on "a set of named
top-level defines" — a capability's define set is exactly that shape; the two only differ in
where the defines come from, program forms vs. capability declarations) rather than
re-deriving a parallel fixpoint. Port-free (fixpoint-closed) ⇒ `pipe`; port-reaching (direct
or transitive) ⇒ the classification's own verdict travels to the wireframe (the define is
wireframe material, §5.2). This inverts the JS kinds' posture (declare + shape-check) because
the ground truth is VISIBLE here: a scheme body is fully classifiable where a JS body is
opaque — `assertProvenanceRoleShape`'s own LIMIT ("shape catches CONTRADICTIONS, not LIES …
shape cannot see JS bodies") simply does not apply. Deriving from truth beats declaring and
alarming on shape.

An optional `provenance:` declaration on the contract stays LEGAL and becomes a **drift
door**: a declared role that contradicts the derived classification throws
`ProvenanceRoleShapeError` at bake — declared-vs-actual made a door exactly as the prompt's
framing wants. DEFERRED: a declared role that *refines* an underdetermined derivation
(opaque sub-node) — no consumer needs it yet; the conservative derivation stands.

**Consequence worth naming:** capability defines are NOT all pure-prelude material.
`arrival/infer`'s three prelude defines wrap port verbs; the derived role carries that
honestly, and Q7's program-level classifier gains the SAME visibility through capability
vocabulary that it has through program defines today (§5.2's deeper cones). The doctrine
"defines are pure-prelude material" was only ever true of the membership FILTER for program
preludes — capability defines get classified, not assumed.

### 1.5 `DefineSymbolDef` (the baked shape)

```ts
export interface DefineSymbolDef {
  readonly kind: "define";
  readonly name: string;
  readonly doc?: string;
  readonly in: z.ZodTypeAny;            // normalized vectors (harvest/arity readers)
  readonly out: z.ZodTypeAny;
  readonly body: string;                // the authored source (doc-gen, mercury lowering)
  readonly bodyHash: string;            // §1.3 identity
  readonly provenance: ProvenanceRole;  // DERIVED (§1.4)
  readonly type?: string;               // harvest override, as everywhere
  readonly preludeOnly?: boolean;       // legal — an assembly-time-only helper define
  // parsed form + closure are memoized internally at bake, not public fields
}
export interface DefineSyntaxSymbolDef {
  readonly kind: "define-syntax";
  readonly name: string;
  readonly doc?: string;
  readonly body: string;
  readonly bodyHash: string;
  readonly macroAttribute: "opaque" | "expression" | "binder";  // §3.4 TERNARY (rev 2:
    // boolean transparent:true was UNSOUND — it conflated "args are ordinary expressions"
    // (threading macros) with "args are FORMALS, a binding position" (receive/let-values/
    // and-let*), and a binder walked as transparent reports its own formals as unbound.
}
```

Both join `AEntity`; `capability.ts`'s apply loop gains two arms: `"define"` evaluates the
memoized body against the assembly env (same scope the prelude evaluated against —
`ctx.preludeEvalScope ?? env`, capability.ts:435 at HEAD) and binds the wrapped closure;
`"define-syntax"` evaluates the expander and binds it through the same door `define-macro`'s
evaluation takes today. Evaluation ORDER within a capability = declaration order (§2.3).
Union-expansion cost acknowledged (model-design rule §4): every AEntity switch gains two
arms — the price of making scheme bodies first-class, paid once, in the kind vocabulary
where it belongs (the alternative — a `represents`-style tag on an existing kind — was
EXCLUDED: a scheme body shares no structure with a JS impl; every consumer WOULD
re-discriminate anyway).

---

## 2. Body resolution discipline — wire-locality applied to declarations

### 2.1 The law

For every `symbol.define` body B of capability K:

```
FV(B) ⊆ SPECIAL_FORMS ∪ KEYWORD_SYNTAX ∪ ownNames(K) ∪ ⋃_{D ∈ transitiveDeps(K)} exports(D) ∪ resolverAnswered(K ∪ deps)
```

computed by Q8a's `freeVars` on the parsed body, checked **at bake** (first lower, memoized
with the parse). A violation is a bake-time teaching door naming the free name, the owning
capability, and the fix ("declare a dep on the capability exporting X, or bind X in this
capability"). This is the wire-locality law (`FV(wire) ⊆ params ∪ prelude-names`,
PROVENANCE.md §7) applied one level down, to the vocabulary itself.

**SOUNDNESS FIX (rev 2) — `freeVars` is NOT scope-correct over every form the evaluator
dispatches, and this law was the first place that mattered.** Verified against
`provenance/wireframe/free-vars.ts`: its head-dispatch `switch` (line ~110) models `quote`,
`quasiquote`, `lambda`, `let`/`let*`/`letrec`/`letrec*`, `do`, `define`, `cond`, `case`, and
the non-binding group `begin`/`if`/`when`/`unless`/`and`/`or`/`set!` — but `while`,
`try`, and `define-macro` fall to `default: break`, which walks them as an ORDINARY
APPLICATION ("an op name IS a variable reference" — the file's own comment, line 266). So a
`symbol.define` body using `while`/`try`/`define-macro` produces a free-name reference to
that literal string, and the LAW above would need it in `ownNames(K) ∪ exports(deps)` to pass
— which it never is, because these are dispatched by the evaluator's `SPECIAL_FORMS` table
(`eval/evaluator.ts:2777`, module-private) BEFORE any env lookup, not bound as ordinary
values. Compounding fact, verified: EVERY `SPECIAL_FORMS` entry (all 20, including `while`,
`try`, `define-macro`) IS ALSO bound as a `symbol.keyword` value in the `core` capability
(`env/core/core.ts:49-68`) — so as long as `core` is part of the vocabulary these names
resolve as ordinary `KEYWORD_SYNTAX` entries, not free-floating magic strings. **The fix,
narrower than "hardcode a SPECIAL_FORMS seed list":** `core`'s keyword-bound names must be an
UNCONDITIONAL baseline of every vocabulary this law and §3.2's `ProgramVocabulary` construct
— assembled mode already roots `core` universally (no fix needed there); roster mode (§2.2,
§3.2) must treat `core`'s keyword exports as always-present, never roster-optional, since no
program can run without them. `KEYWORD_SYNTAX` in the formula above names exactly that set —
it is not a parallel hardcoded vocabulary, it is "the keyword-typed exports of whichever
capability binds them," resolved the same way any other export is.

**Live catch, found by this design's census:** `scheme/srfi-235`'s `complement` body calls
`compose` — defined by `scheme/polyglot`, with NO dep edge declared (srfi-235.ts:32 has no
`deps:`; the body comment says "compose is co-resident"). It works today only because
env-roots assembles polyglot earlier in the same phase — assembly-order luck, exactly the
silent coupling the law converts into a declared edge. Migration adds `deps` or moves the
define; either way the law's first catch predates its landing.

**A second live catch of the SAME shape, macro-flavored (rev 2):** SRFI-26's `cut`/`cute`
(`env/srfi/srfi-26.ts`, `define-macro`) introduce the placeholder token `<>` inside their
expansion; `<>` is bound TODAY as a `notImplemented` door in `env/polyglot-stubs.ts:78` (a
different capability than `srfi-26`, teaching "valid ONLY inside a `(cut …)` form" if
referenced bare). Raw `freeVars`, walking `cut`'s body as an ordinary application (macro
heads are unmodeled, same as `while`/`try` above), would add `<>` to B's free-name set —
and because `<>` DOES resolve (as a door, in a different capability), the bake FV law above
needs the SAME `deps` discipline the srfi-235 catch does: any `symbol.define`/
`symbol.defineSyntax` body built from a macro that introduces a pseudo-variable placeholder
(`<>`, `<...>`, SRFI-26/-235's families) either needs a declared dep on the placeholder's
owning capability, or the bake-side check needs the SAME macro-transparency policy §3.4
designs for program-level validation (a "firewall": an opaque macro's interior contributes
nothing to the FV computation at all, placeholders included) — CHOSEN: reuse §3.4's
`macroAttribute` at bake time too, rather than inventing a second placeholder allowlist. `cut`/`cute` are `macroAttribute: "opaque"` (§3.4's ternary — placeholder-token
macros are the canonical opaque case) — under the reused policy their `<>` interior is
invisible to the law, closing this leak by construction instead of by dep-declaration. Where a capability's OWN body uses `cut` directly
(not just defines it), the same rule applies to that consuming define.

### 2.2 Export sets become first-class

Verified: `CapabilitySpec` declares NO export set today — `symbols` record keys (+
`symbolPrefix`) are implicitly it, and prelude defines are invisible inside the string.
Design: `EnvCapability.exports` — a DERIVED, memoized getter, never an authored field
(model-design rule 1: derivable ⇒ derive):

```
exports(K) = prefixed keys of spec.symbols        (post-hermetic: statically enumerable)
           ∪ names of define/defineSyntax kinds   (they ARE symbols entries now)
           ∪ [migration interim] macroAwareDefineNames(parse(spec.prelude))
```

**Gated on macro-aware extraction (rev 2 fix — the interim arm has the SAME hole §3.2's
first-sweep fix does):** verified, `slice.ts`'s `defineNameOf` (line 180) and
`extract-defines.ts`'s `extractDefines` (line 92) BOTH match only the literal head symbol
`"define"` — `extractDefines`'s own docstring says so ("quietly ignores anything that isn't
a top-level define — including `(define-syntax …)`"), and neither recognizes `define-macro`
at all. Production preludes are full of `define-macro` forms (the threading family,
`cut`/`cute`, `receive`, `and-let*`, `let-values`, superdefine — §4.1's census), so the interim arm as
originally specified would silently DROP every still-prelude macro name from `exports`,
making roster-mode validation report them all as unbound. **Fix: `macroAwareDefineNames`
extends the walk to recognize `define`, `define-macro`, AND `define-syntax` heads** (small,
additive change to `extract-defines.ts`'s recognizer — same shape, one more head-symbol
case) — roster-mode validation is GATED on this extension landing, not on the interim arm
alone; until it lands, roster mode's `exports` under-reports macro names from
still-prelude-carrying deps and MUST degrade to a `warning`-tier vocabulary for those
capabilities (same honesty posture as §3.5's impure-resolver downgrade), never silently
claim completeness it doesn't have.

LIMIT: a builder-form `symbols` (the 9 sites the hermetic sibling censuses) is not statically
enumerable — `exports` for those is computed post-lower only; the pre-assembly consumers
(§3.6) degrade to assembled-mode until hermetic Phase B retires the builder arm.
Resolver-contributed names are NOT in `exports` (see §3.5's resolver treatment — probed, not
enumerated).

### 2.3 The binding model — one capability = one recursive scope, evaluated in order

**CHOSEN, relabeled for precision (rev 2): letrec\* NAME VISIBILITY for FV analysis;
SEQUENTIAL RHS EVALUATION, matching today's prelude semantics exactly** — NOT full letrec\*
(letrec\* is a single atomic binding form with unassigned-until-evaluated slots; a capability's
defines are ordinary sequential top-level `define`s that happen to share one scope). The
distinction that matters: for the §2.1 FV LAW, every name in K is visible to every other name
in K regardless of textual order (letrec\*'s promise — late-binding through a lambda body is
legal in any direction); for EVALUATION, each define's RHS runs sequentially, in declaration
order, against the accumulating scope (an eager, non-lambda RHS sees only what evaluated
before it — ordinary top-level `define` semantics, not letrec\*'s bind-all-first assignment
phase). Today a prelude is exactly this: a series of top-level defines evaluated sequentially
against the assembly env; a lambda body late-binds (a forward reference from a procedure body
resolves at CALL time), an eager RHS does not (a non-lambda RHS referencing a later define
crashes at bake). Decomposed defines preserve both facts: declarations evaluate in
**declaration order** (JS object-key insertion order — already the order every symbols record
relies on), each binding as it evaluates; the §2.1 law's `ownNames(K)` includes ALL of K's
names for the FV check (late-binding visibility — srfi-1's `zip` body referencing `some` is
legal regardless of order; mutual recursion across entries just works, as it does in any
top-level scheme scope), while the eager-forward-reference check below still runs over
EVALUATION order.

**Two-phase binding, mandated (rev 2 addition):** native/rosetta entries in `spec.symbols`
bind BEFORE any `symbol.define`/`symbol.defineSyntax` evaluates — preserving today's actual
apply-loop order (`common/capability.ts`'s per-symbol loop binds every `AEntity` in
`spec.symbols` order, THEN the (pre-decomposition) prelude evaluates against the now-populated
env). A `symbol.define` body may therefore always assume its capability's own native/rosetta
siblings are already bound; a native/rosetta impl may NEVER assume a `symbol.define` sibling
is bound (the reverse ordering does not exist and this design does not invent it). This is
additive precision on §1.5's "join `AEntity`; apply loop gains two arms" — the two new arms
run LAST within a capability's apply pass, not interleaved with the existing ones.

**Bake allowlist (rev 2 addition) — the closed set the §2.1 law's FV check resolves against
BEFORE consulting `deps`:** `SPECIAL_FORMS ∪ KEYWORD_SYNTAX` (§2.1's fix) `∪ exports(K)` (§2.2,
same-capability native/rosetta/define names, phase-ordered per above) `∪
resolver-synth family` (the unbounded procedural names a `ResolverSpec` answers without a
`names` entry — `c[ad]+r`, `:key`-shaped accessors — §3.5's `pure`-resolver probe, reused
here rather than re-derived). Anything outside this allowlist must resolve through a declared
`deps` edge (§2.1's law) or is a bake-time door.

Additionally, the bake gains the ONE decidable ordering check the current prelude enforces
only by crashing: an **eager forward reference** — a define whose RHS is not a lambda form
and whose FV includes a LATER own-name — is a bake door with the reordering fix named.
(srfi-1's in-comment "some must precede zip" contract becomes machine-checked; the census
found zero live violations — all cross-refs are backward or inside lambda bodies.)

EXCLUDED: topological auto-reordering of a capability's defines. Order is authored,
meaningful, and preserved 1:1 by migration; silent reordering would make the declaration
record lie about evaluation order for zero demonstrated need.

---

## 3. The static validation pass

### 3.1 Contract

```ts
// src/static-validation/validate-program.ts (new directory — this is the compiler's
// front door, not a provenance artifact; provenance/ modules CONSUME forms, this one
// judges them)

/** ONE reference site — where the program touched the problem. */
export interface SiteRef {
  readonly symbol: string;             // the name as referenced
  readonly span: SourceLocation;       // the referencing Pair (__location__ — total, Q6)
}

/** CASCADE FUSION (prior-art CHOSEN — Elm/ESLint synthesis via the survey): a Diagnostic
 *  is keyed by its CAUSE, and carries the COMPLETE list of sites that cause explains.
 *  One missing `fs` key that disables require + require/extension, referenced 7 times,
 *  is ONE diagnostic with 7 sites — never 7 diagnostics (the 40-errors-one-cause wall).
 *  The grouping key is the CURE: config key / dep / capability for door buckets; the
 *  unknown NAME for bucket a; the contract for bucket d. */
export interface Diagnostic {
  readonly severity: "error" | "warning";
  readonly code:                       // closed vocabulary, additive
    | "unbound-symbol"                 // bucket a  (key: the unknown name)
    | "bound-to-door"                  // bucket b  (key: the cure — DoorCause.needs entry)
    | "missing-configuration"          // bucket c  (key: the config key)
    | "arity-mismatch";                // bucket d  (key: symbol × declared contract)
  readonly sites: readonly SiteRef[];  // every reference this ONE cause explains, in
                                       // program order — never a lone "first site"
  readonly message: string;            // host-facing: cause first, then the site list
  readonly publicMessage: string;      // agent-facing (the unbound-variable split, reused)
  readonly cause?: DoorCause;          // bucket b/c — the causal chain, structured (§3.3)
  readonly suggestions?: readonly string[];  // bucket a — SOUND subset only (§3.3a law)
}
export function validateProgram(
  forms: readonly SchemeValue[],       // reader output — parse already happened
  vocabulary: ProgramVocabulary,       // §3.2 — built from a sealed chain or a roster
): readonly Diagnostic[];              // NEVER throws; ALWAYS the complete list
```

The eslint discipline is a type fact: the pass returns an array, and only the CALLER decides
to throw. `exec` aggregates errors into ONE `StaticValidationError` carrying
`.diagnostics` (all of them, formatted one per line) thrown at parse phase, before the first
`execExpr` — V's "never crash-on-first" as an API shape, not a convention.

**Display discipline (prior-art CHOSEN — Unison's migration lesson):** a content hash
(`bodyHash`, `chain.hash`) NEVER appears in diagnostic text. Every identity in a message
resolves to `name @ capability` (`require @ arrival/loader`); hashes are addressing keys
for machines (§5.3), not UI. Enforced by the message assemblers, not convention — no
Diagnostic field carries a hash.

### 3.2 The core data model — a reference graph with MISSING as first-class nodes

**CHOSEN (prior-art architecture requirement — Dagger's MissingBinding precedent):** the
pass is NOT a traversal that emits messages as it walks. It builds an explicit **reference
graph** first, then derives every diagnostic as a graph QUERY. Dagger shipped the other
design — errors reported in traversal encounter-order — got nonsensical dependency traces,
and rewrote onto explicit graphs where a missing binding is itself a node (dagger#1614);
we start where they ended.

Node kinds:

```
ReferenceNode      one free-name occurrence in the program   (symbol × span — the SiteRef)
BindingNode        a vocabulary entry that resolves           (value | contract | macro)
DoorNode           a bound door                               (carries DoorCause)
MissingSymbolNode  a name NO chain entry answers              — first-class, one per name
MissingConfigNode  an absent config key                       — first-class, one per key
MissingDepNode     an unrooted capability                     — first-class, one per cap
CapabilityNode     an owning capability                       (name — display identity)
```

Edges: `ReferenceNode → (BindingNode | DoorNode | MissingSymbolNode)` (resolution);
`DoorNode → CapabilityNode` (owner); `DoorNode → (MissingConfigNode | MissingDepNode)`
(the need — from `DoorCause.needs`); `MissingDepNode → …` transitively when an unrooted
dep is itself declared with needs (the causal chain is a PATH in the graph, not prose).

Every bucket in §3.3 is then a query, and cascade fusion (§3.1) falls out structurally
instead of by bookkeeping: bucket b/c = *group ReferenceNodes by the Missing\* node their
resolution path terminates in* — one missing node, one diagnostic, all sites attached.
Bucket a = ReferenceNodes per MissingSymbolNode. The graph is also the §3.6 consumers'
shared artifact: the LSP wants nodes-at-a-span, discovery wants the door population,
mercury wants the FV∩exports closure — same graph, four queries. Cost: the graph is
O(references + doors) small; building it is the same single walk the naive design would
do, minus the premature message formatting.

The vocabulary interface the graph builder consumes:

```ts
export interface ProgramVocabulary {
  readonly names: ReadonlySet<string | symbol>;      // enumerable bindings
  lookupStatic(name: string): VocabularyEntry | undefined;
  // VocabularyEntry = { kind: "value" } | { kind: "door", cause: DoorCause }
  //                 | { kind: "contract", arity: ArityFacts }
  //                 | { kind: "macro", macroAttribute: "opaque" | "expression" | "binder" }  // §3.4 ternary (rev 2)
  //                 | { kind: "keyword" }   // §2.1's KEYWORD_SYNTAX — core's symbol.keyword entries (rev 2)
  readonly hasImpureResolver: boolean;               // §3.5 soundness switch
}
```

Two constructors, one pass:

- **Assembled mode (exec / DiscoveryTool / run-program):** built from the SEALED
  `CompiledResolutionChain` + the run's topScope names (REPL session accumulations — the
  DiscoveryTool replays prior bindings, and those names are legitimately bound for THIS
  call) + the program's OWN top-level definition names (collected in a first sweep over
  `forms` — a program's forward reference between its own top-level forms is ordinary
  top-level semantics, never a diagnostic). **The first sweep is MACRO-AWARE (rev 2
  soundness fix): it collects `define`, `define-macro`, AND `define-syntax` names.** Rev 1
  said "define names," and the natural implementation (`slice.ts`'s `defineNameOf`, line
  180) matches ONLY the literal `define` head — a program opening with `(define-macro
  (my-when …) …)` would have every later `my-when` call site reported unbound, a guaranteed
  false positive on legal programs (`define-macro` is an ordinary SPECIAL_FORMS entry,
  `evaluator.ts:2784`; agents and packs both use it freely). Same `macroAwareDefineNames`
  recognizer as §2.2's interim arm — one extension closes both holes. Soundness inherits
  the chain's: sealed, immutable, complete for enumerable names.
- **Roster mode (mercury front-end, codemirror, doc-gen — pre-assembly):** built from
  `EnvCapability.exports` (§2.2) over a declared roster, no lower() executed. Requires
  hermetic static-ness for full fidelity (builder-form capabilities degrade, §2.2 LIMIT).

### 3.3 The buckets

**(a) `unbound-symbol`** — `FV(form)` per top-level form (Q8a `freeVars`), minus vocabulary;
one diagnostic per MissingSymbolNode, all its sites attached (§3.2). Suggestions via
`suggestFromVocabulary` (the canonicalize + edit-distance-1 gates, MAX 3, under-trigger
discipline — all landed), with one NEW law on top:

> **Suggestion soundness law (prior-art CHOSEN — no surveyed system states it; ours does):**
> "did you mean X" may only offer names that would themselves VALIDATE under the present
> grants and config. The candidate set is the SATISFIED vocabulary subset — value/contract/
> macro entries — never DoorNodes: a suggestion that immediately re-errors on the next
> round-trip destroys agent trust faster than no suggestion. A door whose name is a close
> miss is NOT suppressed information — if the agent's intent was the door, they will
> reference it and get its own bucket-b diagnostic with the cure; the SUGGESTION channel
> stays sound. (This composes mechanically: filter the candidate iterable before
> `suggestFromVocabulary` — the landed machinery is unchanged.)

Severity: `error` in a pure-chain vocabulary; `warning` when `hasImpureResolver` (§3.5).

**(b) `bound-to-door`** — the name resolves, but to a door. Needed two changes; **both
LANDED as W0 (commit 98641484b3, 2026-07-10 — rev 2 status update)**, with one deliberate
narrowing against rev 1's illustrative shape:

1. **`DoorSymbolDef` grew a structured cause** (additive, optional — every raw
   `notImplemented` template keeps `{name, reason}`; the door FACTORY lives in
   `common/symbols/notImplemented.ts` and cannot know its own capability, so
   `common/capability.ts`'s door bind arm stamps `cause = {owner: capabilityName, needs: []}`
   at apply time — rev 2 file-reference fix: the minting/stamping split is
   notImplemented.ts + capability.ts's bind arm, `_bake.ts` only hosts the TYPES). The
   landed shape (`_bake.ts:410`):
   ```ts
   export interface DoorCause {
     readonly owner: string;                        // owning capability name
     readonly needs: readonly { kind: "configuration"; key: string; hint?: string }[];
   }
   // DoorSymbolDef gained `readonly cause?: DoorCause` (+ preludeOnly)
   ```
   **NARROWED vs rev 1 (a critique finding folded into W0 mid-flight):** rev 1's `needs`
   union also sketched `{kind: "dependency"}` / `{kind: "resource"}` arms. `dependency` has
   an UNRESOLVED design hole — naming an UNROOTED capability (absent from the root set, so
   its own doors never bind at all; C3 pulls deps as object edges, not string ids) has no
   policy — so W0 shipped only the derivable-with-no-open-question kind: `configuration`.
   The union grows additively when the unrooted-capability policy is designed — **added to
   the §8 decision list (rev 2)**. Until then, §3.2's `MissingDepNode`/`MissingResourceNode`
   edges are DESIGN-target graph shapes with no producer.
2. **Doors bind an introspectable value.** `capability.ts`'s door arm (now :366-386) binds
   a `DoorProcedure` (`values/primitives/ACallable.ts` — an `AValue` subclass IN the
   `ACallable` union, keeping `is_callable_value`/`z.lambda` sound rather than making doors
   lesser non-callables) — throws the same teaching `PurityError` when applied
   (byte-compatible for cause-less doors; cause-carrying throws lead with `name @ owner`,
   never a hash — the §3.1 display discipline, enforced from day one), and exposes `.door`
   for static readers. ~106 production doors pinned by `it.each` in the declared-doors law
   suite. The suggestion machinery already noted "declared doors ARE bindings, so declaring
   a stub makes it typo-suggestible for free" — W0 completed that thought: a referenced
   door is now statically reportable for free. (W3 still owes the CONSUMER — nothing at
   HEAD reads `.door` yet.)

The diagnostic's message is assembled mechanically from the cause chain:
`require — declared by arrival/loader, disabled in this assembly: configuration key "fs"
was not provided in the exec configuration. Referenced at 12:4; this program would crash
there. Provide "fs" to enable it.` (The full worked derivation: §5.1.)

**(c) `missing-configuration`** — two sub-cases, one code:
- *Assembled mode:* subsumed by (b) — an absent-config symbol IS a door with a
  `configuration` need (door-set degradation, §3.7). The distinct code fires when the
  program references a door whose need is config (vs dep/resource) so the message leads
  with the config key, matching V's target UX.
- *Roster mode:* the fused config schema (the hermetic sibling's §5 fusion — every rooted
  capability's declared keys, agree-door checked) diffed against the PROVIDED exec-config
  bag: a required key (non-optional, no default, per its zod schema) that is absent AND
  whose owning capability's symbols the program references → diagnostic. LIMIT: value-level
  validity (a present-but-wrong value) is NOT statically judged — presence is
  key-membership, validity is the lower-time dual-parse's job (§3.7's absent-vs-invalid
  line).

**(d) `arity-mismatch`** — for a head-position application `(f a₁ … aₙ)` where `f` resolves
to an entry with a declared contract whose input is a FIXED tuple (no `inputRest`, no
kwargs-record, not shapeless `z.array`): compare n against the tuple's min/max (trailing
`z.optional` arms lower the min — `lookupName`-through-optional, the same resolution
`extractCallbackRoles` uses). Mismatch = `error` with both counts and the contract's
harvest signature in the message. **Honest scope, stated as a boundary not an aspiration:**
head-position direct applications ONLY — no flow analysis (a rebound `(define g f)` is not
tracked), no value/type checking of the arguments (the type-lens's job, EXCLUDED here), no
checking through `apply`/callbacks. This bucket is the cheap 80%: wrong-arg-count on a
directly-named verb, the single most common agent error in the manifold telemetry.

**(e) DEFERRED bucket list** (named so a later pass has a slot, not designed here): role
misuse (a `sink`-role verb referenced inside a define whose derived role claims `pipe`);
effect-in-pure-context (port verbs inside `preludeOnly` defines); literal-argument gross
type mismatch (a string literal into a `z.number` arm — decidable without inference);
static `require`-target resolution (§6.3); static macro expansion (§3.4).

### 3.4 Macro calls — the false-positive firewall (rev 2: the attribute is TERNARY)

`freeVars` walks unmodeled heads as plain applications — correct over-approximation for the
wire-locality LAW (a missed free name is the failure mode there), **wrong direction for
diagnostics** (a false "unbound" is poison — the unbound-variable module's own rule:
"under-trigger, never guess"). A macro call's arguments may not be expression space:
`(cut cons <> 1)`'s `<>` would report as unbound.

**Rev 1's boolean `transparent` was UNSOUND, and its own example list proved it.** Rev 1
declared `transparent: true` on "`and-let*`, `receive`, `let-values`" alongside the
threading family — but those three are BINDER macros: `(receive (q r) (floor/ 7 2) (list q
r))` has `q`/`r` in FORMALS position (`env/srfi/srfi-8.ts:16` expands them into a `lambda`
formals list); `let-values` (`env/r7rs/binding.ts:76`) and `and-let*` (`env/srfi/srfi-2.ts:16`)
likewise bind their claw/binding names. A boolean-transparent walk treats every argument as
expression space — so `q` and `r` report UNBOUND on a perfectly legal program: a guaranteed
false positive, in the error tier, violating §3.5's soundness contract. The attribute must
distinguish three surface grammars, not two:

| `macroAttribute` | Walk policy | Population (census-audited at migration) |
|---|---|---|
| `"opaque"` (DEFAULT) | interior contributes NOTHING to any bucket — no unbound reports, no arity checks inside. Under-report, never lie. | `cut`/`cute` (placeholder tokens), `superdefine`, anything unaudited |
| `"expression"` | every argument is ordinary expression space; walk normally | threading family (`->`, `->>`, `~>`, `~>>`), other alias/wrapper macros whose surfaces are plain expressions |
| `"binder"` | **treated as `"opaque"` until a binding-aware macro walker exists** — the interior is a firewall blind spot, NOT walked as expressions | `receive`, `let-values`, `let*-values`, `and-let*` — macros whose argument positions include FORMALS |

The `"binder"` value is declared now (it is the honest classification, and the doc-gen /
LSP surfaces want it) but buys no walk precision yet: walking a binder correctly requires
knowing WHICH argument positions bind and over WHAT scope — per-macro binding metadata a
one-of-three enum cannot carry. CHOSEN: binder-position macros stay firewalled (opaque-
equivalent for FV purposes) until a binding-aware macro walker — per-macro `(binds …)`
position specs or static expansion — is designed and lands; promoting a binder to walked
status without that machinery re-opens the exact false positive this revision closes.
DEFERRED: that walker (and full static expansion — run the expander at validation time;
sound now that Q6 makes expansion span-total, but it executes author code at parse phase
and needs its own budget/purity ruling).

LIMIT: an `"opaque"`/`"binder"` macro's interior is a diagnostic blind spot; a genuinely
unbound name inside `(cut …)` or a `receive` body surfaces only at runtime (the backstop,
§3.5). The ternary with an audit-sized population is the honest interim.

### 3.5 Soundness statement (rev 2: the contract rephrased, and its four leaks named)

**What immutability buys (the claims):** against a SEALED chain, `names` is complete for
enumerable bindings and frozen for the assembly's lifetime — so "unbound" judged at parse
phase cannot be invalidated by evaluation (no post-seal writes exist; the write-window is
construction-scoped, T3). The program's own definition names (define + define-macro +
define-syntax, §3.2's macro-aware sweep) are collected in the first sweep, and the
topScope's session names are point-in-time complete AT the call (REPL forward references
across FUTURE calls do not exist by causality).

**The contract, stated honestly (rev 2 rephrasing — rev 1's "zero false-positives" was
false four ways at rev 1's own spec):** the pass advertises **no spurious `unbound-symbol`
errors, MODULO the EXCLUDED reachability strictness** — dead-branch references
(`(if #f (missing) 42)`, §6.6) report by DESIGN and are not false positives; they are the
one deliberate divergence from runtime semantics, opt-out documented. Everything else that
would produce a spurious unbound is a BUG against this contract, and rev 2 closes the four
known ones: **(1)** SPECIAL_FORMS/keyword-syntax heads reporting unbound on pure programs —
closed by §2.1's `KEYWORD_SYNTAX` baseline (core's keyword exports are unconditional
vocabulary); **(2)** binder-macro formals reporting unbound under boolean transparency —
closed by §3.4's ternary (`"binder"` firewalls until a binding-aware walker exists);
**(3)** program-level `define-macro`/`define-syntax` names invisible to the first sweep —
closed by §3.2's macro-aware sweep (and §2.2's gated interim arm for roster mode);
**(4)** sibling-define references inside a `lambda`/`let` BODY... — see the internal-define
paragraph below, which is a W3 PREREQUISITE, not yet closed by construction.

**Internal define sequences — a W3 prerequisite (rev 2, the fourth leak):** verified
against `free-vars.ts`'s `define` arm (line ~205): `(define (f …) body…)` binds `f` + its
params for **its own body only** — the binding does NOT extend to SIBLING forms in the
enclosing body sequence. R7RS §5.3.2 internal defines have letrec\* semantics: in
`(lambda () (define (a) (b)) (define (b) 1) (a))`, `a`'s body referencing `b` is legal —
but `freeVars` walks `a`'s define before `b`'s name is anywhere, reports `b` free, and the
validator would emit a spurious unbound on a legal program. (Top-LEVEL sibling defines are
already handled by §3.2's first sweep; this leak is INTERNAL define sequences — inside
lambda/let/define bodies.) **CHOSEN: W3 must either (i) teach the walker R7RS
internal-define scoping — when walking a body sequence, pre-collect the sequence's leading
internal-define names (letrec\*-visibility, matching the evaluator) before walking any of
its forms — or (ii) ship with internal-define-sequence residuals DEMOTED to `warning` until
(i) lands.** Option (i) is the target (it is a body-sequence pre-pass, the same shape the
top-level sweep already has); option (ii) is the honest fallback that keeps the error tier
sound either way. Stated as a prerequisite: W3's gate includes a corpus case for the
`(define (a) (b)) (define (b) …)` shape at both top level and internal positions.

**The tier contract (prior-art CHOSEN — Dialyzer's discipline):** the `error` tier is
SOUND — an `error` diagnostic is a proof the program cannot run as assembled (modulo the
EXCLUDED reachability strictness, which is a documented design divergence, not a
heuristic); anything the pass cannot prove degrades to `warning` (the impure-resolver
switch below, the roster-mode interim-arm degradation §2.2, internal-define residuals under
option (ii)) or is not emitted (the §3.4 macro firewall). Suggestions are the one
explicitly-heuristic channel, labeled as such in the message ("did you mean") and bound by
the §3.3a soundness law. Every future bucket must declare which side of this line it is on
before landing.

**Resolvers:** synthesized names (`c[ad]+r`, `:key` accessors) are absent from `names` by
construction (CompiledResolutionChain.ts:92). The pass PROBES: for each candidate-unbound
name, ask each compiled resolver step `resolve(name)` — sound iff the resolver is `pure`
(ResolverSpec.pure — "NAME-STABLE results … same name ⇒ same value forever", exactly the
license probing needs; the chain already memoizes through pure steps on the same license).
An IMPURE resolver anywhere in the chain flips `hasImpureResolver`: every `unbound-symbol`
degrades `error → warning` ("may be answered dynamically") — honesty over strictness, and
the degradation is per-chain, visible, and disappears when the chain is pure. Keyword-shaped
names never reach the check at all (`freeVars` excludes them by construction).

**What stays undecidable (the runtime-door backstop, permanent):** computed heads
(`((car ops) x)` — the head is checked as a variable, the application target is not);
`eval`-family / `string->symbol`-driven lookups; contents of files a runtime `require`
loads (§6.3); non-transparent macro interiors (§3.4); glass mode (`{env}` — a live,
embedder-mutable frame chain; no seal ⇒ no claims — the pass is simply not offered there,
matching the env-composition doc's "every Env-derived guarantee is not claimed for glass").
For all of these, the existing runtime doors (unbound-variable throw with suggestions,
PurityError doors) remain the backstop — the pass narrows the runtime-surprise surface, it
never claims to close it.

### 3.6 Where the pass runs

| Consumer | Mode | Wiring | Failure posture |
|---|---|---|---|
| `exec` (generator-exec.ts) | assembled | after `parse`, before the form loop; vocabulary from the run's sealed chain + scope | `error` diagnostics ⇒ throw ONE `StaticValidationError` (all diagnostics); `staticValidation: "off"` opt-out on ExecOptions |
| `runProgram` (arrival-run) | assembled | the existing parse-then-loop split (run-program.ts:390-396) — validate between; diagnostics also exposed on `RunHandle` for the studio | same as exec |
| MCP `DiscoveryTool.call` | assembled | after its `parse(args.expr)` (DiscoveryTool.ts:280); diagnostics serialized as structured `(diagnostics …)` S-expr output BEFORE any eval — the custdev win: an agent gets the complete list, not first-crash | errors block eval of that expr; REPL session state untouched |
| mercury compiler front-end | roster | `validateProgram` is the checker's first stage over the same reader forms the lowerer consumes — one analyzer, two consumers. (Honesty note: the dual-runtime doc does not name a "front half" verbatim; what it ships is per-plane static analyses (async taint fixpoint, dict-shape) — this pass slots BEFORE them as the reference/vocabulary plane.) | compile error list |
| arrival-codemirror LSP | roster (or assembled when a session env exists) | diagnostics ARE the squiggles; consumer noted, integration NOT designed here | n/a |

**Cost ruling (exec runs in a DO on every call):** the pass is one `freeVars` walk per
top-level form (linear in AST, no allocation beyond the sets) + Map/Set lookups + resolver
probes on misses only. This is strictly cheaper than the parse that just produced the forms.
CHOSEN: land WITHOUT a cache, measure in the DO harness; the cache design (key =
FNV-1a(source) × `chain.hash` — both cheap, the second already exists; no `programHash`
exists at HEAD, verified) is specified here so it can land as a follow-up without a design
round IF measurement demands it. Measure-and-judge, not speculate-and-build.

### 3.7 Door-set degradation — the lower() change that makes bucket (b) reachable

Rev 1 opened this section with "today an unsatisfiable capability throws at `lower()`" —
corrected per §0's flagship finding: today's dominant posture for OPTIONAL enabling config
is WITHHOLD (the symbol never binds; loader-capability.ts's own header says so), and the
one genuinely-required config in production (`infer`) doesn't throw either — its
`z.custom()` schema is a silent no-op. The design below replaces withholding with doors and
makes the required/optional split EXPLICIT rather than accidental. CHOSEN rows, rev 2:

- **CHOSEN — "assembly always succeeds" is NARROWED to absent-optional-input only.** Only
  the absence of an OPTIONAL enabling input (a config key or dep whose schema/declaration
  marks it optional — the `fs` shape) degrades to a door-set. Two failure classes STAY
  throw paths, unchanged: **(i) present-but-invalid config** — a supplied value failing its
  `schema.parse` is a host bug, not a feature-not-enabled state; degrading it would hide an
  error behind a door (the hermetic sibling's agree-door at fuse time is upstream of this
  and unchanged); **(ii) pack apply errors** — an exception thrown from a capability's own
  `apply`/bind logic is a defect, never a door. The dissolution slogan is therefore
  precisely: *absent optional enabling inputs degrade; everything else that fails today
  keeps failing loudly.*
- **CHOSEN — required config stays fail-closed.** A REQUIRED config key (non-optional per
  its zod schema) that is absent is a `lower()` throw — the security-sensitive line §0
  names: moving `infer`'s missing host `InferFn` from fail-closed to a soft door would turn
  a provisioning error into a program-scoped shrug. (And §8 gains the follow-up: `infer`'s
  bare `z.custom<InferFn>()` must grow a predicate so "required" is actually enforced —
  today it fails neither closed nor open, it fails LATE with a raw TypeError.)
- **CHOSEN — `degradation: "forbid"` is the DEFAULT for host/provisioning paths.** Rev 1
  made doors the universal default; rev 2 splits by caller class. Host-side assembly
  (server boot, DO provisioning, anything that assembles once and serves many programs)
  defaults to `"forbid"`: fail-fast at provisioning is the posture those callers rely on
  today, and silently converting their absent-config crashes into doors would change
  operational behavior under them. Program-scoped callers (exec-with-inline-config, the
  DiscoveryTool session, custdev harnesses) opt INTO `degradation: "doors"` — which their
  entry points do as part of W3 wiring, making doors the EFFECTIVE default exactly where a
  program is present to validate. The dissolution survives intact: strictness is
  caller-scoped, and the parse-phase diagnostic exists wherever a program exists.
- **Absent optional enabling input ⇒ degrade (the mechanism).** The capability lowers in
  degraded mode: every symbol it would bind becomes a `DoorSymbolDef` with the mechanical
  `cause` (`owner` = capability, `needs` = the absent keys — `configuration`-kind only
  until the W0-deferred `dependency`/`resource` kinds land, §3.3b). The kernel MINTS these
  doors — authored `notImplemented` doors and minted degradation doors are the same kind,
  different provenance.
- **CHOSEN — degraded capabilities are ENUMERABLE on the assembly.** `AssembledEnv` (or the
  `assembleEnv` result surface until the env-composition sibling's `Env.assemble` lands)
  carries a `degraded: readonly {capability: string, needs: DoorCause["needs"]}[]` list —
  hosts and discovery read WHICH capabilities lowered degraded without probing symbols one
  by one. A monitoring host can alert on non-empty `degraded` even under `"doors"` mode.
- **Discovery-surface change, named honestly (rev 2):** doors are enumerable bindings — an
  agent listing the environment sees `require` as PRESENT-but-doored where today it sees
  nothing at all. That is the design's point (present-with-cause beats absent-and-silent),
  but it changes what discovery/LEARN surfaces render and what agents infer from a name's
  presence; DiscoveryTool's catalog row for a doored symbol must carry the door marker so
  "present" is never read as "callable". W3's custdev gate covers this.
- **Interaction with the hermetic loader split (§8 there):** that design made loader config
  "effectively required: a loader-less lower is a lower-time teaching door". This design
  SUPERSEDES that posture per V's ruling — the loader's enabling config is genuinely
  OPTIONAL (verified: `.optional()` at loader-capability.ts:154/157), so under
  `degradation: "doors"` it lowers degraded, `require` binds as a door, and the door
  surfaces at parse phase IFF the program references it.

**W2 scope additions (rev 2 — the migration debt the posture change creates):**
1. **Inventory every `assembleEnv`/`lower()` caller that branches on a throw** — any
   caller whose control flow relies on absent-config throwing (provisioning checks,
   test guards) must either be confirmed under the `"forbid"` default or explicitly
   migrated. The inventory is a W2 deliverable, not an assumption.
2. **Rewrite the loader tests that pin the WITHHOLD posture** — suites asserting
   `(require …)` in a loader-less env throws "Unbound variable" (the posture
   loader-capability.ts documents) will see a door's `PurityError` teaching text instead
   under `"doors"` mode. Those assertions are the posture's pin; they change WITH the
   posture, deliberately, in the same commit.
3. **The discovery-surface change above** — DiscoveryTool/LEARN rendering of doored
   symbols, verified against an agent round-trip in the custdev gate.

---

## 4. Prelude death

### 4.1 Census (full monorepo sweep, 2026-07-10)

**FINAL STATE — DONE ledger (W4-H4, script-regenerated 2026-07-10).** The census below was the
PRE-migration roster; it is now a completed ledger. Regeneration script (the roster-rot lesson
— derive, never hand-maintain):

```
grep -rnE "prelude:\s*[\`\"]" <monorepo package trees> \
  | grep -vE "/dist/|/node_modules/|/build/|/\.next/|/\.wrangler/|/\.open-next/|storybook-static|__tests__|\.test\.|\.spec\.|/docs/|/scripts/|__research__|/intent-eval/|hot-update|spike-|host-prelude|buildPrelude|preludeSource"
```

Script output at HEAD: **5 surviving `prelude:` fields, ALL registration-call-only** (the §4.3
residue, zero defines, zero macros) —
`llm-plane-arrival-env/src/utils.ts` (`.hbs`), `…/prompt.ts` (`.prompt`),
`arrival-ext-toml/src/ext-toml.ts` (`.toml`), `arrival-ext-yaml/src/ext-yaml.ts` (`.yaml`/`.yml`).
Every DEFINE/DEFINE-MACRO prelude is gone: the 19 define packs and the macro packs are migrated
to `symbol.define`/`symbol.defineSyntax`, and the last macro-carrying prelude outside the arrival
tree — `arrival-run`'s `superdefine` (`run/continue-after-approval`) — migrated in W4-H4. The
`CapabilitySpec.prelude` FIELD itself survives (interim, §4.4) as the channel those 5 registration
calls stand on; its rename to `bootstrap` + the no-define bake check remain DEFERRED (§4.3) — five
calls do not yet justify the kernel-metadata channel a fully-declarative `extensions:` field needs.

Historical PRE-migration census (retained for lineage):

**23 production `EnvCapability` preludes** (rev 2 correction: rev 1 said 22 — the critique
round found `r7rs/exceptions` missing from the count and `srfi-235` missing from the
breakdown table despite §2.1 citing it as the live dep catch; both verified prelude-carrying
at HEAD: `env/r7rs/exceptions.ts`, `env/srfi/srfi-235.ts`), ≈960 scheme lines. All are
inline template literals (zero `.scm`-file preludes; zero config-derived prelude text —
grep-verified by the hermetic sibling too). **A hand-maintained pack list has now been wrong
once — the census should be REGENERATED BY SCRIPT (a `grep -rln "prelude:"` sweep with the
test/example excludes encoded) at each wave boundary, and W4's per-pack checklist derives
from the script output, not this table.** Breakdown:

- **19/23 are PURE define/define-macro series** — V's "purely series of defines" holds for
  ~950 of 960 lines. Two packs dominate: `scheme/polyglot` (315 lines, ~40 forms, dense
  per-define comments) and `scheme/srfi-1` (234 lines, ~35 defines, per-define comments +
  the one in-comment ordering contract) = 57% of all prelude text. The rest: `arrival/schema`
  (13 defines), srfi-128/-189/-43 (defines), srfi-2/-8/-26, **srfi-235** (defines — the
  §2.1 undeclared-dep catch), r7rs/binding, r7rs/syntax, **r7rs/exceptions** (rev 2
  additions), overridable, mcp-declare, superdefine (macros), core (4 defines), infer
  (3 defines).
- **4/23 are NOT defines** — `arrival/utils`, `ext/prompt`, `ext/toml`, `ext/yaml`: their
  entire payload is 1-2 `(require/register-extension ".ext" "resolver-name")` calls — the
  `preludeOnly` assembly-time registration verb. Five forms total, the ONLY non-define
  top-level prelude content in production.
- **Comments as descriptions:** serviceable per-define `;;` comments in all but a handful
  of the tiny packs (rev 1's "8 of 22" was a hand count over the wrong roster — the script
  regeneration above re-derives the exact figure; the shape of the claim survives: the two
  big packs are RICH, a minority of small ones are bare); polyglot/srfi-1 comment blocks
  are harvested into `description` at migration.
- **Cross-references:** all intra-capability refs are backward or lambda-late-bound (zero
  eager forward refs — §2.3's check lands green). ONE cross-capability ref:
  srfi-235→polyglot's `compose`, undeclared (§2.1's live catch).
- **Test-only outlier:** the chibi harness capability (~67 lines) interleaves a bare
  registration call between defines — stays on §4.3's `bootstrap` residue, test-only.

### 4.2 Decomposition shape — TWO passes per pack (rev 2, per V's enforced-day-one ruling)

**Pass 1 — mechanical decomposition:** parse the prelude (rev 2 correction: `extract-defines.ts`
recognizes ONLY the literal `define` head today — its docstring says it "quietly ignores …
`(define-syntax …)`" and it never matched `define-macro`; the recognizer extension is the
same `macroAwareDefineNames` work §2.2 gates on, one change serving three consumers); emit
one `symbol.define` per value/procedure define (RHS-expression form, §1.1;
`(define (f . a) …)` → `(lambda a …)`), one `symbol.defineSyntax` per macro (with its §3.4
`macroAttribute` audited and declared); harvest the adjacent `;;` block as the description.
Declaration order = textual order, 1:1.

**Pass 2 — contract authoring (the non-mechanical half V's ruling added):** every
`symbol.define` gets a REAL contract, authored per define, day one — no shapeless default
(§1.2, superseded). ~200 contracts across the 23 packs. This is judgment work (what IS
`fold`'s honest input vector; which polyglot aliases are genuinely variadic-shapeless), not
agent-mechanical, and it is the migration's cost center — budget it at 3-5× the mechanical
pass per pack.

**The gate is SEMANTIC EQUIVALENCE, not byte-identity (rev 2 correction):** enforced
contracts WRAP closures — a wrapped `fold` is not byte-identical to the prelude-evaluated
one, and error surfaces move (a wrong-arity call that used to fail inside the body now
fails at the contract boundary, with a better message). The per-pack gate is therefore the
behavior suites + the chibi conformance ledger at **651 EXACT** (its own count — rev 1's
"3046" was the full-`pnpm test`-suite figure, a different gate; both run, they gate
different things) + the full parallel `pnpm test` green. Each pack is one commit.

### 4.3 The residue: `prelude` dies, `bootstrap` survives — narrowed and policed

The 4 registration packs (and the test harness) carry genuinely CALL-shaped content.
CHOSEN: `CapabilitySpec.prelude` is DELETED; a new `bootstrap?: string` field carries
call-only assembly wiring, evaluated exactly where prelude is today (after symbols bind,
against `preludeEvalScope ?? env`) — with a bake-time check that **no top-level define
occurs in it** (a define in bootstrap = teaching door pointing at `symbol.define`). The
rename is the semantics: nothing about it is a "prelude" anymore; it is the assembly-time
effect channel, and its entire production population is five registration calls.
DEFERRED (not excluded): fully-declarative extension registration (an `extensions:
{".toml": "ext/toml/resolve"}` data field the loader consumes) — it would empty `bootstrap`
entirely, but it needs a kernel-level metadata channel between capabilities that nothing
else demands yet; five calls do not justify it today.

### 4.4 What dies in the kernel/capability machinery — and what does not

| Piece | Fate |
|---|---|
| `CapabilitySpec.prelude` + capability.ts's prelude-eval branch (:426-435 at HEAD — rev 2 line-ref refresh, W0 shifted the file) | DIES (branch becomes the `bootstrap` eval + no-define check) |
| `collectPrelude` (capability.ts:155) | DIES as the type-lens/editor vocabulary source — replaced by `exports` + declaration walk (structured, not text). Survives through migration as the interim-arm reader (§2.2), deleted with the last prelude. |
| `evalScheme` requirement on `lower()` | NARROWS: still needed for `bootstrap` packs and define-body evaluation — the signature stays, the doc changes |
| kernel `preludeScope` phase-gated overlay + `preludeOnly` | **SURVIVES, unchanged.** Its consumers are the `preludeOnly` verbs (`require/register-extension`) called from `bootstrap` — and `preludeOnly` DEFINES (§1.5) bind through the same `bindTarget` routing. The overlay was never about prelude TEXT; it is the assembly-phase binding channel. |
| `preludeEvalScope` mid-run machinery (RuntimeAssembler.require) | SURVIVES — the mid-run `require()` path is orthogonal to capability preludes |
| The hermetic replay recipe's "program prelude" (Q7 `buildPreludeSource`) | UNTOUCHED — that is the PROGRAM-level prelude (user defines partitioned by port-reach), a different layer that keeps its name |

Honest accounting: prelude death removes a FIELD and a text-blob idiom; it does not remove
the phase-gating machinery, which turns out to be the assembly-time binding channel both
residue and `preludeOnly` defines stand on.

### 4.5 Migration estimate (honest — rev 2: re-costed under the enforced-day-one ruling)

Rev 1's estimate priced Pass 1 only ("contracts: shapeless at migration; tightening is
open-ended follow-on") — **that language is EXCLUDED, superseded by V's ruling 2026-07-10**
(§1.2). The ruling stands; the estimate changes:

- **Pass 1 (mechanical):** 19 define packs ≈ ~90 defines + ~15 macros: agent-tier work,
  ~1-2 packs/commit; the two big ones (polyglot, srfi-1) a session each including
  comment-harvest and macro-attribute audit.
- **Pass 2 (contract authoring):** ~200 real contracts across the packs — judgment-tier
  work at **3-5× the mechanical pass's time**; srfi-1's list-op contracts are
  well-specified (SRFI text is the oracle), polyglot's alias population needs per-define
  variadic-vs-fixed calls. This is the migration's dominant cost, priced in, not deferred.
- **Per-call decode perf budget (rev 2 addition):** before the srfi-1 family lands
  enforced, measure per-call decode overhead on the hot recursive defines (`fold`,
  `fold-right`, `map`-family — the ones that self-recurse per element, paying the boundary
  N times per list). Budget: enforcement must stay within a measured factor the DO harness
  tolerates (set the number from the W3 cost measurement, same harness); a define that
  blows it gets the §1.2 `validate: false` valve WITH the measurement cited in a comment —
  the valve is evidence-gated, never reached for by default.
- 4 bootstrap conversions + harness: trivial (rename + field move).
- The srfi-235 dep fix: one line (+ its census-table row, §4.1).
- **Gates:** chibi conformance ledger **651 EXACT** + full parallel `pnpm test` green
  (rev 2 correction: rev 1's "chibi ledger byte-identical (3046)" conflated the two — 3046
  was the old full-suite case count, not the chibi ledger; and "byte-identical" is the
  wrong bar under enforced contracts, §4.2's semantic-equivalence gate is the real one) +
  `tsc -p` build (build-authoritative rule) + arrival-mcp + arrival-run suites for the
  packs they consume.
- **Provenance regression gate for infer/loader packs (rev 2 addition):** the two packs
  whose defines wrap PORT verbs (§1.4's "capability defines are not all pure-prelude
  material" — infer's three defines; loader's require-family) get a dedicated gate: the
  wireframe/lineage suites must classify their decomposed defines to the SAME roles the
  prelude-era classification produced (the derived-role machinery is NEW code on these
  packs specifically; a silent role flip here corrupts every §5.2 consumer downstream).
- Risk concentration: polyglot's `define-macro` population under `symbol.defineSyntax` —
  macros are the least-mechanical corner (expander-form rewrite + `macroAttribute`
  adjudication); budget a careful review pass there specifically.

---

## 5. What it unlocks

### 5.1 The target UX, derived end-to-end (rev 2: the BEFORE is withhold, not throw)

Program: `(runPrompt "summarize" (lambda () (require "file.scm")))` (require nested in a
callback — nesting is irrelevant to FV). Exec: `exec(src, { capabilities: [infer, loader,
…], config: { infer: … }, degradation: "doors" })` — no `fs`; a program-scoped caller, so
doors mode (§3.7's caller split).

**What happens TODAY at HEAD (the before, corrected — §0):** the loader lowers fine with
`fs` absent (it's `.optional()`), `require` is simply never bound, and the program runs
until the callback fires — then dies with a generic *"Unbound variable: require"* plus
whatever edit-distance-1 suggestions the vocabulary happens to offer. Indistinguishable
from a typo; `runPrompt`'s side effects (the inference call) already fired. Nothing threw
at assembly; nothing COULD explain that `require` is a real verb one config key away.

**The after, derived:**

1. `assembleEnv` lowers the roster under `degradation: "doors"`. `arrival/loader` finds
   `fs` ABSENT (not invalid; an OPTIONAL enabling key, so degradation applies — had it
   been `infer`'s REQUIRED key missing, this is where the fail-closed throw fires instead,
   §3.7) → degraded lower: `require` binds as a minted `DoorProcedure` with
   `cause = { owner: "arrival/loader", needs: [{kind: "configuration", key: "fs",
   hint: "a filesystem"}] }`, and `arrival/loader` joins the assembly's `degraded` list.
   Assembly succeeds; seal produces the chain.
2. `exec` parses → `forms` (reader stamps every Pair's `SourceLocation`).
3. `validateProgram(forms, vocabularyFrom(chain, scope))`: sweep 1 collects program
   definition names (define/define-macro/define-syntax — none here); sweep 2 runs
   `freeVars` per form and builds the §3.2 graph:
   `Reference(require@7:31) → Door(require) → Capability(arrival/loader)` and
   `Door(require) → MissingConfig(fs)`; `Reference(runPrompt@7:2) → Binding(contract)`.
4. Queries. Bucket d over `runPrompt`'s BindingNode: arity fits, no node. Bucket b/c:
   group ReferenceNodes by terminal Missing\* node → ONE `MissingConfigNode(fs)` explains
   one site here (had the program also called `(require "a.scm")` at 2:1 and
   `require/extension` at 9:5, the SAME diagnostic would carry all three sites — cascade
   fusion, §3.1). Message assembled by walking the graph path — no prose authored
   anywhere, every clause is a node or edge, identities as `name @ capability` (never a
   hash, §3.1):
   > Configuration key `fs` (a filesystem) was not provided in the exec configuration.
   > It disables `require @ arrival/loader`, which this program references at 7:31
   > (inside `(runPrompt …)`) — the program would crash there. Provide `fs` to enable it.
5. The pass continues (eslint discipline) — a typo'd `summrize-helper` elsewhere lands in
   the SAME list as its own diagnostic, its suggestion drawn from the satisfied subset
   only (§3.3a law: a door is never offered as a fix).
6. `exec` sees ≥1 error diagnostic → throws `StaticValidationError` with the complete list,
   before evaluating anything. Zero side effects fired (contrast the before: `runPrompt`'s
   inference call had already run). The same list, as data, is what DiscoveryTool hands an
   agent and what the LSP paints.

The win, restated against the corrected before: not "throw moved earlier" but *an
unexplainable absence became an explained presence* — the same program that today produces
a typo-shaped unbound at runtime produces, at parse phase, the full causal chain and the
one-key cure.

### 5.2 Per-define provenance — the wireframe sees through capability vocabulary

Today a capability's prelude defines are invisible to the classifier (bound closures with no
declaration); a program calling `infer/chat`-wrapping helpers gets an opaque cone edge at
the helper. With derived roles (§1.4) stamped per define and bodies span-total (§1.3), the
lineage classifier reads capability defines with exactly the visibility program defines
have — cones extend one layer deeper, into the vocabulary, ending only at genuine JS
membrane crossings.

### 5.3 Cross-deploy identity — the chain hash gains a value axis

`CompiledResolutionChain.hash` is vocabulary-SHAPE only (sorted names + resolver ids; its
own header defers value hashing). `bodyHash` per define (§1.3) gives the hashable surface
the hermetic sibling's §7.4 wanted but couldn't have ("zod schemas don't hash trivially"):
scheme bodies are stable TEXT. Chain hashing extends to fold define bodyHashes in step
position — two deploys differing in one srfi-1 body stop sharing an address. Composition
rule (prior-art, Unison's model): a capability's surface hash folds its DEP capabilities'
surface hashes, not just its own entries — otherwise two "identical" capabilities over
different deps collide. And the display rule travels with it (§3.1): the hash is an
addressing key; every human/agent surface resolves it to `name @ capability`. (JS impls
remain shape-hashed — LIMIT unchanged, honestly inherited.)

### 5.4 Doc generation & discovery

`name + description + contract-harvest-signature + derived-role` per define = the LEARN.md /
DiscoveryTool catalog row, mechanically. Today `collectPrelude` hands the editor a text blob;
after decomposition the discovery surface enumerates defines exactly like rosettas —
including for typo suggestions, which already ride the vocabulary.

### 5.5 The compiler consumes defines as lowerable source

Mercury's TS emitter today can only lower what it sees — program source. Capability defines
as declared scheme TEXT (`def.body`) make the vocabulary itself lowerable: srfi-1's `fold`
can compile to TS instead of requiring the interpreter at runtime — the zero-runtime "wires"
argument extended from program code to capability code. Roster mode (§3.2) already hands the
compiler the exact define set its program references (FV ∩ exports, transitively) — the
tree-shake falls out of the same analysis. DEFERRED as mercury-side work; the enabling fact
(bodies are data) is this design's.

---

## 6. EXCLUDED / LIMIT register

1. **Generalized prelude does NOT survive — but a narrowed `bootstrap` does (§4.3).** The
   census grounds this: 5 registration calls are the entire non-define production content.
   Excluding them from the declaration vocabulary is honest (they are effects, not
   definitions); pretending they don't exist would smuggle them back as fake defines.
2. **Full type inference / value-type checking — EXCLUDED, type-lens territory.** The pass
   checks reference-existence, door-reachability, config-key presence, and direct arity.
   The moment it wants "this argument's TYPE is wrong," it is re-implementing the type-lens
   badly. The contract vocabulary is SHARED with the lens (same schemas); the division of
   labor is: this pass = "will it resolve and dispatch," the lens = "is it well-typed."
3. **Dynamic `require` validation beyond reference detection — LIMIT now, DEFERRED design.**
   Statically we detect that `require` is referenced and whether it is enabled. What the
   required FILE binds is invisible (needs a VFS snapshot at validation time + recursive
   parse — a real design with real questions about staleness and cycles). Until then,
   names introduced by runtime `require` are exactly the impure-resolver case: if the
   loader registers an impure resolver, §3.5's warning-downgrade already covers the
   honesty; if not, a program using require-introduced names sees runtime doors.
4. **Static macro expansion + the binding-aware macro walker — DEFERRED (§3.4);** the
   ternary `macroAttribute` is the audited interim, with `"binder"` firewalled until the
   walker exists.
5. **Glass mode — no claims (§3.5).** The pass is a property of capability-composed sealed
   envs; glass callers hold a live frame and keep runtime doors only.
6. **Reachability/flow analysis — EXCLUDED.** `(if #f (missing-fn) 42)` runs today and will
   REPORT under this pass — strictness by design (dead references are drift), softened only
   by the impure-resolver downgrade. Flagged for V explicitly: this is the one place the
   pass is STRICTER than current runtime semantics, and the opt-out knob exists (§3.6).
   Rev 2 note: §3.5's soundness contract is phrased AROUND this exclusion — "no spurious
   unbound modulo EXCLUDED reachability" — so dead-branch reports are a documented design
   divergence, never counted as false positives; macro/binder/internal-define leaks are
   BUGS against the contract and are enumerated (and closed or gated) there.
7. **TS declaration-site spans — LIMIT (§1.3):** capability#name is the address, not
   file:line of the authoring `.ts`.

---

## 7. Implementation DAG

Territories are disjoint from the two in-flight siblings by construction: hermetic (CallCtx,
binder adapters), env-composition (Environment.ts, env-roots) — this design touches
`common/symbols/*`, `capability.ts`'s apply arms + spec fields, kernel door-minting, the new
`static-validation/`, and the pack files (W4 only).

**W0 — pins + door metadata. ✅ LANDED (commit 98641484b3, 2026-07-10).**
As shipped: `DoorCause {owner, needs: [{kind: "configuration", key, hint?}]}` additive on
`DoorSymbolDef` — the `dependency`/`resource` need-kinds EXPLICITLY DEFERRED (unrooted-
capability naming policy is an open design question, now §8 item 8; W0 stamps `needs: []`
everywhere) · `DoorProcedure` in the `ACallable` union (`values/primitives/ACallable.ts` —
`is_callable_value`/`z.lambda` stay sound), exposing `.door` · door bind arm routes through
`bindTarget(def)` like every other kind, stamping `cause = {owner: capabilityName, needs:
[]}` (the per-symbol loop's name-shadowing bug caught by the suite — owner would have been
the SYMBOL name) · `name @ owner` display discipline in PurityError throws from day one ·
~106 production doors pinned via `it.each` in the declared-doors law; cause-less bake pinned
byte-identical. Gates held: suite 3516/0; chibi conformance 651 EXACT; `tsc` build clean.

**W1 — the declaration kinds (fable-tier design review on the factory, then agent-tier).**
`symbol.define`/`symbol.defineSyntax` factories + `AEntity` arms + capability.ts apply arms
(evaluation order, `preludeOnly` routing) · bake-time: body parse memoization, span source
labels, `bodyHash`, contract wrapper (scheme face, `validate` knob), derived role via
Q7 classify + drift door on declared role, §2 FV law + eager-forward-ref check ·
`EnvCapability.exports` (with the interim prelude-parse arm). Gate: new unit suite + chibi
ledger untouched (no pack migrated yet) + Q6 law extended to define bodies.

**W2 — door-set degradation (needs W0; independent of W1).**
`lower()` absent-optional vs required vs invalid split (§3.7's three CHOSEN rows); kernel
mints cause-carrying doors; `assembleEnv` `degradation:` option with `"forbid"` as the
host-path default and program-scoped entry points opting into `"doors"`; `degraded` list on
the assembly result; loader capability adopts (coordinate with hermetic Phase B's loader
split — whichever lands second reconciles; the door posture supersedes its lower-time-door
posture per V's ruling, §3.7). **Rev 2 scope additions (§3.7):** inventory every
`assembleEnv`/`lower()` caller that branches on a throw; rewrite the loader tests pinning
the withhold posture (assertions on "Unbound variable" for loader-less `require` change to
the door's teaching throw, same commit as the posture); DiscoveryTool/LEARN door-marker
rendering for the discovery-surface change. Gate: loader suite + arrival-run e2e + the
caller inventory reviewed.

**W3 — the validator (needs W0+W1 vocab shapes; W2 for bucket b/c to fire).**
`static-validation/` — the §3.2 reference graph (Missing\* as nodes) + bucket queries +
`ProgramVocabulary` (assembled + roster ctors, macro-aware first sweep, KEYWORD_SYNTAX
baseline) · wire exec (`StaticValidationError`, `staticValidation` opt-out) · run-program ·
DiscoveryTool structured diagnostics · `macroAttribute` ternary audit on the macro
population · **internal-define scoping (§3.5's W3 prerequisite): body-sequence letrec\*
pre-pass, or the documented warning demotion until it lands.** Gate: validator unit corpus
(per bucket, per LIMIT — including the false-positive firewall cases: `cut`, quasiquote,
computed heads, impure-resolver downgrade, binder-macro formals (`receive`/`let-values`/
`and-let*`), internal-define sibling references, `define-macro`-name-then-use, `while`/
`try` heads on pure programs; plus the three prior-art laws as named cases:
one-cause-N-sites fusion, door-names-excluded-from-suggestions, error-tier-soundness) + DO
cost measurement (the §3.6 cache decision point) + custdev: manifold telemetry replay of
known agent errors through the validator, and the doored-symbol discovery rendering (§3.7).

**W4 — prelude death (needs W1; per-pack, parallel; TWO passes per pack, §4.2).**
19 define-pack decompositions (polyglot + srfi-1 as dedicated sessions; sonnet-tier for the
mechanical remainder of Pass 1; **Pass 2 contract authoring is judgment-tier — ~200 real
contracts, 3-5× Pass 1's time, per V's enforced-day-one ruling**) · `bootstrap` field + the
4 registration packs + harness · srfi-235 dep fix · delete `CapabilitySpec.prelude`,
prelude-eval branch, `collectPrelude` (last) · type-lens vocabulary re-pointed at
exports/declarations (coordinates WO-1: the harvest reads declarations — defines included —
instead of `rosettaTypesOf`). Gate per pack: chibi conformance 651 EXACT + package behavior
suites (semantic equivalence, NOT byte-identity — §4.2) + the srfi-1-family decode perf
budget + the infer/loader provenance regression gate (§4.5); final gate: monorepo build +
full `pnpm test` + grep-zero `spec.prelude`.

**Sequencing against the in-flight designs:** W0-W3 do not touch hermetic Phase A-C files
(CallCtx/binders) nor env-composition W1-W4 files (Environment.ts/env-roots) — parallel-safe.
Roster-mode fidelity (§3.2) IMPROVES as hermetic Phase B retires builder-form symbols but
does not wait for it. WO-2's defineRosetta migration gains `symbol.define` as the target for
scheme-expressible verbs (arrival-run's `run-program.ts:70` candidates). The env-composition
`Env.assemble` becomes the natural home of `degradation:` when it lands; until then the
option rides `assembleEnv`.

---

## 8. Decision list for V

1. ~~**Contract enforcement for scheme defines**~~ — **RULED (2026-07-10): enforced from
   day one, no shapeless migration default** (§1.2 rev 2, §4.2's two-pass W4).
2. **Provenance role: derived-only with declared-role drift door** (§1.4, now as the
   capability-set fixpoint) — confirm deriving beats declaring where the body is visible.
3. **Dead-reference strictness** (§6.6): `(if #f (missing) 42)` becomes a parse-phase error
   by default. Confirm, or demand `warning` for unbound-in-never-taken… (which needs the
   reachability analysis this design excludes — recommendation: confirm strict).
4. **Degradation defaults** (§3.7 rev 2): confirm the caller split — `"forbid"` default on
   host/provisioning paths, `"doors"` opted into by program-scoped entry points — and that
   doors-for-optional supersedes the hermetic loader-split's lower-time door.
5. **`bootstrap` residue field** (§4.3) vs pushing to fully-declarative extensions now.
6. **DiscoveryTool diagnostic surface** (§3.6): structured `(diagnostics …)` prepended
   output vs a separate MCP content block — pick at W3.
7. **Naming:** `symbol.define` / `symbol.defineSyntax` — or `symbol.scheme` /
   `symbol.schemeSyntax` to keep `define` free for a future program-level meaning.
8. **Unrooted-capability policy (rev 2, deferred out of W0):** how does a
   `{kind: "dependency"}` `DoorCause` need NAME a capability absent from the root set?
   C3 pulls deps as object edges, not string ids; an unrooted capability's own doors never
   bind at all, so there is no symbol to hang the cause on. Until ruled, the
   `dependency`/`resource` need-kinds stay out of `DoorCause` and §3.2's
   `MissingDepNode`/`MissingResourceNode` stay producer-less design shapes.
9. **`infer`'s no-op required schema (rev 2, surfaced by §0's flagship correction):**
   `z.custom<InferFn>()` with no predicate enforces nothing — absent config passes lower()
   and crashes as a raw TypeError at first call. Grow the predicate (making "required"
   real, fail-closed at lower) — recommendation: yes, independent of every wave here.
10. **Internal-define scoping option** (§3.5): W3 ships the body-sequence letrec\* pre-pass
    (i), or ships earlier with internal-define residuals demoted to `warning` (ii) —
    recommendation: (i), it is the same pre-pass shape the top-level sweep already has.


## V rulings (2026-07-10, decision quiz)

- **Contracts: ENFORCED FROM DAY ONE.** No shapeless default — every migrated define
  gets a real contract authored during W4 (~200 contracts across the census packs). W4
  grows accordingly (rev 2: priced as the two-pass structure, §4.2/§4.5); no ratchet debt,
  the strictness promise lands with the migration.
- **Sequencing: W0 now, critique round in parallel** (grok 3-model grounded audit runs
  against this doc while W0 lands; findings gate W1/W2, not W0). Both happened: W0 landed
  (98641484b3), the critique round produced rev 2.
- **Compiler lowering instructions: separate pack keyed by capability id, BUT the
  declared symbol CONTRACT is reused as the TYPE ORIGIN** — the instruction pack maps
  lowering shape only; emitted TS types derive from the declaration's zod contracts
  (one type source for runtime validation and compiler emission both; no parallel
  type vocabulary).

  **Rev 2 — the ruling's cost structure, made explicit (the ruling stands; these are its
  prerequisites):** schema-to-TS emission cannot cover arbitrary zod. Define the **HARVEST
  SUBSET** — the closed set of schema constructors with real, tested `schema-to-ts.ts`
  emission — and restrict `symbol.define` contracts to it. **`z.custom` is FORBIDDEN on
  define contracts** (it is exactly the constructor with no type-level content to emit —
  the same shape §0 caught failing as a validator on `infer`; on a define contract it would
  fail as a type origin too). Where the harvest subset cannot express a define's honest
  runtime check, the contract SPLITS, documented per-site: the runtime-validate schema
  (full zod, enforced at the boundary) and the emit-type annotation (the `type?:` override
  field §1.5 already carries, harvest-subset-only) may differ — a declared, visible split,
  never a silent widening. W4's Pass 2 authors within the subset by default and files each
  split as it authors it.
- Tracks greenlit: symbol.define W0→W4 + mercury W1+W2. Elk/reflect consumer waves
  and hermetic-symbols Phase A intentionally held.


---

## Rev 2 (critique round) — changelog

Rev 2 folds the 3-model grounded-audit verdicts (each verified against HEAD by ≥2 models or
accepted after code citation), 2026-07-10. Every touched file reference was re-verified
against HEAD during this revision. What changed:

**Soundness — the error tier's "zero false positives" contract was false four ways; §3.5
rephrased and each leak closed or gated:**
- The contract is now "no spurious `unbound-symbol` errors MODULO the EXCLUDED reachability
  strictness" (dead-branch reports are design, not FPs; macro/binder/scoping leaks are bugs).
- **(1) SPECIAL_FORMS/keyword syntax** (§2.1): `freeVars` walks `while`/`try`/`define-macro`
  as plain applications (verified: `free-vars.ts` models neither; `evaluator.ts:2777`'s
  table is module-private) — pure programs would report them unbound. Fix: core's
  `symbol.keyword` exports (`core.ts:49-68` — all 20 SPECIAL_FORMS entries, verified) are an
  unconditional vocabulary baseline (`KEYWORD_SYNTAX` in the §2.1 law; `{kind: "keyword"}`
  vocabulary entry in §3.2), never roster-optional.
- **(2) The macro attribute is TERNARY** (§3.4): `macroAttribute: "opaque" | "expression" |
  "binder"` replaces boolean `transparent`. Rev 1's own example list put binder macros
  (`receive` srfi-8.ts:16, `let-values` r7rs/binding.ts:76, `and-let*` srfi-2.ts:16 — all
  verified binder-shaped) on the transparent list, which walks their FORMALS as expressions
  → spurious unbound. Binder macros stay firewalled (opaque-equivalent) until a
  binding-aware macro walker exists. §1.1/§1.5/§3.2 shapes updated to match.
- **(3) Macro-aware name collection** (§3.2, §2.2): verified `defineNameOf` (slice.ts:180)
  and `extractDefines` (extract-defines.ts:92) match ONLY literal `define`. The validator's
  first sweep now collects `define`/`define-macro`/`define-syntax`; §2.2's interim exports
  arm is GATED on the same `macroAwareDefineNames` extension, with warning-tier degradation
  until it lands.
- **(4) Internal define sequences** (§3.5, new W3 prerequisite): `freeVars`' define arm
  binds a define's name for its own body only, not sibling body forms — R7RS §5.3.2
  letrec* internal-define scoping needs a body-sequence pre-pass (option i) or a warning
  demotion for internal-define residuals (option ii). W3 gate grows the corpus case; §8
  item 10.
- **Bake FV law macro policy** (§2.1): `cut`/`cute`'s `<>` placeholder (bound as a door in
  polyglot-stubs.ts:78, different capability) documented as the second live catch; the bake
  law reuses §3.4's `macroAttribute` firewall instead of a placeholder allowlist.

**Flagship case corrected (§0, §3.7, §5.1) — the loader at HEAD is WITHHOLD, not throw:**
verified `loader-capability.ts` (fs/loader `.optional()` at :154/:157; symbols added
`if (loader !== undefined)` at :242; header states "loader-less env has no `require` symbol
at all"). The story is now withhold→door, and the actual security-sensitive change is named:
required config (infer's non-optional key) must stay fail-closed — with the bonus finding
that `infer.ts:136`'s `z.custom<InferFn>()` is a silent no-op today (neither fail-closed nor
doored; raw TypeError at first call) — §8 item 9.

**Degradation posture (§3.7, new CHOSEN rows):** assembly-always-succeeds NARROWED to
absent-optional-input only (invalid config + pack apply errors stay throws); required
config stays fail-closed; `degradation: "forbid"` is the DEFAULT for host/provisioning
paths, program-scoped entry points opt into `"doors"`; `degraded` list enumerable on the
assembly; discovery-surface change (doors enumerable ⇒ present-but-doored ≠ absent) named.
W2 scope grows: assembleEnv/lower caller inventory, loader "Unbound variable" test
rewrites, DiscoveryTool door-marker rendering.

**Derived role (§1.4):** single-body classify was insufficient — bake classification is the
`classifyProgramPrelude`-style FIXPOINT (prelude.ts:137, both passes) over the capability's
whole define set; `reachesPort` (prelude.ts:89) is the single-node primitive only.

**Binding model (§2.3):** relabeled "letrec* NAME VISIBILITY for FV analysis; SEQUENTIAL RHS
evaluation (HEAD prelude semantics)"; two-phase bind order mandated (native/rosetta before
defines — today's apply-loop order preserved); bake allowlist stated
(SPECIAL_FORMS ∪ KEYWORD_SYNTAX ∪ exports ∪ resolver-synth family).

**Census (§4.1):** 23 packs, not 22 — `r7rs/exceptions` and `srfi-235` added (both verified
prelude-carrying at HEAD); census to be regenerated by script at wave boundaries; "8/22
lack comments" softened to the script-derived claim.

**W4 rewrite (§1.2, §4.2, §4.5, §7) per V's enforced-day-one ruling (the ruling stands; the
estimates changed):** all shapeless-migration-default language EXCLUDED (superseded by V
ruling 2026-07-10); W4 is TWO passes per pack (mechanical decomposition, then contract
authoring — ~200 contracts at 3-5× the mechanical time); the gate is SEMANTIC EQUIVALENCE
(behavior suites + chibi conformance 651 EXACT), never byte-identity; per-call decode perf
budget added for the hot recursive srfi-1 family; infer/loader packs get a provenance
regression gate.

**Contract-as-type-origin (V rulings §):** HARVEST SUBSET defined (define contracts
restricted to schemas with real schema-to-TS emission); `z.custom` FORBIDDEN on define
contracts; where harvest can't cover, runtime-validate schema and emit-type annotation may
split — documented per-site, never silent.

**W0 status (§0, §3.3b, §7):** LANDED, commit 98641484b3 — `DoorCause {owner, needs:
[{kind:"configuration",…}]}` additive; `dependency`/`resource` need-kinds EXPLICITLY
DEFERRED (unrooted-capability policy = §8 item 8); `DoorProcedure` in the `ACallable`
union; `bindTarget` routing; `name @ owner` display discipline; gates held (suite 3516/0,
conformance 651 EXACT, tsc clean).

**Minor / file-reference fixes:** `hashSteps` is file-private (CompiledResolutionChain.ts:158,
no export) — `bodyHash` duplicates the FNV-1a idiom per the codebase's own convention
(wireframe/hash.ts's "NOT imported from there") instead of importing; door minting split
stated correctly (factory in notImplemented.ts, cause-stamping in capability.ts's bind arm,
types only in _bake.ts); `classifyProgramPrelude` vs `reachesPort` prose de-lumped (§0,
§1.4); "3046" corrected everywhere — chibi conformance is 651 EXACT, 3046 was the old
full-suite count (now 3516 post-W0); `exec(src, {typecheck})` labeled design-target-not-
landed (verified absent from ExecOptions); stale line refs refreshed post-W0
(parseNameDoc _bake.ts:476; collectPrelude capability.ts:155; prelude-eval branch :426-435;
door bind arm :366-386). One verdict item NOT folded as stated: "reachesPort is
prelude.ts:88" — HEAD has the export at prelude.ts:89 (verified this revision); the doc
keeps :89.

**Decision list:** item 1 marked RULED; items 8 (unrooted-capability policy), 9 (infer's
no-op required schema), 10 (internal-define scoping option) added.


## W4 horde plan (V-requested, 2026-07-10 morning)

Parallelism unit = the pack FILE (23 disjoint territories; shared machinery landed,
consume-only; per-pack law files → zero collisions). One Sonnet agent per pack, both
passes in one run (mechanical decomposition → contract authoring, enforced day one).
Waves: **H1** small packs (r7rs singles + srfi-2/8/26/235 — 235 adds its declared
compose dep, the FV law forces it) · **H2** mid packs + the 4 ext packs (bootstrap
field for the 5 register-extension calls) · **H3** polyglot + srfi-1 solo (perf budget:
the documented hot-path valve where decode cost is measured, never silent) · **H4
(Fable)** contract-review over all ~200 authored contracts + staticValidation default
flip + the 14 pinned-suite updates + scripted census regen. Per-agent gates: suite 0
failed · conformance 651 EXACT · build 0 · semantic-equivalence. Main thread harvests
per wave, commits with pathspecs.


## W4-H4 (closing wave) — ledger (2026-07-10)

**Contract review — verdict (all ~192 `symbol.define` contracts + the `defineSyntax`
macroAttributes across every migrated pack, incl. llm-plane's mcp-declare/infer).** Five
genuine regressions found and FIXED; the large "over-tight" candidate class adjudicated SOUND.

- **The native-kind asymmetry, stated (the srfi-28 agent's flag, confirmed and now doctrine):**
  a `symbol.native` NEVER runtime-validates its contract — `native.ts`'s bind is "zod for
  TYPES purely" (the schemas ride the def for TS inference + the harvest; the impl works on
  scheme values directly, no `z.decode`). A `symbol.define` procedure DOES — `define-bake.ts`'s
  `buildDefineProcedure` wraps the closure so every call runs `z.decode(def.in, args)` +
  `z.decode(def.out, resultVector)` (throw-on-mismatch, discarded value; `validate:false` skips).
  CONSEQUENCE: an over-tight contract is a runtime REGRESSION only on a `define`; on a `native`
  it is a type-only imprecision. Audit priority followed this — `define` contracts first. No pack
  author was found assuming native enforcement they don't get (the native contracts reviewed are
  type-shaped, not relied on as runtime gates; `map`/`filter`/`reduce` pass-through positions
  are correctly typed `z.value` precisely BECAUSE the downstream sequence/tagless kinds never
  decode-check `fn`).
- **FIXED — the `Values`-orphan output gap (the class srfi-1 already closed for span/break/
  partition via `z.values`, not backported):** `r7rs/exceptions.ts` `with-exception-handler`
  (`output [z.value]` → `[z.union([z.value, z.values])]`) and `raise-continuable`
  (`[raisable]` → `[z.union([z.value, z.error, z.values])]`; INPUT `raisable` unchanged — you
  cannot *raise* multiple values); `srfi-235.ts` `curry` (`[z.value]` →
  `[z.union([z.value, z.values])]`). All three LIVE-VERIFIED: a spec-legal multi-value
  thunk/handler/curried-fn threw at the output-decode boundary before the fix, returns after.
  These are true regressions — the pre-migration prelude bodies accepted and returned the
  `Values` box; only the new contract wrapper rejected it.
- **FIXED — `srfi-128.ts` `make-comparator` ordering slot** (`z.lambda` →
  `z.union([z.lambda, z.booleanFalse])`): SRFI-128 explicitly permits `ordering = #f`, and the
  body only STORES ordering (never calls it), so `(make-comparator t eq #f)` bound fine in the
  prelude era; the bare `z.lambda` regressed it to a throw. LIVE-VERIFIED.
- **FIXED (precision, not a regression) — `polyglot-clojure.ts` `empty?`** (`z.value` →
  `z.boolean`): the `z.value` carve-out cited `=`'s verdict as "a raw JS boolean" `z.boolean`
  would reject — a premise gone STALE at the R8 `mintVerdict` unification. LIVE-VERIFIED false:
  `(= 0 0)` and every `=`-arm of `empty?` return a boxed `ABool`. This is the one §1.2(b)
  z.value-LAZINESS the audit found; the stale comment is corrected in place. Matches the sibling
  `dict-has-key?`, already `z.boolean`.
- **SOUND carve-outs, documented (NOT regressions, deliberately NOT changed):** the large class
  of srfi-1/43/128/189 "SRFI says variadic/optional-arg, contract is a fixed vector" candidates
  (`fold-right`, `delete`, `delete-duplicates`, `vector-fold`/-`fold-right`/-`count`/-`index`/
  -`any`/-`every`, `just`/`left`/`right`, `maybe-ref/default`, `maybe-bind`, `maybe->either`,
  `either-ref/default`, `either-bind`, …) are the contract faithfully matching arrival's ACTUAL
  implementation arity: every one has a FIXED-ARITY body (`fold-right` = `(lambda (f knil xs) …)`,
  `just` = `(lambda (x) …)`, `make-comparator` arity-3, …), so the multi-list / optional-arg /
  variadic-payload call threw an arity error in the prelude era too — the contract is
  semantic-equivalence-preserving, not a regression. Widening these WITHOUT reworking the bodies
  would admit args the body then drops or arity-errors on — strictly worse than a clear
  contract-arity error. SRFI-full variadic behavior is a PRE-EXISTING feature gap, correctly
  outside W4's port-behavior mandate (a follow-up feature wave, not a migration fix). The
  `z.value` carve-outs across schema.ts (17/17), infer.ts (3/3), polyglot (40/41), and the srfi
  families were each verified genuinely any-value-justified; `z.custom` appears only on
  capability *configuration* schemas (infer's `InferFn`, mcp's `OnMcp`), never on a `define`
  contract, so the §1.2 `z.custom`-forbidden-on-define rule holds with zero violations. All
  threading macros (`->`/`->>`/`~>`/`~>>`) correctly carry `macroAttribute: "expression"`; no
  binder-shaped macro is mis-attributed.

**The default flip — RULED: staticValidation stays OPT-IN; NO global default flip.** The spec
staged the `exec` default OFF pending W4; W4 is done, so the flip was re-adjudicated against
HEAD — and REJECTED as the wrong lever. Empirically (measured W4-H4): flipping the `exec`
primitive's default to on breaks **313 assertions across 14 suites** — and those suites are the
door/purity/typo/tail-call/bracket LAW suites plus `overridable`, several encoding DELIBERATE
runtime invariants (a door RESOLVES at lookup and fires at APPLY; an unbound typo throws the
runtime "did you mean" at eval), not stale default-pins. The cause is that `exec` is the
low-level PRIMITIVE the law suites and internal provisioning evals use to exercise RUNTIME
behavior; a global flip conflates it with the program-scoped production ENTRY points. §3.7's
caller split is the actual posture and it is UNCHANGED: strictness is CALLER-scoped —
DiscoveryTool.call and runProgram opt IN by passing `staticValidation: "on"` (the "doors as the
real production entry" line), which is their remaining W3 wiring, NOT a flip of the primitive.
`generator-exec.ts`'s ExecOptions doc updated from "STAGED — flips with W4" to "RESOLVED —
opt-in is the posture." The 14 pinned suites were therefore NOT rewritten — they correctly pin
the runtime surface the opt-in posture preserves. FOLLOW-UP (W3 wiring, out of W4-H4): (a) wire
DiscoveryTool.call + runProgram to pass `"on"`; (b) a parse-phase FALSE-POSITIVE surfaced under
the blast-radius probe — a bare `=>` reference (`cond`/`case` auxiliary keyword, present-as-door
in arrival) reports `unbound-symbol` at parse; the §2.1 KEYWORD_SYNTAX baseline must cover the
auxiliary-keyword / present-but-doored surface before the production entry points enable the pass,
else present-but-doored symbols read as unbound.

**Residuals — dispositions.**
- **`core`'s `single` (always-`#f`, LIPS heritage, zero call sites):** DELETED — V ruled
  2026-07-10 ("we need to stay aligned to srfi where we can"): `single` is in no SRFI or
  R7RS, so neither preserving nor fixing it serves alignment; a silently-always-`#f` public
  predicate is a teaching-error trap. Removed from `scheme/core` along with the pack's only
  dep (`equality`, needed solely by its body) — the pack is dep-free again. The live-catch
  DefineLocalityError regression pin survives as a local reproduction in
  `core-symbol-define-migration.test.ts`.
- **`promise?` (chibi-EXCLUDED under §4.2.5, was a plain unbound name, no door):** FIXED — added
  as a `notImplemented` door in `r7rs/control.ts` alongside delay/force/make-promise/delay-force,
  completing the §4.2.5 family (with every promise constructor doored, no promise value can exist
  for the predicate to recognize). The pack's migration test now pins TEN omissions (registries
  exclusion already covered `promise?`, so ROW 6 stayed green).
- **`superdefine` (arrival-run — the last unmigrated one-macro prelude):** MIGRATED — the
  `run/continue-after-approval` `define-macro` → `symbol.defineSyntax`, `macroAttribute:
  "expression"` (both formals are expression positions; the introduced `(lambda () …)` thunk
  binds nothing), matching the `overridable` precedent. `prelude` field removed. Type-clean;
  arrival-run's pre-existing legacy reds (in the unchanged `approval/await` rosetta + `data.ts`
  + `run-program.ts`) travel with those files and are untouched. NOTE: the macro has zero test
  coverage / zero call sites — a follow-up should add a smoke test.
- **`resource-caps.law` timing flake:** NOTED, not fixed — a wall-clock/machine-load
  sensitivity, not a logic fault; it did not fire in the W4-H4 gate runs. Left for a
  fake-timer / budget-widening pass if it recurs in CI.

**W4 completion audit (§4 CHOSEN rows + §3.5 soundness).** Every §4 CHOSEN row landed: all
define/macro preludes decomposed (census DONE, §4.1); `bootstrap` residue narrowed to the 5
registration calls (the field rename itself DEFERRED, §4.3). The §3.5 soundness contract holds
against the now-live expression-attributed macros — polyglot's `->`/`->>` (the first shipped
`macroAttribute: "expression"`) walk their argument forms as ordinary expressions, which is
sound (their formals are expression space, no binding positions), verified by the door/law
suites staying green under the opt-in posture. The one open soundness item is the `=>`
auxiliary-keyword false-positive above — a KEYWORD_SYNTAX-baseline gap that only manifests when
the pass runs, i.e. a prerequisite for the production-entry wiring, not a W4-H4 blocker.
