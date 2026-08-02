# Sugarcoat bound-name recovery — the `it` pronoun + the recovery ladder, flipped onto `lexical-namer`

*2026-06-15. Working proposal. Spec → critique → resolved design → CodeMirror grammar.*

## 0. The problem, concretely

Auto-generated sweet (from sift) reads like this today:

```
evidence.filter{(e) => e[:family] == family}
  .map{(e) => e[:family]}
audit findings {(f) => f[:verdict].canonical-verdict.string-length > 0}
```

Every trailing lambda surfaces its bound parameter explicitly — `{(e) => …}`, `{(f) => …}` —
even though the renderer already *can* collapse a single-parameter lambda to the anaphoric
pronoun `{ it … }`. It collapses **only when the stored parameter is literally named `it`**
(`renderTrailingLambda`: `names[0] === "it"`). The generator emitted `e`/`f`, so the pronoun
never fires. We want:

```
evidence.filter{ it[:family] == family }
  .map{ it[:family] }
audit findings { it[:verdict].canonical-verdict.string-length > 0 }
```

…and, where the element is used *bare* (passed opaquely, not via a key), a meaningful name
derived from the collection instead of `it`:

```
items.map{ (item) => process(item) }          # not `it` — `item` reads at the bare use site
findings.fold(seed){ (acc finding) => … }      # reduce role-words
```

## 1. The law that licenses this (why it is *not* a guesser)

The tight-bracket fix ([[reference-sweet-tight-bracket-roundtrip]]) banned heuristics in the
**brace slot** because that slot carries meaning — a brace is either the lambda or a sibling
operand, and guessing wrong is *incorrect*. The distinguishing bit (`tight`) had to be carried
structurally.

The **bound-name slot is the opposite kind of slot.** A lambda's parameter name is
*semantically void*: `(lambda (e) (:family e))` and `(lambda (it) (:family it))` are the **same
platonic lambda** — they are α-equivalent. Bound names carry no entropy
([[reference-bifunctor-iso-compute-bound-value]]: only data/intent and stable isos carry
durable value; a bound name is neither). So a *naming heuristic is allowed here* — every output
it can produce is α-equivalent to the input. Wrong is merely **ugly, never incorrect**.

> **The recovery is a capture-avoiding α-renaming that picks the most readable member of the
> α-equivalence class.** "Most readable" is a ladder; "capture-avoiding" is exactly what
> `lexical-namer` already computes.

This is the same shape as every other win in the genealogy: store the intent (the platonic
lambda), derive the materialization (a readable name) on demand.

### 1.1 What "capture-avoiding" must guarantee (the only correctness obligations)

α-renaming `(lambda (e) B)` → `(lambda (n) B[e:=n])` preserves semantics **iff**:

1. **No free-variable capture.** `n` must not be a variable that occurs *free* in `B`.
   Renaming `e`→`family` inside `…== family` would capture the outer `family`. ❌
2. **No shadow of an inner reference.** If `B` contains an inner binder that an occurrence of
   `e` refers *through*, `n` must not collide with that inner binder. (For single-param element
   lambdas this is rare, but nested `it` is the live case — see §3.)

Both obligations are **precisely** the lexical-namer's contract:
*a descendant cannot reuse an ancestor's claimed name; reservations block free names.*
Feed it the right scope tree and reservation set and capture-avoidance falls out — we never
hand-code a nesting guard.

## 2. The ladder (the "most readable" order)

Per single-parameter element lambda, in priority-descending order:

| rung | candidate | fires when | renders as |
|---:|---|---|---|
| 100 | `it` | every use of the param in the body is **keyed** (`(:k p)`, `(c[ad]+r p)`, `(@ p k)`) — never bare | `{ it[:k] … }` (implicit) |
| 80 | `singular(collection)` | the param is used **bare** somewhere (fan-out) AND the enclosing call is a recognised element-wise HOF whose collection name is known | `{ (finding) => … }` (explicit) |
| 60 | role-word | the enclosing call is a recognised **reduce** HOF (`acc` for the accumulator), or other known role | `{ (acc finding) => … }` |
| 40 | `original` | always available — the parameter name the author/generator wrote | `{ (e) => … }` |

