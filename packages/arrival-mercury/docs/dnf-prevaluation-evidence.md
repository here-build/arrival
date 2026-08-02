# DNF-fold / prevaluation evidence — what here.build's semantic model actually does

**Status:** reference evidence (read-only extraction); file:line paths cited below are as of 2026-07. `src/prevalue/` landed off this memo's correction.

> **V CORRECTION (2026-07-17) — the transfer analysis below UNDERSELLS arrival.** The memo
> concluded arrival "should skip any cascade/scope/SAT analog entirely" because it "has no
> finite enumerable variant space." That is wrong in spirit. **Arrival's variant space is the
> TS type lattice, and it uniquely holds the three properties that make reasoning over it
> sound:** (1) a TS-LSP type at every node (the type lens) — so TS control-flow narrowing over
> a discriminated union IS the impossible-conjunction detection here.build built a bespoke
> variant-SAT for; `(if (= x "a") A (if (= x "a") DEAD B))` folds because in the outer else the
> lens narrows `x` to the complement, making the inner guard a `never`-typed impossibility that
> tsc itself reports. (2) **Immutability** — no `set!`, so the narrowing is PERMANENT across the
> whole flow (stronger than TS's own no-mutation-in-flow assumption; the same permanence the
> provenance side relies on). (3) **No-dynamics** — no call/cc reachability escape; control flow
> is statically total. Net: arrival does impossible-branch detection with LESS machinery than
> here.build (tsc IS the SAT solver over types; the type lens already feeds it), not more.
>
> So the split is two-phase, not "constant-fold only":
> - **R-G6 phase 1 (LANDED, 413372305c):** literal three-valued constant-fold — `(or #t X)`,
>   `(if #f A B)`. Unconditionally sound (a literal `#t` is `#t` at runtime, no type needed).
> - **R-G6 phase 2 (type-directed, E4-coupled):** consult the type lens — fold a branch whose
>   guard is provably `never`-typed at that flow position. The power arrival uniquely has.
>   **Soundness gate (mandatory, non-negotiable):** this drops a branch on a TYPE proposition,
>   so it is sound ONLY under the two-pass-soundness law (the compiler memory's "every narrowing
>   .d.ts leaf is a proposition the runtime must prove"). A branch may be eliminated iff its
>   guard's `never` verdict rests on a type the runtime provably honors — NEVER on an `any`
>   contamination or an unsound cast. Unlike phase 1, phase 2 can DIVERGE if the type lies, so
>   it gates on the same Law-T discipline that governs guard emission, and lands with E4 (the
>   type register made native) not before. The finite-lattice reachability here.build gets from
>   its variant space, arrival gets from tsc-over-immutable-bindings — a strictly more general
>   substrate, gated by soundness rather than by finiteness.


**Purpose:** read-only extraction for R-G6 (`gate3-human-grade-rulings.md:60-74`). V's
directive: peek at here.build's DNF-fold before building arrival's static-prevaluation
lane, since `(or #t (set! x))` — a faithful `||` carrying a dead branch — is exactly the
shape here.build's variant model already folds away. Every claim below is file:line
against the real code, read directly (not paraphrased from `.claude/rules/mercury-ir.md`
or `variant-composition-model.md`, which are the *targets* being checked, not the
source). No code changed; this file is the only write.

**Headline correction to the task's own framing:** "IMPOSSIBLE conjunctions
(contradictory variant conditions)" describes a mechanism that exists
(`predicatesAreDisjoint`) but is **not** wired into the DNF fold — it feeds
CSS-conflict/specificity reporting instead. The fold's actual impossible-drop is a
generic three-valued **expression**-semantics evaluator that explicitly treats variants
as unresolvable. This inverts the expected transfer story: the part of the system that
looks variant-specific doesn't reach the fold; the part that reaches the fold was
already variant-agnostic. See §6.

---

## 1. The DNF representation

`here.build/public-packages/mercury/src/ir1.ts:168-176`:
```ts
/** Variant-conditional wrapper — a value is either a leaf `T` or a conditional tree `IRDnf<T>`.
 * Free monad over the test functor: `Pure T | Step (Test (Maybe T))`.
 * Invariant: T is never IRDnf<X> (enforced by construction, not type-level). */
export type Maybe<T> = T | IRDnf<T>;
```
A conjunct is an `IRDNFPredicate` (`ir1.ts:178-187`): `{ expressions: IRExprSymbol[],
variants: Variant[], nullish?: boolean }` — an AND of arbitrary lowered expressions
*and* variant refs in one clause; empty AND = vacuously true. A disjunct-tree is
`IRDnf<T>` (`ir1.ts:189-199`): `{ test: Maybe<IRDNFPredicate[] | boolean>, cons: null|T|IRDnf<T>, alt: null|T|IRDnf<T> }`
— `test` is an OR-of-predicates (empty array = false); doc-tagged "De Morgan isomorphic."
Array/children contexts get a parallel shape, `IRListDnf<T>` (`ir1.ts:201-206`), where
`cons`/`alt` are arrays (concatenation semantics) instead of a nullable scalar. Both are
runtime-discriminated (`type: "ir-dnf"` vs `"ir-list-dnf"`) and guarded by `isDnf`/
`isListDnf` (`mercury/src/guards.ts:45-49`). `Maybe<T>` threads through nearly every IR1
field — HTML attrs, event handlers, statement operands, style values — because variance
is declared "pervasive, not localized" (`ir1.ts:169-170`); nothing about the *type* is
variant-specific — `T` is fully generic.

## 2. The fold: combine, simplify, impossible-drop

Two distinct implementations, not one:

**(a) Eager fold at construction** — `semantic-model/src/visitors/dnf.ts`. Builders
`makeDNFStatement` (`dnf.ts:72-88`) and `makeDNFChildrenStatement` (`dnf.ts:90-103`) are
called *by the tree-building visitors themselves* (e.g. `reduceDnf`, `dnf.ts:140-157` —
the `IR1.reduceDnf` `variant-composition-model.md:77` points at) whenever a conditional
value would be minted. Before building an `ir-dnf` node, they call `resolveStaticTest`
(`dnf.ts:42-70`), which resolves the whole test to `true`/`false`/`undefined` via
`resolvePredicate` (`dnf.ts:22-36`, AND-clause resolution) — only the `undefined` case
actually constructs an `IRDnf` node (`dnf.ts:80-87`); the `true`/`false` cases return
`cons`/`alt` directly. **A dead branch is never wrapped in a node at all**, not folded
away after the fact.

**(b) A separate, bottom-up algebraic compaction pass** —
`semantic-model/src/middle-end/dnf-compact/index.ts` (absorbed from a former standalone
package `mercury-dnf-simplify`, per header comment `index.ts:1-4`). Public entry
`compact`/`compactWithSemantics` (`index.ts:122-145`) drives `compactDnf`
(`index.ts:151-193`) bottom-up over children first (`index.ts:163-165`), applying five
named rules in order:
1. **dead-true → cons**, **dead-false → alt** (`index.ts:168-169`).
2. **Identity** — `cons` structurally equals `alt` (via `maybeEq`, `index.ts:86-92`) →
   collapse to `cons` (`index.ts:172`).
3. **OR-factoring (absorptive law)** — `(A ? X : (B ? X : Y)) → (A∨B ? X : Y)`, common
   *consequent*, merges by predicate-array concatenation `test: [...test, ...alt.test]`
   (`index.ts:174-177`) — strictly removes a node.
4. **AND-factoring** — `(A ? (B ? X : Y) : Y) → nested(A,B) ? X : Y`, common
   *alternate*, builds a nested-DNF-in-test (`index.ts:179-188`) — node-count-**neutral**,
   so it's gated by `cost(merged) <= cost(dnf)` (`index.ts:187`, `cost`/`testCost` metric
   at `index.ts:70-82`). Per `here.build/docs/package-specific/semantic-model/css-expression-naive-optimizer.md:682`,
   this gate is the *actual* termination certificate — an earlier draft tried to drop it
   as "redundant with structural decrease" and 2026-05-28 research proved that premise
   false (the naive lex-product measure does not strictly decrease under this rule). A
   defensive `n²+64` iteration cap (`index.ts:137-144`) backs it up and fails loud via
   `invariant` if ever hit.

