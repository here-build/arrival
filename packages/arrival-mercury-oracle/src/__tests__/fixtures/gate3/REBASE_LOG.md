# Gate-3 goldens — rebase log

## goldenEpoch 6 — naming-leverage lane: destructure dissolves into `@here.build/lexical-namer`'s Shape API (2026-07-17)

**One gate-3 golden changed — `apply-plus.golden.ts`**, the exact punch-list
target this landing's item 4 names:
```diff
  function OracleMain() {
-     return [1, 2, 3].reduce((__acc, __item) => __acc + __item, 0);
+     return [1, 2, 3].reduce((total, __item) => total + __item, 0);
  }
```
The accumulator now reads `total` — `naming/census.ts`'s new `foldRoleNames`
structurally recognizes the `(apply + xs)` fold shape `applyEmitRule`
(arrival-core, `foundations/arrival/arrival/src/env/r7rs/lists.ts`, never
touched this wave) already emits — `Method(recv, "reduce", [Arrow([acc,
item], Bin(op, Ref(acc), Ref(item))), identity])` — and offers a NAMING
candidate keyed off the operator (`+` → "total", `*` → "product"), purely a
census READ, zero coupling to arrival-core. `xs`'s literal-array receiver
(`[1, 2, 3]`) has no derivable collection name (`elementNameOf` declines a
bare `ArrayLit`), so the item stays the honest generic `__item` — "when
singularization is a no-op, fall to generic, never force a bad name" applied
literally.

**The wider naming-lane wiring this golden is one instance of** (engine plan
naming-leverage lane, `src/naming/{census,allocate,materialize,types}.ts`;
`@here.build/lexical-namer` and `pluralize` are both pre-existing deps, wired
not built):