Rung 40 is the **guaranteed-unique string fallback** the resolver requires. The ladder is
*content-derived*, not taste: the keyed-vs-bare cut is a fact about the body (does the element
escape opaquely or is it always projected?), and singular/role-words are spec-of-the-HOF facts,
not product editorialising.

**The keyed-vs-bare discriminator** is the one subtle judgement, and it is principled:
`it` is self-documenting *only at a keyed use site* (`it[:family]` says what it is); at a bare
use site (`(process it)`) `it` says nothing, so a noun reads better. "All consumptions keyed →
`it`" is the user's stated rule and it is exactly when the pronoun loses no information.

### 2.1 Worked, against the demo

- `(lambda (e) (equal? (:family e) family))` — `e` only in `(:family e)` → **all-keyed → `it`**.
  `family` is a *free var* → reserved → never chosen. → `{ it[:family] == family }`. ✓
- `(lambda (e) (:family e))` — all-keyed → `it`. → `{ it[:family] }`. ✓
- `(lambda (f) (> (string-length (canonical-verdict (:verdict f))) 0))` — `f` only in
  `(:verdict f)` → all-keyed → `it`. (`audit` need not be a known HOF; `it` needs no
  collection.) → `{ it[:verdict].canonical-verdict.string-length > 0 }`. ✓
- `(map (lambda (x) (process x)) items)` — `x` appears **bare** in `(process x)` → fan-out;
  `map` is element-wise, collection `items` → `singular(items)` = `item`. →
  `items.map{ (item) => process(item) }`. ✓

## 3. The reuse — flip `lexical-namer`, inherit the shadowing for free

`scheme-scope.ts` already drives `resolveLexicalNames` for the **forward** Mercury namer
(scheme → JS identifiers): scope tree from binder nesting, `nameCandidates` ladder per binding,
`onTie: "free"`. We **mirror its structure and flip the ladder**:

- forward: rank `cleanName` top, pronoun never.
- recovery: rank `it` top, `original` as the collision-fallback.

The strategy is **new** (sweet vocabulary — `it`, singular nouns, reduce role-words — is not the
JS vocabulary in `names.ts`; per the project's split rule we write our own, we do not reuse
`names.ts`). The **resolver is reused verbatim.**

**The gem — anaphora *is* lexical scope.** Feed lambda nesting as the scope tree. Two nested
all-keyed lambdas both bid `it` at rung 100. The resolver's rule *"a descendant cannot reuse an
ancestor's claimed name"* makes the outer claim `it` and forces the inner to **descend to rung
80/40** — which is exactly anaphoric shadowing: an inner `it` would rebind the pronoun and
silently steal the outer element. The nesting guard is not written; it is the resolver's
defining semantics. Sibling lambdas are independent scopes, so each freely reuses `it`. This is
why the reuse is not a coincidence — *the pronoun's scoping and the resolver's scoping are the
same partial order.*

Mapping:

| recovery concept | `lexical-namer` slot |
|---|---|
| lambda parameter (renameable) | `ScopedEntity` with `candidates` ladder |
| lambda / let nesting | `ScopeSpec.children` |
| free vars referenced in a body | `ScopeSpec.reservations` (block capture) |
| `it` cannot nest | descendant-can't-reuse-ancestor (built-in) |
| sibling lambdas reuse `it` | sibling-scope independence (built-in) |
| keyed-vs-bare weight | which rungs the strategy emits (future: `usageCount` cost-weight) |

## 4. Delivery — two modes, one mechanism