**Impossible-drop, precisely:** `resolvePredicate` (`index.ts:49-66`) resolves ONE
AND-clause using only `exprSemantics(expr).truthy`/`.nullish` over `p.expressions` — if
`p.variants.length > 0`, the starting value is `undefined`
("Variants are runtime — if present, best we can do is check expressions,"
`dnf.ts:25-26`) and **variants are never themselves resolved to true/false by this
path**. `compactTest` (`index.ts:197-224`) then does the OR-level reduction: any
predicate resolving `true` collapses the whole test to `true` (`index.ts:218`);
predicates resolving `false` are dropped from the surviving set (`index.ts:219`); zero
survivors ⇒ `false` (`index.ts:221`). So "impossible" here means **statically-false
expression content**, not "these two variants can't both be active" — see §6.

## 3. Constant-condition & dead-branch elimination (the `(or #t X)` analog)

The engine is `analyzeExprSemantics` (`semantic-model/src/visitors/static-evaluate-test.ts:246-253`),
mirroring `@here.build/model`'s canonical three-valued logic
(`model/src/calculus/semantic-ir.ts:110-284`: `ExprSemantics` interface at
`semantic-ir.ts:121-130`, `combineTernary` "meet" at `:280-284`). Its TS-AST dispatcher
`analyzeTsExpression` (`static-evaluate-test.ts:58-236`) explicitly handles boolean/
numeric/string/bigint literals and `true`/`false`/`undefined`/`NaN`/`Infinity`
identifiers (`:65-99`), `!` (`:106-119`), `&&`/`||`/`??` **with real short-circuit
semantics** (`:127-162`) — e.g. `||`: `if (left.truthy === true) return left;`
(`:142`) — a literal-`true` left operand resolves the whole expression to
`TRUE_LITERAL` *without inspecting the right operand's semantics at all* — plus ternary
(`:194-207`), comparisons/bitwise/`typeof`/`void` (`:164-234`).