1. **`site.destructure` dissolves into the namer's `shapes` API.** Every
   destructure-eligible site (positional car/cdr OR the new dict-field shape)
   is now a RICH entity — `allocate.ts`'s `destructureShapes` builds a T100
   "destructure" shape (bindings = the slots/fields, guaranteed-fit via a
   50-deep `_2.._50` fallback tail, `shapeLadder`) alongside a T80 "bare"
   shape (the site's ordinary ladder) — mirroring `@here.build/lexical-namer`'s
   own `examples-destructure.test.ts` D1/D7 pattern exactly. A genuine gain
   over the old hand-rolled SlotKey path: the resolver's all-or-nothing
   selection now has a real escape hatch to bare on exhaustion (pinned by a
   dedicated `naming.test.ts` row reserving all 50 fallback rungs) — the old
   design had none once census decided "destructure."
2. **Dict-field destructure (new capability)** — a param used ONLY via
   literal-string-keyed `Index` access (`x["scores"]`, arrival's
   keyword-accessor lowering) destructures to `({ scores }) => …` /
   `const { scores } = x`. `census.ts`'s `analyzeFieldParam` is the
   positional analysis's twin (all-or-nothing, "stray" on any other use),
   syntactic only (reads the literal key off the `Lit` node — no type-lens
   coupling). Required one small residual-algebra addition:
   `residual/types.ts` grew `ObjectPattern`/`ObjectPatternProperty` (Pattern
   was `Binding | ArrayPattern | RestBinding`; the file's own "no
   ObjectPattern — arrival has no destructuring-at-declaration-site source
   form" comment is now corrected — this is a NAMING-PHASE mint, never a
   user source form) with renderer support in `residual/render.ts`
   (shorthand `{ key }` iff the field key and allocated name are
   byte-identical, else the alias form `{ "key": local }`).
3. **The singularize gate broadens beyond `.map`** (`SINGULARIZE_METHODS` —
   `map`/`filter`/`forEach`/`some`/`every`) — `.filter`'s Law-T truthiness-
   guard wrapper is the other REAL site any registered emit rule constructs
   today (`filterEmitRule`, arrival-core's `srfi-1.ts`); `forEach`/`some`/
   `every` are forward-compat (r7rs `for-each`/`any`/`every` currently lower
   to runtime-shim CALLS, not native methods) — unreached in practice,
   covered by direct `naming.test.ts` unit rows instead of a corpus fixture.
4. **The fold-role gate** (`foldRoleNames`, above).

**A regression caught and fixed DURING this landing, not after** — broadening
the singularize gate to `.filter` naively let a Law-T guard wrapper's fresh
param steal a name from the REAL predicate parameter one scope down:
`recs.filter(__x => (rec => zeroP(recScore(rec)))(__x) !== false)` would have
become `recs.filter(rec => (rec_2 => …)(rec) !== false)` — the anonymous
engine-glue wrapper claims "rec" (singularized from `recs`) BEFORE the real,
user-authored `rec` parameter (one scope down) ever gets to compete for it,
since parent scopes resolve before children. Fixed by `isLawTGuardWrapper` —
a structurally EXACT match on the guard's three-node signature
(`Bin("!==", Call(pred, [Ref(param)]), Lit(false))` as the WHOLE arrow body,
not a generic "forwarded to a nested Arrow anywhere" search, which would have
ALSO wrongly caught `mapEmitRule`'s legitimate multi-list zip shape
(`Arrow([el, idx], Call(userFn, [Ref(el), ...rest]))` — no `!== false`
wrapper — where `el` genuinely IS the element and must keep singularizing).
Both directions are pinned in `naming.test.ts` (the guard-declines row and
its "control: a DIRECT zip invocation... still singularizes" sibling) and
verified against the real `inhuman-gepa-full`/`ai-winter-ebl-investigation`
fixtures below (`failuresOf`, byte-identical; `privileged`, destructures
correctly).

**A second gap found and fixed the same way — sibling rich-entity
declaration order.** `@here.build/lexical-namer` resolves rich (Shape-form)
entities in a SEPARATE phase, after every simple entity in the scope,
greedily, in `compareEntities`-sorted order; the DEFAULT `compareEntities`
lexically compares `postfixFor`'s stringified counter, which is assigned on
FIRST PROBE by `Array.prototype.sort` — not declaration order. Two sibling
destructure-eligible params contesting the same field name (`complementary`'s
`a`/`b`, both used only via `["via"]`) resolved in the wrong order at first
(`b` keeping the bare name, `a` suffixed) — backwards from this package's own
"first declared wins" convention every OTHER binding honors. Fixed by
supplying `allocate.ts`'s OWN `compareEntities`, keyed off a `declOrderOf`
map populated in the SAME pre-order traversal `toCandidateRecord`'s
declaration-index already uses — verified inert for simple-entity tie-break
(the RUNG_BAND-scaled priority encoding already makes same-priority ties
dead code, so changing the comparator that only orders PROCESSING, never
priority, cannot change a simple-entity outcome) and pinned by a dedicated
3-sibling `naming.test.ts` row.

**Fixture churn beyond this directory, reviewed the same way (names-only or
destructure-shape-change class only, confirmed by diff and by
`assertFixtureNamesOnly`, not assumed):** four `fixtures/emitted/*.ts` rows
regenerated via `emitted-fixtures.test.ts`'s own `-u` workflow (no
REBASE_LOG requirement of its own — logged here for the paper trail, same
precedent as goldenEpoch 2's own entry below) plus
`fixtures/cross-pass/apply-plus.golden.json` (logged in that directory's own
`REBASE_LOG.md`, sibling entry):

- **`apply-plus.ts`** — `__acc` → `total` (item 4). `assertFixtureNamesOnly`:
  `equalModuloNames: true`, the single rename pair `['__acc', 'total']`.
- **`ai-winter-ebl-investigation.ts`** — TWO clean dict-field destructures:
  `devices.filter(__x => (d => …d["port"]…d["owner"]…)(__x) !== false)` →
  `…(({ port, owner }) => …)…` (the Law-T wrapper `__x` correctly stays `__x`
  — "device" singularizes fine but the guard fix declines it, per above);
  `privileged.map(d => d["name"])` → `privileged.map(({ name }) => name)`.
  `assertFixtureNamesOnly`: structural (Identifier → ObjectBindingPattern),
  reviewed by hand against the fixture's own source — both destructures
  match "used only via fields," confirmed by reading `ai-winter-ebl-
  investigation.scm` directly.
- **`inhuman-gepa-full.ts`** — the densest row: `trace`'s `ex` → `{ input,
  id, expected }`; `instrOf`'s `c` → `{ analyze, decide }`; `scores`'s `c` →
  `{ recs }`; `complementary`'s `(a, b)` → `({ via }, { via: via_2 })`
  (declaration order, per the fix above); `merge`'s `(a, b)` → `({ via,
  analyze, decide }, { decide: decide_2, analyze: analyze_2 })` (each
  param's OWN field set, not shared — `b` never reads `.via` so it never
  destructures that field); `total`'s reduce item → `score` (accumulator
  STAYS `__acc` — "total" collides with the top-level `total` function's own
  name, correctly declined, not forced); `select`'s reduce item → `weight`
  (same "total" collision, same correct decline). `paretoWeight`,
  `proposalBatchScore`, `parentBatchScore`'s own reduce sites are BYTE-
  IDENTICAL (confirmed, not assumed) — their receivers (`.map(...)` chains,
  `scoresOf(...)` calls) have no cleanly-singularizing name, so the item
  stays `__item`; their accumulators hit the SAME "total" collision as the
  two above. `mutate`'s own `candidate` param (`mercury-fixture-gepa`'s
  sibling case, below) is the negative control this row doesn't need — see
  that row instead.
- **`mercury-fixture-gepa.ts`** — `failing`'s `candidate` → `{ scores }`;
  `dominates?`'s `(a, b)` → `({ scores }, { scores: scores_2 })`. `mutate`'s
  OWN `candidate` param (used via BOTH `candidate["instruction"]` and a bare
  `failing(candidate)` pass-through) stays BARE — confirmed unchanged,
  the mixed-use "compose" rule declining cleanly, exactly the negative
  control the design needs and got for free from the real corpus.

**Names-only-diff confirmation, run programmatically
(`namesOnlyDiff`/`assertFixtureNamesOnly`, `src/oracle/names-diff.ts`) against
every changed fixture**: `apply-plus` reports `equalModuloNames: true` (a
pure bijective rename — genuinely names-only, no destructure shape moved).
`inhuman-gepa-full`/`mercury-fixture-gepa`/`ai-winter-ebl-investigation`
report `equalModuloNames: false`, each's FIRST divergence an `Identifier` vs
`ObjectBindingPattern` at a param position — the tool's own documented
behavior for a destructure-shape change (never silently classified as
"just a rename"); judged by hand against each program's source (above) as
the naming-policy win the churn class is.

**Value preservation, verified directly, not just inferred from "same JS
semantics":** ran `runOracle` (interpreter vs compiled) over six representative
programs exercising every new mechanism — single/two/three-param dict-field
destructure (including the sibling-order case), reduce `+`/`*` fold-role
naming, a mixed-use param forced to bare, and the Law-T-guard-around-a-real-
lambda shape (`(filter (lambda (rec) (zero? (modulo rec 2))) recs)`) — all
six `{ agree: true }`. Positional (array) destructure re-verified unaffected
by the Shape-API dissolution (`(car p) + (car (cdr p))` → `([first, second])
=> first + second`, value agrees) and shown coexisting with field destructure
in the SAME param scope (`([head], { x }) => head + x`, value agrees).

**Verified the blast radius stops exactly here**: full `arrival-mercury`
suite (53 files, 1137 pass / 17 expected-fail / 1 todo — the pre-existing
1117/17/1 baseline plus 20 new `naming.test.ts` rows covering every
mechanism above) green pre-regeneration-fix and post; `tsc --noEmit` and
`check:stories` both clean; `gate1-report.json` is BYTE-IDENTICAL (`git diff
--stat` empty) — naming never touches `classify()`'s raw tree gate 1
measures off. `legibility.test.ts`'s own destructure/singularize/CSE
end-to-end suite (the pre-existing positional-destructure coverage) is
untouched, byte-identical, confirming the Shape-API dissolution is a
behavior-preserving mechanism swap for the case it already handled.

## goldenEpoch 5 — R-G6: static prevaluation lands (2026-07-17)

**One golden changed — the exact punch-list item this landing targets**
(`docs/working-proposals/arrival-mercury/gate3-human-grade-rulings.md` R-G6,
"not a sidecar re-ruling — the major one"). A new decision-view module,
`../../prevalue/index.ts` (`prevalue`, the three-valued Scheme-truthiness
evaluator; `prevalueDecisionAt`, the fold), wrapped by `SchemeSemanticModel.
prevalueOf` (`../../model/model.ts`) exactly the way `idiomAt` wraps
`idiomDecisionAt` — memoized per node identity, no shadow guard needed
(unlike `idiomAt`'s `car`/`infer`, `if`/`and`/`or` are special forms
`classify()` recognizes structurally; a program cannot shadow them). The
walker (`../../walker/walk.ts`'s `lowerExpr` and `tailLoopForm`'s own `If`
arm) consults it inline, at the top of every `If`/`And`/`Or` it lowers, and
`oracle/harness.ts`'s `compileGreenfield` wires `sm.prevalueOf` into the
real `walk()` call the same way it already wires `sm.idiomAt`.

**`short-circuit-or.golden.ts`** — the named target, "its whole point becomes
demonstrating the fold" (R-G6's own words):
```diff
- import { error } from "./stage0.mts";
  function OracleMain() {
-     const __or = false;
-     return __or !== false ? __or : (() => {
-         const __or2 = "a";
-         return __or2 !== false ? __or2 : error("must-not-run");
-     })();
+     return "a";
  }
```
`#f` (the first operand) is provably inert for `or` and drops from the
chain; `"a"` (the second) is provably true (Scheme truthiness — a non-empty
string is never `#f`) and short-circuits the whole expression; `(error
"must-not-run")` sits strictly after the short-circuit point and is dropped
WHOLE, never lowered. `gate3-goldens.test.ts`'s own "actually exercises the
pattern" sanity check flips with it: `!== false ?` (the guard shape) no
longer exists to assert on, so the honest non-degradation proof becomes
"`error` is genuinely gone, not merely unreached at runtime" plus "the
surviving value is exactly the provably-true operand."

**OQ8a (`oracle-harness.md`'s own open question) resolved by ELIMINATION,
not by re-ruling** — the bug-cell corpus's `short-circuit-effect` row
(`(let ((n 0)) (or #t (begin (set! n 999) 'x)) n)`) was `it.fails`-tracked
because the sidecar expected a static `prohibited-dynamics` door on both
sides while both sides were lazy by design. Static prevaluation dissolves
the question instead of re-answering it: `or`'s first operand is the
literal `#t`, so the WHOLE `or` folds to that value and the `(begin (set! n
999) 'x)` branch — `Door("prohibited-dynamics/set!")` included — is dropped
whole, never lowered, never doored. `src/__tests__/bug-cell-corpus.test.ts`'s
`KNOWN_RED` entry for this row is deleted (it now runs as a plain, passing
`it`); `corpus/short-circuit-effect.expect.ts`'s `expected` changed from
`{ errorClass: "prohibited-dynamics" }` to `{ value: 0 }`, with its header
rewritten to record the elimination (not a "designed truth, not current
truth" placeholder anymore — this is now the ACTUAL, honest compiled
behavior).

**Two hard soundness invariants, each proven by a dedicated red-first test**
(`src/__tests__/prevalue.test.ts`): (1) value preservation — folding never
changes an oracle value, checked directly against the interpreter/compiled
pair for every fold shape (constant `if`, `and`/`or` drop, `and`/`or`
truncate, nested folds); (2) reachable doors still fire — `(if
runtime-cond (set! x) 0)` (an unprovable guard) folds NOTHING, the `set!`
door still throws exactly as before; `(or #f (set! x))` (the `#f` operand
drops, but `set!` is now the ONE remaining, unconditionally-reached
operand) still doors, unconditionally — proving the fold only ever
eliminates a branch PROVEN dead, never merely "probably fine."

**Fixture churn beyond this directory, reviewed the same way (dead-branch-
elimination class only, confirmed by diff, not assumed):** eleven more
`fixtures/emitted/*.ts` rows regenerated via `emitted-fixtures.test.ts`'s own
`-u` workflow (that suite's header already frames this as lockfile-style
churn, no REBASE_LOG entry of its own): `and-false-short-circuits`,
`and-three`, `and-zero-then-one`, `if-missing-else`, `or-first-truthy-wins`,
`or-three`, `short-circuit-control`, `short-circuit-effect`, `short-circuit-or`
(the bug-cell corpus's OWN copy of this shape — a different, 2-operand
source than the gate3 golden's 3-operand one, same fold), `truthy-empty-string`,
`truthy-false`, `truthy-zero-then`. Every one collapses a provably-constant
`if`/`and`/`or` to its bare value or a strictly shorter chain; `short-circuit-
control` (`(or #f (error "does-run"))`, the POSITIVE control proving the probe
still fires when the branch IS taken) now emits the `error(...)` call
UNCONDITIONALLY — correct, since `#f` being the sole earlier operand means the
call is no longer merely reachable but deterministic. `truthy-empty-list`
(`(if (list) "a" "b")`) and `or-await-literal`/`or-in-define` (Ref-headed
operands) are UNCHANGED — confirmed, not assumed: `(list)` is a runtime call
(an `App`, not a literal), and a `Ref` operand's truthiness is genuinely
unknown at compile time, so `prevalue` correctly declines both. `not-zero`
(`(not 0)`) is also unchanged — `not` is an ordinary registry-symbol `App`,
not a special form, deliberately out of this wave's scope (see `../../
prevalue/index.ts`'s own header).

**Verified the blast radius stops exactly here**: `gate1-measure.test.ts`'s
committed report (`fixtures/gate1-report.json`) is BYTE-IDENTICAL — confirmed
via `git status`, not assumed — because `gate1/measure.ts` measures directly
off `classify()`'s raw tree and never calls `walk()`/`prevalueOf` at all (its
own module header's "instrument choice" already explains why the walker's
decisions are irrelevant to that metric); none of the six `gate1-corpus`
manifest programs contains a literal-headed `if`/`and`/`or` in the first
place (confirmed by grep). `model-spine.test.ts`'s R11 prototype allow-list
is unaffected — `prevalueOf` is a plain instance field (an arrow function
assigned in the constructor), exactly like `idiomAt`, never a `Object.
getOwnPropertyNames(prototype)`-visible method. Every existing direct
`walk()` caller in the test suite (`walker.test.ts`, `chunk.test.ts`,
`rules-phase1.test.ts`, `naming.test.ts`, `asyncness.test.ts`,
`pipeline-smoke.test.ts`, `cross-pass-fixtures.test.ts`) never supplies
`prevalueOf`, so it defaults to `undefined` and no fold ever fires there —
byte-identical, unaffected, confirmed by running the suites, not inferred
from "the field is optional." Full `arrival-mercury` suite green post-change
(see this landing's own final gate report); `tsc --noEmit` and
`check:stories` both clean.

## goldenEpoch 4 — R-G3: async/await tail-await elision lands (2026-07-17)

**One golden changed — the exact punch-list item this landing targets**
(`docs/working-proposals/arrival-mercury/gate3-human-grade-rulings.md`
R-G3, conditional on Gate-3's `SIGN-OFF.md` sign-off). `asyncnessOf`/
`materializeAsyncness` (`../../naming/asyncness.ts`) implement the ruling's
two elisions as ONE rule (`consumeTail`, the module's own new helper),
applied at the two positions a "return" can occupy — an explicit
`Return.value`, and an Arrow's own expression body (an implicit return):
`return await X` is pointless outside a try/catch (arrival has no `Try`
node yet — `residual/types.ts`'s own "No `Try` — guard doors in v1" — so
the elision is UNCONDITIONAL today; gates for real the moment `Try` lands),
and an inner arrow whose ENTIRE body reduces to that shape needs neither
`async` nor `await` at all.

**`async-map-promise-all.golden.ts`** — the named target, R-G3's own worked
example:
```diff
- async function OracleMain() {
-     return await Promise.all(["a", "b"].map(async (x) => await infer("fast", x)));
- }
+ function OracleMain() {
+     return Promise.all(["a", "b"].map(x => infer("fast", x)));
+ }
```
Three eliminations, all the same mechanism applied at three different tail
positions: the callback's own `await infer(...)` (an implicit-return Arrow
body), the callback's own `async` keyword (nothing else inside it needed
`await`), and `OracleMain`'s outer `await Promise.all(...)` plus ITS OWN
`async` keyword (its whole body is now that one bare tail return). The
`Promise.all` rewrite-table collapse itself (Mechanics 3) is UNTOUCHED —
same trigger condition, same shape — only WHO ends up printing `await`/
`async` around it changed.

**The design point this landing had to get right, not just the byte diff**:
`AsyncnessFacts.arrowAsync` ("does calling this def yield a promise", feeds
`callType`/`promiseWrap`) and "does this def's own declaration need the
`async` keyword" (a NEW, un-exported decision `materializeAsyncness` derives
from what survives its own tail-elision rewrite) used to be the same
question and no longer are — `OracleMain` still "returns a promise" to the
harness's `const __oracleResult = await OracleMain();` (unaffected, a
genuine Const-init consuming position) even though its own declaration no
longer spells `async`. Getting this backwards (reading `arrowAsync` as "is
this printed `async`") would silently under-await every caller of a
fully-elided pass-through def — the exact bug class Law W's whole "over-
await is safe, under-await is not" discipline exists to prevent. `asyncness.
test.ts` gained three dedicated regression rows for the split (a Block-body
`{ return await E }` Arrow ELIDE case; a `const y = await f(); return y + 1;`
FnDecl KEEP case; an arithmetic-consuming Arrow KEEP case) alongside updating
every existing row the elision touches — none of the existing KEEP-shaped
rows (argument position, guarded and-chain, the non-batched ArrayLit
sibling, the `filter`/`every`/`some` door) changed a single byte.

**Verified the blast radius stops at exactly this one gate3 golden**: the
other six (`multi-list-map`, `apply-plus`, `apply-map-transpose`,
`first-class-car-hof`, `legibility-destructure`, `short-circuit-or`) contain
no `infer` call anywhere in their source (confirmed by grep, not assumed)
and are byte-identical before/after. Two OTHER, non-gate3 fixtures were
ALSO affected by the same mechanism and are logged at their own call sites,
not here (this log is gate3's own, per its header note below): `legibility.
test.ts`'s "an infer pair dedupes THROUGH the real ASYNC-IFY plane" row
(`OracleMain` itself drops to non-async — its own body is a bare
`f("hi")` tail return once CSE has already hoisted the genuine await into
`f`'s own `const __infer = await infer(...)`, which correctly stays). Full
`arrival-mercury` suite (51 files) re-run before/after: two failures, both
this ruling's own expected churn, both fixed; `tsc --noEmit` and
`check:stories` clean; `gate1-measure.test.ts`'s committed report
byte-identical (asyncness is an orthogonal axis to gate 1's `car`/`cdr`/`if`
type-availability measurement).

Per-file `goldenEpoch:` comment bumped 3 → 4 for `async-map-promise-all.
golden.ts` only (the R5c precedent: bump the one file that changed, not
every file in the directory — `short-circuit-or.golden.ts` is still
correctly at epoch 1, having never changed since the initial baseline).

## goldenEpoch 3 — E2 lands: the hybrid tree's hard side, `list(...)` shim dies for slot-safe data (2026-07-16)

**Six of seven goldens changed — the folding-churn class the engine plan's
E2 phase explicitly expects and welcomes** (`docs/working-proposals/
arrival-mercury-engine-plan.md` §2 E2: "gate: oracle green; folding churn
judged (literal arrays where list() shims stood, dead shim imports gone)").
`TsChunk`/`ChunkExpr`/`ChunkStmt` land in `residual/types.ts` (the hybrid
tree's hard node family, mirroring mercury's `IRASTExpression`/
`IRASTStatement` — `ast` required verbatim, `slots` optional), with
`residual/chunk.ts` (the `ts.factory` construction side) and
`residual/render.ts` (verbatim-or-substitute printing, mutual recursion,
expression/statement duality) alongside. `walker/walk.ts`'s ingestion fold
(S2) then does two things at `lowerApp`/`datumToR`:

1. **Quoted list data always folds** (`'(1 2 3)`, nested lists too) —
   ALWAYS slot-free (a `QuoteDatum` can never hold a scheme variable), so
   this leg changes the MECHANISM (`ArrayLit`-of-`Lit`s → a genuine
   `ts.factory` chunk) but never the emitted bytes — confirmed zero-churn on
   its own by the full suite staying green before any `list`-call change was
   even made.
2. **A `list` App call folds when every argument is "call-free"**
   (`isCallFree`, walk.ts: no `Call`/`Method`/`New`/`Arrow` anywhere in its
   lowered form) — a `Lit` argument embeds inline (no slot spent on a
   constant, mercury's own "short-circuits known primitives" move); anything
   else call-free (a bound `Ref`, a `car`/`+`-folded `Index`/`Bin` chain, a
   bare registry symbol referenced as a VALUE) mints a slot; anything
   containing a real call — a registry shim call, a lambda literal —
   **aborts the WHOLE call's fold**, falling back to the unchanged
   `Call(RuntimeRef("list"), args)` shape. The abort is fold-SCOPE POLICY
   (keep this wave's churn to the literal-data class the plan names), never
   a walker-safety requirement: chunks are NOT leaves to any walker —
   mercury-ir.md's own law ("never assume AST chunks are leaf nodes") — see
   the review-correction paragraph below.

**Review correction, same landing (the leaf-treatment fix).** An earlier
draft of this landing treated a chunk as a total LEAF in the generic
walkers (render's `containsAwait` children, legibility/tree.ts's
`childrenOf`/`mapChildren`, naming/asyncness.ts's own `childrenOf` and
rewrite arms), arguing `isCallFree` kept anything interesting out of every
slot. Review rejected that treatment by the substrate's own law, and the
audit confirmed the rejection was not merely E2b-forward-looking — the leaf
census had a TODAY-reachable wrong-code path (a param occurrence living
inside a slot invisible to the destructure census: destructure fires on
outer occurrences alone while the slot keeps referencing the now-undeclared
param), plus a latent import-rewrite miss (a mangled-name `RuntimeRef` like
`odd?` inside a slot skipped by `materializeImports`' `mapChildren` walk
renders as the scheme-spelled identifier — invalid TS). Corrected in place:
every walker now yields slot VALUES as children (the verbatim `ast` stays
opaque — blind to the ts.Node tree, seeing to `slots`, exactly the memo's
split), and asyncness's rewrite arms rebuild the slot map through the
rewriter, so a promise-typed slot gets its `Await` minted INSIDE the slot
and the enclosing def flips async. `isCallFree` survives as fold-scope
policy only. **Zero additional fixture churn from the correction** —
verified by the full suite passing against the already-regenerated fixtures
(no committed corpus program has a destructure decision or awaited edge
that flips through a slot). Four regression rows in
`src/__tests__/chunk.test.ts` pin the corrected behavior, each failing
under the leaf treatment: seeded-Call-in-slot flips the enclosing arrow
async with the Await inside the slot's rendered form; render's
`containsAwait` sees a slot Await (async IIFE, not the Law-W backstop
throw); a param occurrence inside a slot reaches the destructure census
(and the substitution reaches back through the slot); `odd?`-in-slot
resolves through `materializeImports` (oracle-agreeing).

**Golden-by-golden:**

- **`multi-list-map.golden.ts`** — both `list(1, 2, 3)`/`list(10, 20, 30)`
  calls are fully literal → fold; `list` drops out of the import line
  entirely (only `plus` survives).
- **`async-map-promise-all.golden.ts`** — `list("a", "b")` folds; `list`
  drops from the import line (only `infer` survives). The `.map`'s own
  `Promise.all` collapse (asyncness's Method-specific rewrite) is
  untouched — it fires on the FOLDED array's `.map` call exactly as it did
  on the shim call's.
- **`apply-plus.golden.ts`** — `list(1, 2, 3)` folds; with no other runtime
  symbol left, the `import` DECL itself disappears (the identity fast path
  `materializeImports` already had for an empty symbol set — no new code,
  just a set that's now empty for this program).
- **`apply-map-transpose.golden.ts`** — `list(list(1, 2), list(3, 4))`
  folds RECURSIVELY to one genuinely nested `[[1, 2], [3, 4]]` (the `"ast"`
  splice, not a slot-per-level) — but `map(list, ...)`'s OWN `list` stays a
  bare value reference (`mapEmitRule`'s arity-bridge passes the lowered
  first argument straight through as the zip callback; that is a REGISTRY
  RULE constructing its own `Call`, never routed through `lowerApp`'s rung-3
  interception at all) — so the `list` IMPORT SURVIVES, unchanged. Updated
  `gate3-goldens.test.ts`'s own sanity assertion (`toContain("...list(")` →
  `toContain("...[")`) to match — the pattern under test (apply's transpose
  via spread) is unaffected; only the substring proving it doesn't
  silently degrade had to move with the bytes.
- **`first-class-car-hof.golden.ts`** — `list(list(1, 2), list(3, 4))` (the
  `xss` binding's init) folds the same recursive way; `car`'s own eta
  expansion (R5c, goldenEpoch 2) is untouched — `xss.map(([head]) => head)`
  is byte-identical past the `const xss = …` line. Per-file
  `goldenEpoch:` comment bumped 2 → 3 (the ONLY file entering this landing
  already above epoch 1).
- **`legibility-destructure.golden.ts`** — same recursive-fold shape as
  apply-map-transpose/first-class-car-hof; the destructure pass (`([first,
  second]) => first + second`) is untouched past the receiver.
- **`short-circuit-or.golden.ts`** — **unchanged, verified not assumed**
  (regenerated via the same script as the other six; diff empty) — no
  `list` call anywhere in its source.

Regenerated by running the real, gate-authoritative
`compileGreenfield(session, source)` against each fixture's UNCHANGED
`source` and committing the observed bytes verbatim (same discipline as
every prior entry) — a small script drove all seven through one shared
`OracleSession`, diffing before/after per file; `short-circuit-or`'s
`changed=false` readout is the direct confirmation above, not an assumption.

**Verified the blast radius**: full `arrival-mercury` suite (51 files) green
post-regeneration (1048 pass / 18 expected-fail / 1 todo — the pre-existing
1012/18/1 baseline plus 36 new `chunk.test.ts` rows); `tsc --noEmit` and
`check:stories` both clean; `cross-pass-fixtures.test.ts`'s four affected
`.golden.json` rows (`filter-truthy-zero`, `multi-list-map`, `apply-plus`,
`member-assoc` — a DIFFERENT fixture directory/log, `fixtures/cross-pass/
REBASE_LOG.md`, this entry's sibling) and `emitted-fixtures.test.ts`'s
eleven affected snapshot rows are regenerated and reviewed the same way;
`gate1-measure.test.ts`'s committed report is BYTE-IDENTICAL post-change
(gate 1 measures `car`/`cdr`/`if` type-availability, an orthogonal axis this
landing never touches) — `cleanPct` stays 84.84848484848484 (~84.8%),
confirmed, not just assumed from "we didn't touch that code."
`legibility.test.ts`'s two inline expectations referencing a bare
`list(1, 2)`/`list(1, 2, 3)` shape were updated to the folded array literal
— unrelated to the destructure/CSE claims those two tests actually pin (see
each test's own updated inline comment).

`member-assoc` (`fixtures/emitted/member-assoc.ts` +
`fixtures/cross-pass/member-assoc.golden.json`, not this directory, but the
clearest worked example of the abort gate) is the load-bearing proof the
gate is per-call-site, not per-program: `list(member(2, list(1, 2, 3)),
assoc(2, list(list(1, "a"), list(2, "b"))))` → `list(member(2, [1, 2, 3]),
assoc(2, [[1, "a"], [2, "b"]]))` — the OUTER `list` (wrapping two real
`Call`s) does not fold, while every NESTED literal `list` — including ones
buried two levels inside `assoc`'s own argument — folds independently. Same
mechanism, applied bottom-up, no special-casing.

**New substrate tests**: `src/__tests__/chunk.test.ts` (36 rows) — chunk
rendering mechanics (verbatim, substituted-by-slot, the "ast"-splice nesting
case, the mutual-recursion rule with a chunk-in-a-slot, both duality
directions for `ChunkExpr`/`ChunkStmt`), the walker's fold/abort decisions
(literal, mixed, call-containing, closure-containing, kwargs-present), the
import census seeing through a slot, the four leaf-treatment regression
rows (review-correction paragraph above), and oracle agreement over the
real session (including the `infer`-inside-`list` abort case, verified by
BYTES since `infer` always throws — untaxonomized, on both sides — in this
harness by design; no existing suite runs the oracle over an
`infer`-containing program for that reason).

## goldenEpoch 2 — E1a lands: names dissolve into census + allocate + materialize (2026-07-16)

**Zero gate-3 goldens changed — verified, not assumed.** `git diff --stat` against this
directory and a fresh `gate3-goldens.test.ts`/`gate3-rubric.test.ts` run both confirm
`multi-list-map`, `async-map-promise-all`, `apply-plus`, `apply-map-transpose`,
`short-circuit-or`, `first-class-car-hof`, `legibility-destructure` are byte-identical to
goldenEpoch 2's own baseline. Recorded here anyway (mirroring goldenEpoch 1's own "no
existing golden changed" entry) because this landing is exactly the kind of engine change
gate 3 exists to catch drift from — the engine plan's E1a phase
(`docs/working-proposals/arrival-mercury-engine-plan.md` §2 E1a): a global binding census
(`src/naming/census.ts`) feeds one `@here.build/lexical-namer` allocation
(`src/naming/allocate.ts`), and `walker/walk.ts` now commits the result
(`src/naming/materialize.ts`) before it ever returns — `fresh()`-at-emit's own ad hoc
`${name}_${n}` collision loop is gone, and the legibility pass's destructure/singularize
legs (`legibility/destructure.ts`, `legibility/singularize.ts`) are deleted, their analysis
ported verbatim into the census as a READ instead of a decide-and-rewrite pass.

**Two `fixtures/emitted/*.ts` fixtures DID change — pure renames, same discipline as
goldenEpoch 2 (R5c)'s own `mercury-fixture-gepa.ts` note: that suite's header already
frames snapshot drift as "regenerate after an emitter change... review the diff like a
lockfile," no REBASE_LOG requirement of its own, logged here for the paper trail.**
Verified names-only via `assertFixtureNamesOnly` (`src/oracle/names-diff.ts`) wherever the
tool's positional-bijection check could confirm it cleanly; the two cases below hit the
tool's own documented limit (no scope analysis — two DIFFERENT old names occupying
disjoint sibling scopes both resolving to the same new bare name reports as a "collision"
even though it is safe) and were verified by hand instead (both are genuinely independent,
non-overlapping function scopes — see each entry).

- **`inhuman-gepa-full.ts`** — 8 renames, all pure:
  - `__x2 → __x` (the `frontier` function's `.filter` callback — a SEPARATE, sibling scope
    from `failuresOf`'s own `__x`; the old ad hoc walker suffixed it purely because its
    single-flat-stack collision tracking couldn't see the two were disjoint. Hit the
    names-diff tool's collision limit — verified by hand: `failuresOf`/`frontier` are two
    unrelated top-level `const`s, zero overlap.)
  - `__acc2 → __acc`, `__item3 → __item` (`paretoWeight`'s `.reduce`)
  - `__acc3 → __acc`, `__item4 → __item` (`select`'s `.reduce`)
  - `picked → isPicked` (the `picked?` predicate function) and `picked_2 → picked` (the
    named-let loop var, `sampleBatch`) — **the one semantic-reading improvement, not just
    renumbering**: this is precisely the "gepa-full bug" `front/scheme-scope.ts`'s own
    header names as the read-register namer's motivating case (a data binding and a
    same-named predicate contesting one bare name) — the content-aware ladder trick
    (predicate yields the bare name when a co-scoped plain binding wants it) now fires in
    the RUN register too, for the first time. The DATA (the accumulated picked set) reads
    as `picked`; the PREDICATE reads as `isPicked` — better than the old, backwards
    assignment (`picked` the predicate, `picked_2` the data).
  - `__acc4 → __acc`, `__item5 → __item` (`proposalBatchScore`'s `.reduce`)
  - `__acc5 → __acc`, `__item6 → __item` (`parentBatchScore`'s `.reduce`)
- **`mercury-fixture-gepa.ts`** — 2 renames, both the same disjoint-sibling-scope pattern:
  `__x2 → __x` (`failing`'s `.filter`) and `__x3 → __x` (`frontier`'s `.filter`) — two
  unrelated top-level `const`s, verified by hand for the same names-diff-tool-limit reason
  as `inhuman-gepa-full.ts`'s `__x2` row above.

Regenerated via `vitest run emitted-fixtures.test.ts -u` (the file's own documented
workflow) against the real, gate-authoritative `compileGreenfield(session, source)`;
every other `fixtures/emitted/*.ts`/`fixtures/gate1-corpus/*` fixture re-checked and
confirmed byte-identical (no other corpus program exercises a sibling-scope glue name or a
predicate/plain-binding same-bare-name contest).


Constitution §9 golden discipline ("Golden discipline (two golden sets,
epoch-stamped)"): a byte-change to any `*.golden.ts` file in this directory
requires an entry here — "re-base once, explicitly" is a mechanism (this log),
never a culture instruction. This log is Gate 3's own — separate from
`fixtures/cross-pass/REBASE_LOG.md` (the typefacts-extraction cross-pass
fixtures' log; different owner, different pipeline slice, no collision).

## goldenEpoch 2 — first-class-car-hof: eta lands (R5c, 2026-07-16)

**One golden changed, by design — the exact flip goldenEpoch 1's own note
watched for.** `car`'s Phase-1 row (`rules/phase1.ts`) already declared
`refPolicy: "eta"`, but `carRule` carried only `.call` — no `.ref` method — so
the walker's value-position ladder (`registryValueRef`) fell through to the
rung-3 `RuntimeRef` shim every time. This wave gave `carRule` a `.ref` that
eta-expands `call` against the INSTANTIATED use-site signature
(`ctx.selfFacts?.callable` — `TypeFacts.callable`), consuming extraction
machinery that was ALREADY WIRED and unmodified by this landing
(typefacts/extract.ts's `probeCallable`, "Value-position probe —
single-occurrence Refs in argument position" — the once-unverified assumption
arrival-ts-transpiler-design.md §4.2 flagged, "whether the lens delivers
instantiated signatures in argument position," now proven live).

**`first-class-car-hof.golden.ts`** — the named Gate-3 golden this landing targets:
```diff
- import { car, list } from "./stage0.mts";
+ import { list } from "./stage0.mts";
  function OracleMain() {
      const xss = list(list(1, 2), list(3, 4));
-     return xss.map(car);
+     return xss.map(([head]) => head);
  }
```
`car` drops out of the import line entirely (FRAME's import-as-query only
imports symbols a surviving `RuntimeRef` still references — eta replaced that
reference with an inlined arrow). The destructured `([head]) => head` shape
(not the `.ref`-built `(x) => x[0]`) is LEGIBILITY's destructuring +
element-name-singularization passes firing on the newly-inlined arrow, an
EMERGENT interaction with existing, unmodified passes — not something this
landing's `.ref` method constructs directly.

Regenerated by running the real, gate-authoritative `compileGreenfield(session,
source)` against the fixture's unchanged `source` and committing the observed
bytes verbatim (same discipline as every other entry in this log) — the arrow
shape above was read off the actual pipeline output, never hand-typed.

**A SECOND fixture was affected, discovered empirically (not assumed) —
`fixtures/emitted/mercury-fixture-gepa.ts`** (`emitted-fixtures.test.ts`'s own
snapshot, a different fixture directory/discipline than this gate3 log, no
REBASE_LOG requirement of its own — that suite's header already frames
snapshot drift as "regenerate after an emitter change... review the diff like
a lockfile"). `mercury-fixture-gepa.scm`'s own copy-as-chunk header names
EXACTLY why: it was chosen because it "pairs a first-class `car` in HOF
position (`(map car …)`) with an independent two-list `map` zip" — the SAME
pattern this landing targets, so the SAME eta-expansion fires on it too:
`.map(car)` → `.map(([head]) => head)`, `car` drops from the import line, and
inserting the eta arrow's own fresh binding earlier in the SAME compilation
shifts an UNRELATED `filter` guard's fresh-name suffix two lines down
(`__x`/`__x2` → `__x2`/`__x3` — cosmetic renumbering, same shape, not a
behavior change). Regenerated the same way (`vitest run
emitted-fixtures.test.ts -u`, reviewed the diff, confirmed it is exactly the
two expected shapes above and nothing else). This is not scope creep: it is
the identical, correct mechanism firing wherever the pattern already occurs in
the committed corpus — not applying it here would leave a second real program
stale relative to what the compiler now actually emits.

**Verified the blast radius stops at exactly these two fixtures**: the full
`gate3-goldens.test.ts` suite re-run before/after — `multi-list-map`,
`async-map-promise-all`, `apply-plus`, `apply-map-transpose`,
`short-circuit-or`, `legibility-destructure` are all byte-identical to
goldenEpoch 1 (none of the other five exercises a bare symbol in HOF value
position the way `first-class-car-hof` does by design). `cross-pass-
fixtures.test.ts` and every OTHER `fixtures/emitted/*.ts`/`fixtures/gate1-
corpus/*` fixture were also re-run and are unaffected (none references `car`
in value position either) — confirmed via the full arrival-mercury suite, not
assumed from the two known cases alone.

`cdr` is the structurally identical, natural follow-up — deliberately NOT done
this wave (no golden names it yet; land it as its own reviewed, one-golden
change when a case pins it, same discipline as this entry).

## goldenEpoch 1 — initial baseline (2026-07-14)

First-landing baseline for the six hard cases the constitution's Gate 3 names
(§9: "goldens vs the `goldenEpoch: 1` baseline on the hard cases"):
`multi-list-map`, `async-map-promise-all`, `apply-plus`, `apply-map-transpose`,
`short-circuit-or`, `first-class-car-hof`.

Generated by running the real, gate-authoritative `compileGreenfield(session,
source)` (constitution §9's dual-path rule: the new pipeline is the gate
subject from Phase 1) against each fixture's `source` and committing the
observed bytes verbatim — no hand-typed residual or renderer output. One
shared `OracleSession` per test suite, per the oracle-harness's §4.1 reuse
contract.

Two runtime-module additions landed alongside this baseline (both additive,
`src/runtime/stage0.ts`), because `compileGreenfield`'s FRAME stage doors on
any `RuntimeRef` symbol absent from the manifest, and neither symbol had a
prior reason to exist there:

- `car`/`cdr` in VALUE position — needed the moment either name appears as a
  bare HOF argument (`first-class-car-hof`'s `(map car xss)`); call position
  never needed them (the emit rules fold inline unconditionally).
- `infer` — needed for ANY async-seeded program to compile at all
  (`async-map-promise-all`). The shim is an honest placeholder that throws
  (the framework axis is out of scope for Phase 1 — see `phase1.ts`'s own
  `TODO(config.framework)`); it exists so the ASYNC-IFY rewrite SHAPE can be
  pinned, not to answer real inference calls.

No prior baseline existed — this is Gate 3's first landing, not a rebase of a
previous epoch. The one WATCHED future flip: `first-class-car-hof`'s golden
comment names the exact upgrade (`car`'s row growing a `.ref` that reads
`callable` facts) that will change its bytes on purpose.

## goldenEpoch 1 — new fixture added, no existing golden changed (2026-07-14)

LEGIBILITY (constitution §3.5's third invention — implicit destruction,
element-name singularization, pure-region CSE) wired into `compileGreenfield`
between `walk()`/`exportUnitResult` and `asyncIfy` (a documented deviation from
the constitution's §3.1/§3.5 pipeline-diagram ordering — see
`../../legibility/legibility.ts`'s header for the full reasoning: CSE hoists
duplicate calls into an ordinary sync-shaped `Const` BEFORE asyncness exists,
so ASYNC-IFY's ordinary Const-handling awaits it correctly with zero changes
to either pass).

**None of the six existing goldens changed a single byte.** Checked directly
(full `compileGreenfield` re-run against each fixture's `source`, byte-compared
against the committed `golden`): none of `multi-list-map`,
`async-map-promise-all`, `apply-plus`, `apply-map-transpose`,
`short-circuit-or`, `first-class-car-hof` happens to contain a destructure-
eligible tuple access, a multi-list map with a NAMED (`Ref`-shaped) driving
collection, or a duplicate pure call — the three shapes LEGIBILITY acts on.
(`multi-list-map`'s receiver is `list(1, 2, 3)` — a `Call`, not a `Ref` —  so it
has no derivable collection name for singularization either; a `Call`-shaped
receiver only yields a name when its OWN callee resolves to a registered
symbol, and `pluralize.singular("list") === "list"`, already singular, in any
case.)

**One new fixture added** — `legibility-destructure.golden.ts` — to give Gate 3
concrete, oracle-agreeing coverage of the constitution's own worked example
(`(lambda (pair) (+ (car pair) (cadr pair)))` → `([first, second]) => first +
second`, spelled `(car (cdr pair))` since `cadr` is not yet a bound registry
symbol — see the fixture's own header). Generated the same way every other
fixture in this file was: running the real `compileGreenfield(session, source)`
and committing the observed bytes verbatim; `runOracle` on the same source
agrees with the interpreter (checked, not asserted in this fixture file itself
— see `../legibility.test.ts`'s oracle-session describe block for the
committed oracle-agreement assertion on this exact transformation).

Singularization and CSE are NOT separately added as gate3 fixtures (the
existing six had no natural, uncontrived slot for either without forcing an
artificial-looking source program); both are covered — with oracle agreement
checked, not just byte-pinned — end to end through the real `compileGreenfield`
pipeline in `../legibility.test.ts`'s own "wired into compileGreenfield"
`describe` block instead. That suite is this landing's de facto second golden
set for the pass; nothing here contradicts it.