The mechanism is one function: `Scheme → (name assignment) → α-renamed Scheme`. Where the
renamed scheme *goes* is the policy choice, and it is governed by the membrane discipline
(**do not silently mutate author-chosen names on display** — that is a membrane leak).

- **(A) Committed normalize pass — `tidyBoundNames(scheme): scheme`.** A deliberate, explicit
  rewrite of the core (like prettier): the stored `(lambda (e) …)` *becomes* `(lambda (it) …)`.
  Then the **existing renderer needs zero change** — it already collapses a literal `it`, and
  renders a recovered `finding` as `{(finding) => …}`. The user "sees `it` in the transform"
  because the core now contains `it`. Honest: the rename is visible and committed, not a
  display-time illusion. **Right home: the generation pipeline (normalize machine output before
  store) and an explicit "tidy" command.** This is the recommended primary.

- **(B) Glass inlay hints — `boundNameHints(scheme): {pos,name}[]`.** The source keeps
  `(lambda (e) …)`; the *view* shows `it`/`finding` as an inlay, never written. Mirrors
  `param-hints.ts` exactly. **Right home: read-only viewing of foreign / not-yet-owned code**,
  where committing a rename would be the leak.

The lens laws differ per mode, and this is the crux:

- Mode A keeps the renderer's law **syntactic** (`render(read(c)) ≡ c` on the canonical
  sublanguage), because the rename happens *before* render in the core, once.
- Mode B never touches the core, so the core round-trips **syntactically**; the *hint overlay*
  is the α-equivalent view.

**We must NOT make `render` itself fold bound names** — that would weaken the renderer's own
cyclic-idempotence from `≡` to `≡_α` and silently rename every lambda parameter on a no-op
open-and-save. That is the leak. Recovery is `tidyBoundNames` (explicit) or a hint (non-writing),
never a render-time mutation.

## 5. PEG/EBNF — the CodeMirror-facing trailing-lambda binding surface

CodeMirror needs the **binding structure** of the trailing lambda to (a) highlight binder vs
reference, (b) place the §4-B inlay hints, (c) scope-fold, and (d) drive rename. This grammar
annotates the surface the method-dot spec already parses; it is the *read* side (what the editor
sees), distinct from the *recovery ladder* (the render side).

```peg
# ---- trailing lambda (the brace that binds the element) ----
# TIGHT = adjacent to the preceding `.op` / `(args)`, no intervening whitespace
# (the soundness bit from the method-dot spec; a SPACED brace is a sibling operand).

TrailingLambda  <- Pronoun / Arrow

Pronoun         <- TIGHT '{' WS Body WS '}'                      # binds `it` over Body
Arrow           <- TIGHT '{' WS '(' WS Params WS ')' WS '=>' WS Body WS '}'
Params          <- Param (WS1 Param)* (WS1 '.' WS1 Param)?       # rest tail optional
Param           <- Identifier                                    # *** binding occurrence ***

Body            <- Expr                                          # `it` / each Param are
                                                                 # *references* resolved here

# ---- the anaphor ----
ItRef           <- 'it' !IdentCont                               # *** reference to the nearest
                                                                 # enclosing Pronoun ***

# ---- scoping rule (not expressible in pure PEG; the editor's name resolver enforces) ----
#   • A Pronoun introduces the binder `it`, scoped to its Body.
#   • An ItRef resolves to the *innermost* enclosing Pronoun.
#   • A Pronoun nested inside another Pronoun's Body SHADOWS it — so a well-formed
#     recovered surface never nests two Pronouns (the recovery ladder descends the
#     inner one to an Arrow). The editor MAY flag a hand-written nested `it` as a
#     shadow warning; it is legal scheme but ambiguous to a reader.
#   • Each Param of an Arrow binds over the Arrow's Body; sibling lambdas are
#     independent scopes (the same name may bind in two disjoint braces).

WS              <- [ \t\n\r]*
WS1             <- [ \t\n\r]+
IdentCont       <- [A-Za-z0-9!$%&*/:<=>?^_~.+-]
Identifier      <- IdentStart IdentCont*
IdentStart      <- [A-Za-z!$%&*/:<=>?^_~]
```