This is exactly `(or #t (set! x))`: the literal-`true` short-circuits `||`, the
predicate resolves `true` (via `resolvePredicate` in whichever of §2a/§2b is active),
and `makeDNFStatement`/`compactDnf` return `cons` alone — the `alt` branch carrying the
`set!` is never emitted. The same true/false check reappears **twice more**,
independently, later in the pipeline: `isStaticTrue`/`isStaticFalse`
(`mercury-compiler/src/lower-expr.ts:889-896`), consulted inside `lowerMaybe`
(`:601-602`), `lowerDNFTest` (`:622-623`), and statement lowering
(`lookahead/statements.ts:900,902,1044-1045`); and again inside `optimizeExpr`'s own
`TrueKeyword`/`FalseKeyword` checks (`lookahead/helpers.ts:510-511,518-519`). Three
independent layers all agree — belt-and-suspenders, not one canonical choke point.

**Generality:** this evaluator is over arbitrary JS/TS boolean-ish expressions —
literals, `&&`/`||`/`??`, comparisons, `!`, ternaries, `typeof`, `void` — with **zero**
variant content. It is not "the variant-condition folder with an expression escape
hatch"; it's a general constant-folder that variants are explicitly excluded from.

A **second**, separate impossible-mechanism exists, and it *is* variant-specific:
`optimizations/dead-variants.ts` — "A predicate (AND clause) is dead when ANY of its
variants is impossible [i.e. outside the component's scope]" (`dead-variants.ts:5`).
`resolveTest`/`pruneListDnf`/`pruneScalar` (`:35-60,119-132,171-183`) repeat the same
true/false/undefined-collapse shape, keyed on `possible.has(v)` (component/document
scope membership) not expression truthiness, as phase 1 of `shake()`
(`optimizations/shake.ts:127-163`, call at `:135`) — itself the MobX
`@computed({ keepAlive: true })` getter `SemanticModel.shakenRenders`
(`SemanticModel.ts:527-531`, `shake` imported `:55`), i.e. a **lazy, memoized,
pull-based second stage** over the tier-1-already-folded tree, recomputed on dependency
change, never manually re-invoked.

A genuinely-contradictory-**variant-pair** detector also exists — `predicatesAreDisjoint`
("Are two variants PROVABLY mutually exclusive," `model/src/utils/variant-predicate.ts:151-163`)
— but it feeds `canCoApply` (`semantic-model/src/lens-helpers.ts:341-348`), consumed by
`SemanticModel.getConflicts` (`SemanticModel.ts:962-1001`, call at `:977`) for editor
conflict warnings and `mercury-css-specificity/src/index.ts:62` for CSS layering. **It
is never consulted by `compactDnf`/`resolvePredicate`** — here.build does not fold
`state==="a" && state==="b"` away as dead inside the DNF compactor; that fact is
computed, but routed to a different consumer.

## 4. Canonical ordering

`ComponentBase.cascadeOrder: Map<Variant, number>`
(`model/src/models/component/ComponentBase.ts:449-496`, `@computed({keepAlive:true})`)
flattens four tiers into one ordered list: (1) pseudo-classes by canonical CSS-spec rank
(`:456-461`, via `getSelectorRank`), (2) site media groups this component actually uses,
threshold order (`:463-475`), (3) site state groups used, by `site.variantPrecedence`
else natural order (`:477-485`), (4) component-local non-style variants by
`variantPrecedence` (`:487-493`); `indexMap` (`variant-sorting.ts:122-124`) turns the
flattened list into the `Variant → index` map. `SELECTOR_RANK` (`:109-120`) is the
canonical CSS pseudo-class order (Link, Visited, Hover, Focused, Focus Visible, Focused
Within, Focus Visible Within, Pressed, Disabled, Placeholder), unknowns sorted last by
`getSelectorRank` (`:130-134`). Combo-level total order, `compareRanks` (`:140-146`):
lex-compare on descending-sorted cascade-index arrays, shorter array wins ties
(replaced an earlier sum-based scheme that collided, `:23-24`). Within-combo emission
order (readability, not precedence), `compareForEmission` (`:172-182`): cluster rank
(media=0, pseudo/style=1, other=2, `emissionCluster` `:152-154`) then cascade index.

DNF-specific application: `canonicalizeDnf`/`canonDnf`/`canonTest`
(`middle-end/dnf-compact/canonicalize.ts:37-96`) reuses `cascadeOrder` +
`compareForEmission` to make a **compacted** DNF's predicate/variant order
deterministic. Full total order for the OR-of-predicates (`canonicalize.ts:73-95`):
(1) each predicate's `vKey` — sorted cascade-rank vector, lex-compared
(`lexCompare`, `:98-104`); (2) `nullish` flag; (3) joined canonical expression
serialization (`serializeValue`, `dnf-compact/canonical-serialize.ts:42`). Runs
recursively at every commutative node, called **after** `compact` — both invoked
together at CSS emission, `css-targets/css-modules/emit.ts:201-202`
(`compact(...)` then `canonicalizeDnf(...)`) — ordering an uncompacted tree would sort
operands the compactor is about to delete. Stated purpose: byte-identical output for
git-stable diffs (`canonicalize.ts:2-5`; corroborated by
`css-expression-naive-optimizer.md:562-573`, "Confluence / canonical form").

## 5. Shape selection: if-else vs ternary

Structural and positional — decided by **where** the `Maybe<T>` lives, not a separate
heuristic pass:

**Expression position → always ternary.** `lowerMaybe`
(`mercury-compiler/src/lower-expr.ts:594-612`) and `lowerDNFTest` (`:615-646`) both emit
`f.createConditionalExpression`, but check `isStaticTrue`/`isStaticFalse` first
(`:601-602`, `:622-623`) to skip building the ternary entirely when possible.

**Statement position → always if/else, single-arm when the other side is absent.**
`lowerStatementBody` (`lookahead/statements.ts:1031-1054`) and the near-duplicate
inline-handler-body path `buildHandlerArrow` (`:889-912`) both: `isStaticTrue(test) &&
cons` → push `cons` alone, no `if` at all (`:1044`/`:900-901`); `isStaticFalse(test) &&
alt` → push `alt` alone (`:1045`/`:902-903`); `cons && !alt` → single-arm
`f.createIfStatement(test, block(cons))`, **no else** — DNF's `alt: null` maps to "no
else clause," not an empty `else {}` (`:1046`/`:904-905`); `cons && alt` → full if/else
(`:1047-1048`/`:906-907`).

**A third shape family exists for JSX children** — the `"ir-list-dnf"` handler
(`lookahead/jsx-compiler.ts:1383-1417`, header comment `:8`: "ir-list-dnf → conditional
rendering (ternary / `&&`)"): dead-branch shortcut first (`:1392-1394`, no conditional
node built at all for a resolved test); a structural cons≟alt identity fold by
**print-text comparison** (`:1399-1406`) — independently re-deriving compact-dnf's
Identity rule at the JSX layer, since `ts.JsxChild` has no convenient `eq`; only then a
ternary (`:1408-1415`) — and even that ternary is piped through a post-hoc
ts.Expression rewriter, `optimizeExpr` (`lookahead/helpers.ts:502-549`): unwraps
double-negation and swaps branches (`:513-516`, the De Morgan-isomorphic framing from
`dnf.ts:8-10` made concrete), rewrites `x != null ? x : alt → x ?? alt` (`:521-530`),
collapses `test ? true : false`/`? false : true` → `Boolean(test)`/`!test`
(`:532-533`), and — the literal ternary-vs-`&&` choice — `test ? cons : null → test &&
cons` (`:535-537`). Reconstructs a genuine ternary only if nothing above fired
(`:539-547`).

**Caveat, stated plainly:** `optimizeExpr`'s richer shape search (`??`/`&&`/negate-swap)
is wired only at the JSX-children call site (`jsx-compiler.ts:1416`). The value-position
ternaries from `lowerMaybe`/`lowerDNFTest` in `lower-expr.ts` do not pass through it —
today's if-vs-ternary rule is uniform, but the *further* shape search is not yet applied
everywhere it structurally could be.

## 6. Transfer analysis

**Reusable close to verbatim** (structure, not literal code — arrival compiles Scheme,
not TSX, but none of this machinery contains variant content). `Maybe<T> = T | Dnf<T>`
+ De Morgan framing (`ir1.ts:168-199`, `T` fully generic — this *is* what `(if c a b)`
already is); the three-valued `ExprSemantics` contract + `combineTernary` "meet"
(`semantic-ir.ts:110-284`) and its short-circuit table for literal/`&&`/`||`/`??`/
ternary (`static-evaluate-test.ts:58-236` — variants are explicitly the one thing it
*doesn't* touch, `dnf.ts:25-26`), the direct answer to "how do you fold `(or #t X)`,"
needing re-derivation only at the syntax-dispatch layer (Scheme forms instead of
`ts.SyntaxKind`); the five-rule compact algebra + cost-gate termination proof
(`dnf-compact/index.ts:151-224`, rationale `css-expression-naive-optimizer.md:682`) —
pure term-rewriting over `Maybe<T>`, `variants` a field the rules never inspect; the
positional if-vs-ternary rule + single-arm-if-on-absent-alt (`lower-expr.ts:594-646`,
`lookahead/statements.ts:889-912,1031-1054`), driven by surrounding AST-hole type, not
variant content; and `optimizeExpr`'s ternary↔`&&`↔`??`↔negate shape search
(`lookahead/helpers.ts:502-549`) — pure JS-idiom algebra over any
`ts.ConditionalExpression`.

**Variant-specific, does not transfer** — arrival has no variant lattice, no cascade, no
CSS. `cascadeOrder`/`SELECTOR_RANK`/`compareForEmission`/`compareRanks`
(`ComponentBase.ts:449-496`, `variant-sorting.ts`) are defined in terms of CSS
pseudo-class rank, media thresholds, and per-component precedence — the **need** for a
canonical order (byte-identical confluence output) transfers, this comparator doesn't;
arrival needs its own (e.g. source-position or a structural hash over Scheme conjuncts).
`optimizations/dead-variants.ts` scope-pruning ("impossible" = outside a component's
scope) has no analog — arrival has no "component scope" for an arbitrary boolean
expression. `predicatesAreDisjoint`/`canCoApply`/`isTotalGroup`
(`variant-predicate.ts:107-163`, `lens-helpers.ts:341-348`) prove mutual-exclusion and
domain-coverage over a *finite, enumerable* `VariantGroup` subject; arrival's conditions
range over an unbounded domain, so there's no enumerable set to prove "total" or
"disjoint" over in general — "prove these two conditions can't both hold" is a genuinely
harder problem (real SAT/SMT) here.build didn't solve either; it solved only the
finite-variant special case, and routed that solution to conflict-reporting, not the
fold.

**The single biggest transfer gap:** here.build's fold gets its power from a
**finite, enumerable, provably-total** variant space (`isTotalGroup`,
`lens-helpers.ts:107-111`), which licenses scope-pruning and cross-axis "shadowed base"
folds that have no meaning for arbitrary boolean expressions. The part of the system
that looks like "the DNF folder" to an outside reader — the variant lattice machinery
(`cascadeOrder`, `dead-variants.ts`, `predicatesAreDisjoint`) — is precisely the part
that **doesn't** reach arrival's problem. The part that transfers almost verbatim (the
three-valued expression evaluator, the five-rule compact algebra, the positional
shape-selector) was already variant-agnostic *inside here.build itself* — `variants` is
just an inert field those algorithms carry without inspecting. Arrival's prevaluation
lane can therefore skip building any cascade/scope/mutual-exclusion analog entirely —
there is no here.build-shaped problem to solve there — and should instead invest in (1)
a Scheme-native three-valued literal/`and`/`or`/`if` evaluator (re-deriving
`static-evaluate-test.ts`'s dispatch table over Scheme forms) and (2) its own canonical
serializer for confluence, since it has no cascade to borrow one from.

## 7. Copy / adapt / rebuild table

| Mechanism | here.build location | Verdict | Why |
|---|---|---|---|
| `Maybe<T> = T \| Dnf<T>`, De Morgan framing | `ir1.ts:168-199` | **Copy** (shape) | Fully generic in `T`; zero variant content |
| Three-valued `ExprSemantics` + `combineTernary` | `semantic-ir.ts:110-284` | **Copy** (contract) | General boolean logic; variants explicitly excluded already |
| TS-AST literal/`&&`/`\|\|`/`??`/ternary dispatch table | `static-evaluate-test.ts:58-236` | **Rebuild** (over Scheme forms) | Same table, different concrete syntax (`ts.SyntaxKind` → Scheme tags) |
| 5-rule compact algebra + cost-gate termination | `dnf-compact/index.ts:151-224` | **Adapt** | Rule bodies transfer; only `eq`/conjunct-shape for arrival's `T` differs |
| Eager fold-at-construction discipline (never build a node you'd immediately fold) | `visitors/dnf.ts:72-157` | **Copy** (principle) | Cheapest tier; directly matches "dead branch never even wrapped" |
| Positional if-vs-ternary + single-arm-if | `lower-expr.ts:594-646`, `lookahead/statements.ts:889-912,1031-1054` | **Copy** (rule) / rebuild impl | Rule is purely positional; implementation retargets to arrival's emitter |
| Ternary-shape search (`&&`, `??`, negate-swap) | `lookahead/helpers.ts:502-549` | **Adapt** | Same rewrites apply to any `ts.ConditionalExpression`-producing backend |
| Canonical-ordering *need* (confluence, byte-identical output) | `canonicalize.ts` + `variant-sorting.ts` | **Adapt the need**, rebuild the comparator | CSS cascade comparator is 100% variant-specific; arrival needs its own total order |
| Canonical sub-tree serializer discipline (dispatch-by-kind, not `JSON.stringify`) | `canonical-serialize.ts`, per `css-expression-naive-optimizer.md:689-701` | **Copy** (principle) | Reasoning (stable, cycle-safe, class-aware) transfers even though the kind-list doesn't |
| Scope-based dead-variant pruning | `dead-variants.ts` | **Skip** | No "component scope" concept for an arbitrary boolean expression |
| `predicatesAreDisjoint` / `isTotalGroup` / `canCoApply` | `variant-predicate.ts:107-163`, `lens-helpers.ts:341-348` | **Skip** | Finite-domain proof; no general analog without real SAT/SMT — out of R-G6 scope |
| Lazy memoized second-stage pass via MobX `@computed` | `SemanticModel.ts:527-531` → `shake.ts:127-163` | **Skip / N/A** | That tier exists specifically to re-run scope-pruning reactively; arrival's fold has no equivalent cross-tree scope dependency to re-derive reactively |