Two facts make this grammar enough for CodeMirror:

1. **`Pronoun` vs `Arrow` is a context-free distinction** (presence of the `( … ) =>` head),
   so a Lezer/PEG grammar tags binders without semantic analysis.
2. **`it` resolution is a one-line lexical walk** (nearest enclosing `Pronoun`), identical to
   how `param-hints.ts` already walks. The editor's name-resolver reuses the *same scope tree*
   the recovery pass builds — one scope model, three consumers (recovery, hints, highlight).

## 6. Critique (adversarial — the problems before the fixes)

**C1 — `tidyBoundNames` on a hand-authored buffer is still a leak.**
Mode A is "explicit," but if a careless caller runs it on every save it silently renames the
author's `e` to `it`. *Fix:* `tidyBoundNames` is never wired to auto-save; it is the generator's
pre-store step and an explicit command only. The default editor path is **render-unchanged +
mode-B hints**. Documented as a hard rule, not a convention.

**C2 — singular needs the collection, which the lambda node does not carry.**
`(lambda (e) …)` in isolation has no `findings`. The collection is the HOF call's last argument.
*Fix:* recovery walks **calls**, not lambdas-in-isolation: at a recognised element-wise HOF
`(map Λ … coll)` it threads `coll`'s name into Λ's ladder. A lambda not in a recognised HOF call
simply has no rung-80 (falls to `it` if keyed, else `original`). No model field added — the
collection is read from the call shape at analysis time.

**C3 — singularising an unknown / mass noun.**
`singular("evidence")` = "evidence"; `singular("data")` = "datum" (wrong-ish); a non-noun head
like `xs` → "x". *Fix:* singular is **injectable** (`opts.singularize`), defaulting to a tiny
rule-based built-in; studio/codemirror inject `pluralize` (which they already depend on). And
the rung is *advisory*: if `singular(coll)` collides or reads worse, the resolver still has rung
40 (`original`) as the guaranteed fallback. A bad singular is ugly, never incorrect (§1).

**C4 — the zero-dependency-leaf invariant.**
`arrival-sugarcoat` is a *zero-dependency leaf consumed by codemirror*; the recovery needs
`lexical-namer`. Listing it as a dep and pulling it into codemirror's bundle would violate the
invariant the package exists to hold. *Fix:* expose recovery as a **subpath** export
`@inhuman.tools/arrival-sugarcoat/names`, add `"sideEffects": false`. A consumer importing `.`
tree-shakes `names.ts` and its `lexical-namer` import away entirely; only a consumer that
explicitly imports `/names` pays. `lexical-namer` is a *workspace* dep with zero external deps,
so the install-graph cost is one in-repo package, not a third-party tree. (This is the
env-quasi-package subpath discipline: isolate the dependency behind a subpath, don't fork a
package.)

**C5 — keyed-vs-bare is a body analysis; what counts as "keyed"?**
Define it precisely or it drifts. *Fix:* a use of param `p` is **keyed** iff its parent form is
an accessor application with `p` in the receiver slot: `(:k p)`, `(c[ad]+r p)`, `(@ p k)`. Any
other occurrence of `p` (head position, non-receiver arg, bare value) is **bare**. `p` not
occurring at all → vacuously all-keyed → `it` (a dropped param; harmless). This is a structural
predicate over the body, computed once.

**C6 — collapsing to `it` when the body is an arrow-shaped datum.**
The renderer already guards this (`!isArrowLambda(body)`): a single-param lambda whose body
*is* a `(lambda …)` must not collapse, or the pronoun wrapper is lost on re-read. *Fix:* the
recovery's rung-100 emits the *name* `it`; the renderer's existing arrow-body guard still
decides implicit-vs-explicit. Recovery and render stay orthogonal — recovery picks the name,
render picks the surface. No new interaction.

**C7 — free-variable capture across the whole forest.**
Reserving only a body's *immediate* free vars misses a free `it`/`finding` introduced two scopes
out. *Fix:* reservations are the **global set of identifiers that resolve to a non-renameable
binding** (top-level defines, stdlib, free refs) — an over-approximation that is always safe
(it can only *forbid* a recovered name, never permit a capture). Computed by the same forest
walk that maps references to binders.

**C8 — `it` shadowing a user binding actually named `it`.**
If the program already binds `it` (a real variable), recovery must not collapse a *different*
lambda's param to `it` in a scope where the user's `it` is visible. *Fix:* the user's `it`
binding is in the reservation/claim set for inner scopes (it is a binder we *don't* rename, or
one we do — either way it occupies the scope), so the resolver blocks a second `it` there.
Built-in. (And we never rename a param *to* `it` if the body references a free `it` — C7.)

## 7. Resolved design (post-critique)

```
@inhuman.tools/arrival-sugarcoat/names           (NEW subpath; deps: lexical-namer [workspace], parser from ./sugarcoat-render)

  tidyBoundNames(scheme: string, opts?): string        // mode A — explicit core rewrite
  boundNameHints(scheme: string, opts?): {pos,name}[]  // mode B — glass overlay (mirrors param-hints)

  opts:
    singularize?: (word: string) => string   // default: tiny rule-based; inject `pluralize` for quality
    reserved?:    readonly string[]           // extra names to block (caller globals)

  internal:
    buildScopeTree(forest)  → ScopeSpec<Atom>   // lambda/let nesting; params = entities; free vars = reservations
    ladderFor(param, ctx)   → Record<prio,Candidate>  // §2 ladder, content-derived
    classifyUse(param,body) → "all-keyed" | "fan-out"  // §C5 predicate
    hofContext(callNode)    → {collection?, kind:"element"|"reduce"|none}  // §C2

  arrival-sugarcoat/package.json:  + "sideEffects": false,  + "./names" export,  + dep lexical-namer
```

Render, read, and the default `.` entry are **untouched**. The demo renders correctly after a
single `tidyBoundNames` at generation time, with no renderer edit. CodeMirror consumes the §5
grammar (binder/reference tagging) and `boundNameHints` (mode-B overlay) — the same scope tree,
three ways.

## 8. Status

- [x] §7 `names.ts` — strategy + `tidyBoundNames` (mode A). Built; the resolver is reused verbatim, only the sweet vocabulary (`it`, singular nouns) is new.
- [x] `boundNameHints` (mode B) — built alongside mode A (both ride the one `analyze` pass; cheap to ship together).
- [x] package.json subpath `./names` + `sideEffects:false` + `@here.build/lexical-namer` dep.
- [x] `__tests__/names.test.ts` — 22 cases: ladder (it / singular / original), nested shadowing, sibling reuse, capture avoidance, C8 no-op, the `it` render collapse, idempotence, mode-B hints. Full suite 157 green, typecheck clean.
- [ ] CodeMirror: Lezer rule from §5 + hint provider — downstream, separate ticket.

### Bug found while wiring (capture-avoidance reservation)

The per-scope reservation was `freeVars(body)` — but a param reads as *free* in its own body
subtree (its binder, the lambda, is one level up), so the scope reserved the very name it was
trying to assign. Effect: the rung-40 *original* fallback was blocked, producing spurious
numeric suffixes (`(call/cc (lambda (k) (k 1)))` → `k2`; an author's own `it` → `it2`). This
is the [[reference-bifunctor-iso-compute-bound-value]] discipline in miniature — the round-trip
("keep the original when nothing better wins") was failing, and the fix was not a guard but
carrying the distinguishing fact *structurally*: subtract the bound param from its own body's
free-var set (`reserved.delete(param.atom)`). All other free vars stay genuine capture hazards.
