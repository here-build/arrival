# Scheme→TS Type Lens — implementation plan

**Status:** proposal (researched, not built). Author: Claude + V. Date: 2026-06-10.
**Memory:** `project-scheme-ts-type-lens-2026-06-10`. **Couples:** `project-contextual-awareness-magic-2026-06-09`, `project-skeptical-dev-mode-2026-06-09`, the constraint-kernel oracle (`foundations/arrival/arrival-scheme/src/oracle/`).

> One line: **type-check arrival Scheme by lowering it to a virtual TypeScript file, letting TS's own checker/LS do the work, and lifting the diagnostics back onto the `.scm` source via a Volar position-mapping.** It is the whole-program, edit-time *foresight dual* of the per-token generation oracle.

---

## 1. Goal & non-goals

### What the lens IS

- **Edit-time, whole-program type foresight on arrival Scheme.** Open a `.scm`, see red squiggles on `(car 5)` and `(+ "a" 1)` *before running anything*, sourced from TS's checker.
- **An IDE-affordance surface** delivered through Volar: diagnostics first, then hover (show the inferred type of a sub-expr), go-to-definition (jump from a ref to its `define`), and completion (bound symbols + builtin members) — all of which Volar gives "for free" once the virtual-code mapping exists.
- **A bifunctor lens** in the studio's grounding sense (`CLAUDE.md` §"Intent over materialization"): `scheme → virtualTS → diagnostics → scheme`, where the *position* round-trips to identity. The Scheme is the intent; the virtual TS is glass.
- **The realization vehicle for Layer T** of the constraint-kernel oracle. The spec already invites this: *"Same info the type-checks being added need — build the checker so its 'what types-check here' is the mask"* (`sift/docs/CONSTRAINT-KERNEL-SPEC.md:158`). See §10-Q5.

### What the lens is NOT

- **Not the per-token generation oracle.** The oracle (`oracle/contract.ts`) is a *forward, prefix-decidable, per-token* constraint that aligns with autoregressive decoding (`DESIGN INVARIANT: every method is a pure function of the ACCEPTED PREFIX. No lookahead` — `contract.ts:16-17`). The lens is the opposite cut: it needs the *whole* program, runs at *human edit cadence* (~100ms), and answers "is this finished program well-typed" not "what token may come next." They share the *type vocabulary* and *builtin signatures*, not the engine.
- **Not a runtime type system.** It never changes evaluation. `bridge.ts`/`evaluator.ts` stay byte-identical. A program that type-errors still runs (Scheme is dynamically typed); the lens is advisory foresight, an *errors-as-doors* surface.
- **Not a Scheme type-inference engine.** We do **not** write Hindley-Milner for Scheme. We lower to TS and borrow *TS's* inference. The cleverness is entirely in the lowering + the builtin `.d.ts`, never in a bespoke unifier.
- **Not a new evaluator dialect.** No new `.scm` semantics, no annotations required in source (inference-from-usage is the default path). Optional type hints are a later, opt-in nicety (§10-Q3).

---

## 2. Architecture

### 2.1 The pipeline

```
 .scm source
   │
   │  (1) parseSexprs            @here.build/arrival-chain/sweet         [EXISTS]
   ▼
 Node[] forest  (span?:[start,end) on every single-line node)
   │
   │  (2) desugar               arrival-chain-view/src/desugar.ts        [EXISTS, reuse as-is]
   ▼
 core-form forest (spans preserved on synthetic nodes)
   │
   │  (3) resolveNames          arrival-chain-view/src/scheme-scope.ts   [EXISTS, reuse as-is]
   ▼
 nameOf: Map<Atom,string>  (collision-free JS identifiers)
   │
   │  (4) types-emit  ◀── NEW SIBLING EMITTER (the load-bearing new code)
   ▼
 { tsText, segments: Segment<CodeInformation>[] }   (typed TS + per-range provenance)
   │
   │  (5) buildMappings         muggle-string (Astro's 20-line pattern)  [NEW glue, ~20 LOC]
   ▼
 VirtualCode { languageId:"typescript", snapshot, mappings }
   │
   │  (6) LanguagePlugin.createVirtualCode    @volar/language-core       [NEW, boilerplate]
   ▼
 Volar language host  ──▶ @volar/typescript ──▶ ts.LanguageService
   │
   │  (7) getSemanticDiagnostics / quickInfo / definition / completions
   ▼
 TS diagnostics at virtual-TS offsets
   │
   │  (8) Mapper.toSourceLocation  (Volar, FREE)  +  message-lift (NEW)
   ▼
 Diagnostics ON .scm spans, with Scheme-native messages
```

### 2.2 Component inventory

| # | Component | Status | Where |
|---|-----------|--------|-------|
| 1 | `parseSexprs` → `Node[]` with spans | **EXISTS** | `@here.build/arrival-chain/sweet`, exported `sweet.ts:13`. Spans stamped in `sweet-read.ts:134-141`. |
| 2 | `desugar` (macro pre-pass, span-preserving) | **EXISTS** | `arrival-chain-view/src/desugar.ts:22`; `{ ...n, list }` preserves `span` (`desugar.ts:28-29`). |
| 3 | `resolveNames` (binding graph → collision-free JS idents) | **EXISTS** | `arrival-chain-view/src/scheme-scope.ts:113`. |
| 4 | **`types-emit.ts`** — type-faithful TS emitter + span segments | **NEW** | new file in `arrival-chain-view/src/`. The load-bearing work. §4. |
| 5 | `buildMappings` (segments → `CodeMapping[]`) | **NEW glue** | ~20 LOC, Astro's pattern, in `@here.build/arrival-volar`. §3. |
| 6 | `LanguagePlugin.createVirtualCode` | **NEW boilerplate** | `@here.build/arrival-volar`. §6. |
| 7 | `@volar/typescript` host + `ts.LanguageService` | **VENDOR** | `@volar/typescript@2.4.28` (verified on registry). |
| 8 | `Mapper.toSourceLocation` (position lift) | **VENDOR (free)** | `@volar/language-core`. Position mapping is what Volar exists to do. |
| 8b | **message-lift** (TS message → Scheme-native) | **NEW, phased** | §5. v1 = raw message + correct position; later = translated. |
| — | **`arrival-stdlib.d.ts`** — builtin signatures | **NEW (seeded from existing TS fns)** | §4.2. The *real* work after the emitter. |

### 2.3 The emitter decision: NEW SIBLING `types-emit.ts`, not extend `lower.ts`/`python.ts`

**Decision: a new sibling emitter, reusing the entire front-end (parse → desugar → resolveNames).** Rationale:

1. **Run-faithful vs type-faithful diverge at the builtin boundary, irreconcilably.** The existing `lower.ts` is a *materializer*: it emits idiomatic JS that *runs*. `(car xs)` becomes `xs[0]` (`stdlib.ts:67`), `(cdr xs)` becomes `xs.slice(1)` (`stdlib.ts:68`), `cons` becomes `[a, ...b]` (`stdlib.ts:55`). That is correct for *execution* but **wrong for types**: it types `(car xs)` as "element of `xs[]`" via JS array indexing, not as "Scheme `car` applied to a list" — and it erases the numeric tower, pair-vs-array distinction, and entity types entirely. The type-faithful emit must instead reference *arrival's own builtin signatures* (`car<T>(xs: Pair<T,…>): T`), so `(car 5)` is a type error (5 is not a pair) rather than `5[0]` (which TS *also* flags, but for the wrong reason and with a JS-shaped message). The two emitters answer different questions; forcing one to do both means a flag-soup `if (target==="types")` riddled through every `STDLIB[...]` entry and every `UNOP`/`BINOP` table. That is exactly the "make something simple complex" failure `CLAUDE.md` warns against.

2. **The front-end is genuinely shared and clean.** Parse, desugar, and `resolveNames` are pure shape/scope passes with no emit opinion — `assemble.ts:16-26` already composes them independently of the JS-specific `makeLowerer`. The sibling emitter calls the same `desugar(parseSexprs(src))` and `resolveNames(forest, [])`, then walks the *same* `Node` forest with a *different* leaf/application strategy. We share ~60% of the pipeline (everything up to lowering) and fork only the ~600-line emit walk.

3. **There is precedent for a second emitter in this very package.** `python.ts` is already a parallel sibling emitter sharing the front-end (`python.ts:14` imports the same `parseSexprs`; `python.ts:16` the same `desugar`). A third sibling (`types-emit.ts`) is the established shape, not a new pattern. And `prompt.ts` *already emits typed TS interfaces* (`prompt.ts:92` builds an `argType` object type) — type-faithful TS emission is not foreign to this package.

**What `types-emit.ts` reuses vs forks:**

| Front-end pass | Reuse? |
|---|---|
| `parseSexprs` | reuse verbatim |
| `desugar` | reuse verbatim (we *want* macros pre-expanded so they become ordinary typed forms; the residue — true `syntax-rules` macros — emits opaque `unknown`, §4.4) |
| `resolveNames` | reuse verbatim (collision-free idents; the virtual TS needs the same uniqueness the JS emit needs) |
| `lower.ts` walk | **fork** — new application strategy (typed-apply, §4.1) + new builtin reference strategy (`.d.ts`, §4.2) |
| `STDLIB`/`UNOP`/`BINOP` tables | **do not reuse** — these inline run-faithful JS; the type emit references `__arr.car(...)` against the `.d.ts` instead |
| formatting (`format.ts` eslint/prettier) | **must NOT run on the LS-bound text** (it reshuffles positions). §3.3. |

---

## 3. The span-emit extension

### 3.1 What Volar needs

Volar's `VirtualCode` is `{ snapshot: ts.IScriptSnapshot /* the tsText */, mappings: CodeMapping[] }`. A `CodeMapping` is:

```ts
interface CodeMapping {
  sourceOffsets: number[];      // offsets into the .scm
  generatedOffsets: number[];   // offsets into the virtual TS
  lengths: number[];            // run length at each pair
  data: CodeInformation;        // per-range capability gates
}
```

`CodeInformation` gates *which* language features flow through each range:

```ts
interface CodeInformation {
  verification?: boolean;   // do diagnostics from this range surface? (turn OFF for prelude)
  completion?:   boolean;
  semantic?:     boolean;   // hover / inlay
  navigation?:   boolean;   // go-to-def / rename
}
```

This is the exact mechanism Astro uses to map a whole `.astro` → one generated TSX and silence its own scaffolding while surfacing only the user's code.

### 3.2 How `types-emit.ts` produces segments (the muggle-string / Astro pattern)

Instead of building one flat string, the emitter builds a **`Segment[]`** where each segment is either a bare string (prelude/scaffolding, *no* source mapping) or a `[text, sourceOffset, codeInformation]` tuple (a span-tracked piece that maps back to a `.scm` offset). This is `muggle-string`'s `Segment<T>` type (`muggle-string@0.4.1`, verified on registry), and Astro's `buildMappings(segments)` is ~20 lines that folds the segment array into `{ snapshot, mappings }`.

Concretely, the emit walk threads an *output builder* rather than returning strings:

```ts
type Code = Segment<CodeInformation>;           // string | [string, undefined|number, CodeInformation]
const out: Code[] = [];
const lit = (s: string) => out.push(s);                                  // scaffolding, unmapped
const mapped = (s: string, span: readonly [number,number], info: CodeInformation) =>
  out.push([s, span[0], info]);                                          // maps s → .scm[span[0]..]
```

Every `Node` carries `span?:[start,end)` (from §2.2 row 1). When the emitter emits the *user-visible* text for a node (an identifier, a literal, a call's `__arr.car(` prefix), it uses `mapped(text, node.span, {verification:true,...})`; when it emits *scaffolding* (the prelude import, a typed-apply wrapper's punctuation, a `const _scm0 =` binder name we invented), it uses `lit(text)` with **no** mapping, so no diagnostic can land there.

`buildMappings` then walks `out`, accumulating generated offsets, and emits one `CodeMapping` per mapped segment. We adopt Astro's implementation near-verbatim.

### 3.3 The formatting-reshuffle risk — head-on

**Risk:** `arrival-chain-view`'s normal output is run through `eslint --fix` then `prettier` (`project.ts:16`, `format.ts`). Any reformatting *moves bytes* and **invalidates every `generatedOffset`** computed during emit. A squiggle would land on the wrong identifier.

**Mitigation — the two-path split (the Svelte/Astro split):**

- **LS path (the one Volar consumes): UNFORMATTED, span-tracked.** `types-emit.ts` emits the `Segment[]` directly. **No eslint, no prettier ever touches it.** The generated offsets are computed during emit and stay exact. The virtual TS is machine-read, never human-read, so its ugliness is irrelevant — TS's checker does not care about whitespace.
- **Display path (optional, for the "show me the virtual TS" debug affordance): FORMATTED, no mapping.** If we ever want to *show* a human the lowered TS (a Skeptical-Dev-Mode style "here's what we type-checked" panel), we run a *separate* formatted emit with no segment tracking, exactly as `projectToJs` already does. The two paths share the walk but differ in the builder (`Segment[]` vs string + formatter). This is the established split: `projectToJsRaw` (unformatted, `project.ts:21`) vs `projectToJs` (formatted, `project.ts:16`) already exist in this package — we mirror it.

**One-line statement of the invariant:** *the bytes Volar maps are the bytes TS checks; no formatter runs between emit and check.*

### 3.4 The coalesced-multi-line span gap (a real, bounded hole)

`sweet-read.ts:281` notes that coalesced multi-line sweet content gets **no spans** (`base` absent → nodes get no offsets). For *classic* `.scm` source (the scout programs, the format we care about) spans are present (`sweet-read.ts:131-141`). **Mitigation:** a node with no `span` emits via `lit` (unmapped) — its diagnostics simply *don't surface* rather than surfacing at a wrong position (silent-drop, not wrong-door). We measure the coverage hole in the probe (§7); if it bites real programs, the fix is upstream in `sweet-read.ts` (propagate `base` through coalescing), out of scope for v1.

---

## 4. Typed-apply + builtin `.d.ts` strategy

### 4.1 How forms lower (type-faithful)

| Scheme form | Virtual TS | Notes |
|---|---|---|
| `(define x v)` | `const x = <v>;` | `const` (immutable binding). Name from `resolveNames`. |
| `(define (f a b) …)` | `const f = (a: any, b: any) => <body>;` | params start `any`, TS infers usage. |
| `(let ((x i)) body)` | `const x = <i>; <body>` (in a block) | mirrors `letBlock` (`lower.ts:234`). |
| `(set! x v)` | binder switches `const`→`let` | a pre-pass marks `set!`-mutated names; emit `let`. |
| `(lambda (a) body)` | `(a: any) => <body>` | |
| `(if c a b)` | `(<c> ? <a> : <b>)` | TS unions the arms — correct. |
| `(f a b)` *user fn* | `__sexpr(f, <a>, <b>)` OR direct `f(<a>,<b>)` | see typed-apply below. |
| `(car xs)` *builtin* | `__arr.car(<xs>)` | references the `.d.ts` signature, NOT `xs[0]`. |
| `(dict :k v)` | `__arr.dict([["k", <v>]] as const)` | precise object via `Dict<Pairs>`, see §4.3. |
| `(:field obj)` / `(@ Field obj)` | `__arr.field(<obj>, "field")` | accessor; with a known row type, narrows. §4.3/§10-Q5. |
| quoted datum | mirrors `lowerQuote` (`lower.ts:345`) | symbol→string literal, list→tuple. |
| true `syntax-rules` macro call | `(undefined as unknown)` | opaque, §4.4. |

**Typed-apply.** For a *user-defined* function we can emit the call directly: `f(<a>, <b>)` — TS already knows `f`'s inferred signature from its `const f = (...) => ...`. The `__sexpr<F>` wrapper from the memo:

```ts
declare function __sexpr<F extends (...a: any[]) => any>(f: F, ...args: Parameters<F>): ReturnType<F>;
```

is the *fallback for higher-order positions* where the head is a value of unknown arity (`(apply f args)`, a function passed as a param). For the common direct call, plain `f(<a>,<b>)` gives sharper errors and better hover. **Decision: emit direct calls for resolvable heads; `__sexpr` only for indirect/HOF heads.** (Direct calls give TS the real parameter names for completion; `__sexpr` is the safety net.)

### 4.2 Which builtins to type first, and reuse-vs-author

**The central finding from reading the source:** arrival's builtins are today **uniformly `(...args: any[]) => any`**. In `sandbox-env.ts` every entry is `(list: any) => …`, `(...args: any[]) => …` (e.g. `car: (list: any) => …` at `sandbox-env.ts:193`, `max: (...args: any[]) => …` at `:326`). The rosetta wrappers in `rosetta.ts:51` are `type Fn = (...args: any[]) => any`. **This means: if we point the virtual TS at the *existing* TS signatures, every builtin comes back `any` and TS bites on almost nothing.** This is the memo's predicted "all-`any`" outcome, and it tells us where the real work is.

**Therefore the `.d.ts` is hand-authored, seeded *structurally* (not by import) from the existing fns.** We write `arrival-stdlib.d.ts` declaring a sharpened signature per builtin. The *implementations* in `sandbox-env.ts`/`bridge.ts` stay `any` (runtime correctness is already proven by tests; sharpening them risks regressions in the numeric-tower/membrane code). The `.d.ts` is a *separate type surface* the lens references — exactly the "`.d.ts` is the seed, but the seed is loose, so the work is sharpening" the memo predicted.

**The top ~20-30 to type first (highest type-foresight value per signature):**

```ts
// Pairs / lists — the core of every scout program
declare const __arr: {
  car<T>(xs: readonly T[]): T;
  cdr<T>(xs: readonly T[]): T[];
  cons<H, T>(h: H, t: readonly T[]): (H | T)[];
  first<T>(xs: readonly T[]): T;
  second<T>(xs: readonly T[]): T;
  list<T extends unknown[]>(...xs: T): T;
  length(xs: readonly unknown[] | string): number;
  // higher-order — where typed-apply earns its keep
  map<T, U>(f: (x: T) => U, xs: readonly T[]): U[];
  filter<T>(f: (x: T) => boolean, xs: readonly T[]): T[];
  reduce<T, A>(f: (acc: A, x: T) => A, init: A, xs: readonly T[]): A;
  // numbers (tower deferred to branded, §4.5 — v1 = number)
  "+"(...xs: number[]): number;
  "-"(...xs: number[]): number;
  "*"(...xs: number[]): number;
  "<"(...xs: number[]): boolean;
  "zero?"(n: number): boolean;
  // strings
  "string-append"(...xs: string[]): string;
  "string-length"(s: string): number;
  "string-upcase"(s: string): string;
  // entity accessors — the sift moat (point at real row types when known, §10-Q5)
  dict<P extends readonly (readonly [string, unknown])[]>(pairs: P): Dict<P>;
  // predicates → boolean
  "null?"(xs: readonly unknown[]): boolean;
  "equal?"(a: unknown, b: unknown): boolean;
};
```

This is ~30 signatures. `car`/`cdr`/`map`/`filter`/`+`/`<` alone make `(car 5)`, `(+ "a" 1)`, `(map car 5)`, `(filter add1 xs)` all bite — the canonical demos. **Author vs reuse:** all 30 are *authored* (the existing fns give the runtime contract and the JSDoc, but the TS types are `any`, so there is nothing precise to import). Effort: ~1 signature/2min once the harness is up; the corpus of scout programs tells us *which* 30 actually appear (measure in the probe, §7).

**Naming/identifier note.** Scheme builtins have names illegal in TS (`car`, `+`, `string-append?`, `null?`). The emit references them as **bracketed members of `__arr`** (`__arr["string-append"]`, `__arr["+"]`) — so no identifier cleaning is needed for builtins, and the `.d.ts` keys can be the literal Scheme names. User bindings still go through `resolveNames` for clean idents. This cleanly separates the two namespaces.

### 4.3 The `Dict<Pairs>` precise-object pattern

`(dict :name "x" :age 30)` desugars/emits to a tuple of key-value pairs, and the `.d.ts`'s `dict<P>` maps it to a precise object type:

```ts
type Dict<P extends readonly (readonly [string, unknown])[]> =
  { [E in P[number] as E[0]]: E[1] };
```

So `(dict :name "x" :age 30)` types as `{ name: string; age: number }` — and a downstream `(:missing d)` (or `(@ missing d)`) is a *property-does-not-exist* error at the right Scheme span. This is the homoiconic-dict → precise-object trick from the memo, verified to work for literal tuples. The accessor `(:field obj)` emits `__arr.field(obj, "field")` where `field`'s `.d.ts` is `<O, K extends keyof O>(o: O, k: K) => O[K]` — so the field name is constrained to the dict's actual keys. **This is the type-system realization of the spec's keystone A4** (`(@ Field row)` masks to the row's field set, `CONSTRAINT-KERNEL-SPEC.md:171-176`).

### 4.4 Macros → opaque `unknown`

`desugar` pre-expands the authoring sugar (`cut`, `->`, `cond`, `when`, …) into core forms, so those flow through as ordinary typed forms (a `(-> x f g)` becomes nested calls TS checks fully). The residue is *true* `syntax-rules`/`define-syntax` macros the lens cannot see through. **Decision: a call whose head resolves to a known macro emits `(undefined as unknown)`** — opaque, never a false error. We over-approximate to `unknown` rather than guess. A node tagged macro-headed also gets `{verification:false}` on its arguments (don't surface diagnostics computed against an opaque head). This is the *honest-bounds* discipline the oracle spec demands (`CONSTRAINT-KERNEL-SPEC.md:183-187`: "return null where it cannot be decided, never a wrong constraint").

### 4.5 The numeric-tower question — defer, with a partial

arrival has a real numeric tower (`SchemeExact`/`SchemeInexact`, `numbers.ts`, rationals/bignums). Modeling it precisely in TS needs **branded types** (`type Exact = number & {__exact:true}`) and a branded arithmetic algebra — significant, and most of its value (catching `(/ 1 0)`-class or exact/inexact-contamination bugs) is niche for scout programs.

**Decision: v1 types all numbers as `number`.** This catches the high-value `(+ "a" 1)` / `(< x "s")` errors (string-in-numeric-position) — the 90% case. The branded tower is a **named later phase** (§8 Phase 5), gated on whether real programs surface exact/inexact bugs (measure demand; don't pre-build). This matches the model-design rule (`CLAUDE.md`: "Can it be derived? Is this complexity inherent or am I adding it?").

---

## 5. The message-lift (errors-as-doors)

Volar maps the **position** for free. It does **not** translate the **message text**. A raw TS diagnostic against the virtual TS reads like:

> *Argument of type `'string'` is not assignable to parameter of type `'number'`.* — on `__arr["+"]`'s second arg.

The Scheme author never wrote `__arr["+"]`; they wrote `(+ x "two")`. The message leaks the materialization (a `straightjacket`, in `CLAUDE.md` terms).

**Phasing (errors-as-doors skill applies — this is a boundary rejection an author/agent consumes):**

- **v1 — raw message + correct position.** Ship the TS message verbatim, lifted to the right `.scm` span. Decisively useful already: *the squiggle is on the right token*, and the message, while TS-flavored, is usually legible ("not assignable to number"). Gate-free, zero translation code.
- **v2 — a message-translation table keyed by (TS diagnostic code, emit-site tag).** The emitter tags each mapped segment with a *role* in `CodeInformation` (extend with a custom `data.role: "builtin-arg" | "user-call" | "accessor" | …` field — Volar passes arbitrary `data` through). A small translator rewrites the common diagnostic codes (`2345` argument-not-assignable, `2339` property-does-not-exist, `2554` wrong-arg-count) into Scheme-native sentences: *"`+` expects numbers; the 2nd argument here is a string"* / *"`row` has no field `:foo`; did you mean `:bar`?"* The translation reads the role tag + the underlying types from the diagnostic's related-information. This is a finite table (~10 codes cover the bulk), authored against the *follow-rate* discipline (does the door route the author correctly?).
- **later — quick-fixes / code actions.** "Did you mean `:bar`" with an apply-fix, surfaced through Volar's code-action plumbing. Out of scope for the build; noted as the natural extension.

**v1 ships without the translator.** The translator is the "residual craft" the memo flagged — real, bounded, and *position-independent* (Volar already nailed position), so it can land incrementally without re-architecting.

---

## 6. The Volar package — `@here.build/arrival-volar`

New workspace package. Dependency-light (Volar is the only new vendor).

### 6.1 What it contains

| File | Status | Content |
|---|---|---|
| `language-plugin.ts` | **custom (small)** | A `LanguagePlugin<string>` whose `createVirtualCode(id, langId, snapshot)` calls `types-emit.ts` on the `.scm` text, runs `buildMappings`, and returns a `VirtualCode{languageId:"typescript", snapshot, mappings}`. ~40 LOC. |
| `build-mappings.ts` | **vendored pattern** | Astro's `buildMappings(segments)` → `CodeMapping[]`. ~20 LOC. |
| `prelude.ts` | **custom (small)** | The `arrival-stdlib.d.ts` text + the `__sexpr`/`Dict` declarations, prepended (unmapped) to every virtual file. |
| `server.ts` | **boilerplate** | `@volar/language-server` wiring: `createServer`, register the language plugin + the TS service plugin (`@volar/typescript`). This is the standard Volar LSP entry; ~60 LOC of mostly-copied glue. |
| `package.json` / `tsconfig` | boilerplate | deps: `@volar/language-core@2.4.28`, `@volar/typescript@2.4.28`, `@volar/language-server@2.4.28`, `muggle-string@0.4.1`, `typescript`, `@here.build/arrival-chain-view` (workspace:^). |

### 6.2 Boilerplate vs custom split

- **Boilerplate (Volar gives it):** the LSP server loop, diagnostic/hover/definition/completion *routing*, the TS service plugin, position mapping (`Mapper.toSourceLocation`), the `IScriptSnapshot` plumbing. We write *none* of this; we register a `LanguagePlugin` and Volar does the rest. This is precisely why Volar is the substrate and a raw TS LS plugin is not (a raw plugin *cannot own* a `.scm` file — confirmed in the research; it only augments files TS already parses).
- **Custom (ours):** `createVirtualCode` (call our emitter), the prelude `.d.ts`, the `CodeInformation` gating, and (phased) the message-lift. The emitter (`types-emit.ts`) lives in `arrival-chain-view` (it's a third sibling emitter); `arrival-volar` is the thin Volar shell around it.

### 6.3 Clients

- **VS Code extension** (thin: `vscode-languageclient` pointing at `server.ts`) — the human IDE story.
- **MCP tool** (`arrival/typecheck`) — run the lens headless, return diagnostics on `.scm` spans as a structured payload. This reuses `server.ts`'s diagnostic path without the LSP transport (call `getSemanticDiagnostics` + the mapper directly). **This is the higher-priority client** (here.build is MCP-first; agents author the Scheme — `CLAUDE.md` "Actor corollary"). The VS Code ext is the human nicety. See §10-Q1.

> **Keep separate from `foundations/mcp-typescript-lsp/`.** That package wraps `ts.createLanguageService` reading `.ts` from *disk* with no virtual/in-memory injection (`mcp-typescript-lsp/src/`) — it's for agents querying *existing* TS, not for owning a synthetic `.scm`-backed virtual file. Different job. `arrival-volar` is the substrate; `mcp-typescript-lsp` stays as-is.

---

## 7. Validation: the probe FIRST

**The probe gates the entire effort.** It is cheap (~half a day) and answers the one question that decides go/no-go: *do the builtin signatures bite, or does everything come back `any`?*

### 7.1 Probe spec

1. **Input:** ~5 real scout programs (from `sift/src/mcp/scout.ts` few-shots / the example `.scm` corpus — pick ones using `car`/`cdr`/`map`/`filter`/`+`/accessors).
2. **Reuse the front-end:** `desugar(parseSexprs(src))` → `resolveNames(forest, [])`. No new code here.
3. **Hand-emit (not the full emitter — a minimal walk):** uniform `const`/`__sexpr`/`__arr.car` TS carrying span tuples, prepended with a *hand-written* ~30-signature `arrival-stdlib.d.ts` (§4.2).
4. **Point tsserver at it:** feed the emitted string to a bare `ts.createLanguageService` over an in-memory host (no Volar yet — the probe tests the *types*, not the IDE plumbing) and call `getSemanticDiagnostics`.
5. **Inject two known errors** into a copy: `(car 5)` and `(+ "a" 1)`.

### 7.2 Pass/fail

| Assertion | Pass means | Fail means |
|---|---|---|
| Clean programs → **0 diagnostics** | the emit is well-formed; no false positives | the emit/`.d.ts` is buggy (false errors) — fix before proceeding |
| `(car 5)` → **a diagnostic** | `car`'s `<T>(xs: readonly T[]):T` bites on `5` | **the builtins don't bite** — signature-sharpening is the *whole* job, re-scope |
| `(+ "a" 1)` → **a diagnostic** | numeric builtins bite on strings | same as above |
| The diagnostic offset, lifted through the span tuple, lands on the **right `.scm` token** | position-lift works (validates §3 before Volar) | span tracking is wrong — fix the segment plumbing |

### 7.3 What each outcome means

- **Bites cleanly → GO.** The architecture is sound; the rest is the emitter + the `.d.ts` breadth + Volar shell. Proceed to Phase 1.
- **All `any` → the real work is signature-sharpening, not plumbing.** Expected partially (the existing fns are `any`); the probe quantifies *how many* of the top-30 need authored signatures to bite, and confirms authored signatures *do* bite (write 5 by hand, re-run). This is the most likely outcome and it's fine — it just relocates the effort from "is this possible" to "type 30 builtins."
- **Wrong-position squiggles → the span plumbing is the risk, not the types.** Fix `buildMappings`/segment tracking before building the Volar shell (cheaper to debug in the probe than through the LSP).

> The probe deliberately *skips Volar* — it isolates the two real risks (do types bite, do spans lift) from the IDE boilerplate. Volar's position mapping is known-good (Vue/Astro/Angular ship it); no need to validate it in the probe.

---

## 8. Phased milestones

| Phase | Deliverable | Effort | Gate |
|---|---|---|---|
| **0 — Probe** | §7. Bare tsserver + hand-emit + 30-sig `.d.ts`, assert `(car 5)`/`(+ "a" 1)` bite and lift. | ~0.5 day | **GO/NO-GO.** |
| **1 — Minimal lens (diagnostics only)** | `types-emit.ts` (full walk, top-20 builtins typed) + `buildMappings` + `LanguagePlugin` + `server.ts`. Diagnostics on `.scm` via MCP tool. **v1 raw messages.** | ~1 week (matches memo's "~1wk working prototype") | red squiggles on real scout programs; 0 false positives on the corpus. |
| **2 — IDE features** | Hover (inferred type of sub-expr), go-to-def (ref → `define`), completion (bound symbols + `__arr` members + dict keys). **All free from Volar once mappings exist** — mostly `CodeInformation` gating + VS Code ext. | ~3 days | hover shows a real type; def jumps to the right `.scm` span. |
| **3 — Message translation** | The (code, role) → Scheme-native table (§5 v2). ~10 diagnostic codes. | ~2-3 days | `(+ x "s")` reads *"`+` expects numbers; 2nd arg is a string"*. |
| **4 — `.d.ts` breadth** | Type the full builtin surface the corpus uses (measure-driven, not exhaustive). Entity/row types wired for `(@ Field row)` (the A4 keystone, §4.3). | ongoing, ~1 day/30 sigs | accessor field typos bite. |
| **5 — Numeric tower (optional)** | Branded `Exact`/`Inexact` + branded arithmetic, *iff* real programs surface exact/inexact bugs. | ~3-5 days, **deferred** | demand-gated. |

**Total to a genuinely useful MCP-tool lens (Phases 0-1): ~1.5 weeks.** IDE polish + messages (Phases 2-3): another ~1 week.

---

## 9. Risks & mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Formatting reshuffles positions** → squiggles land wrong. | high | The two-path split (§3.3): LS path is *never* formatted; offsets computed during emit are exact. Statement of invariant: bytes-mapped = bytes-checked. |
| R2 | **Builtins come back `any`** → nothing bites. | high (likely) | Expected. The hand-authored `.d.ts` (§4.2) *is* the work; the probe (§7) quantifies it and proves authored sigs bite. The `.d.ts` is separate from the `any` runtime impls (no regression risk to `bridge.ts`). |
| R3 | **Macro opacity** → forms the lens can't see through. | medium | `desugar` pre-expands the sugar (most macros gone); true `syntax-rules` → opaque `unknown` + `{verification:false}` on args (§4.4). Honest-bounds: never a wrong error. |
| R4 | **Instantiation limits on big programs** (depth/count). | medium | Depth cap is 500 (TS4.5+), handles ~100-level nesting; wide unions (the `count` limit) are the real ceiling. Mitigation: emit `__sexpr` (which collapses to `ReturnType<F>`, not a deep instantiation) for HOF heads; cap `Dict` pair-list width with a fallback to `Record<string,unknown>` past N pairs. Measure on the largest scout program in the probe. |
| R5 | **Cryptic messages** leak the materialization. | medium | v1 ships raw message + *correct position* (already useful); the translator (§5 v2) is incremental and position-independent. |
| R6 | **Run-faithful vs type-faithful emitter divergence** → two emitters drift. | medium | They *intentionally* diverge (different questions, §2.3) and share only the front-end (parse/desugar/scope), which is pure and tested. The shared front-end is the contract; the emitters are independently testable (snapshot the type-emit output on the corpus). A divergence in the *front-end* would break both → caught by either's tests. |
| R7 | **Coalesced-multi-line spans missing** (`sweet-read.ts:281`). | low | Unmapped → silent-drop (no diagnostic) not wrong-door. Classic source has spans. Measure coverage in probe; upstream fix if it bites. |
| R8 | **`set!` mutation** breaks `const` emit. | low | A pre-pass marks `set!`-targeted names → emit `let`. Cheap (one walk). |
| R9 | **Volar API churn** (2.x still moving). | low | Pin `@volar/*@2.4.28` (verified on registry); the surface we use (`LanguagePlugin`, `VirtualCode`, `CodeMapping`) is stable and shipped by Vue/Astro/Angular. Per `.claude/rules/npm-version-pinning.md`, pinned versions verified against the registry. |

---

## 10. Open questions for V

1. **Primary client: MCP-tool first, VS Code ext second?** here.build is MCP-first and agents author the Scheme (`CLAUDE.md` Actor corollary), so the headless `arrival/typecheck` MCP tool seems the higher-value v1, with the VS Code extension as a human nicety on the same Volar core. **Leaning: MCP-tool first.** Confirm?
2. **How far to push the `.d.ts` breadth in v1?** Top-20 (car/cdr/cons/map/filter/+/-/</string-*/predicates/dict/accessor) makes the canonical demos bite. The long tail (every builtin in `bridge.ts`) is measure-driven. **Leaning: top-20 + whatever the corpus actually uses, not exhaustive.** Agree?
3. **Optional in-source type hints?** Should authors be *able* to write a type annotation (a `:: Number` comment, a `(the Number x)` form) that the lens honors, or is inference-from-usage the only path? **Leaning: inference-only for v1** (no new `.scm` surface; honors the model-design "don't add to the model" rule). Defer hints to demand.
4. **Numeric tower — build the branded version, or leave all-`number` indefinitely?** Phase 5 is demand-gated. Do you expect real scout programs to surface exact/inexact bugs, or is string-in-numeric-slot the only error class that matters? **Leaning: defer until a real bug demands it.**
5. **Unify Layer T with this lens, or keep them separate?** The spec explicitly invites it (`CONSTRAINT-KERNEL-SPEC.md:158`: "build the checker so its 'what types-check here' is the mask"). But the engines are opposite cuts (whole-program vs prefix-decidable per-token, §1). The realistic shared asset is the **builtin signature vocabulary** (`.d.ts` ↔ `signatureOf` in `oracle/env.ts:69`, which currently returns `null`). **Leaning: share the *signature source* (one authored table feeds both the `.d.ts` and the oracle's `signatureOf`), keep the *engines* separate.** This lets the lens land standalone while seeding Layer T. Worth the coupling, or keep fully independent for now?
6. **Where does `types-emit.ts` live — `arrival-chain-view` (as a 3rd sibling emitter) or a new package?** **Leaning: in `arrival-chain-view`** (shares the front-end, mirrors `python.ts`), with `arrival-volar` as the thin Volar shell. Confirm the package boundary.

---

## Appendix — evidence (file:line)

- Spans on parse nodes: `foundations/arrival/arrival-chain/src/sweet-read.ts:131-141` (classic), `:281` (coalesced gap); type `sweet-render.ts:28-29`.
- `parseSexprs` export: `foundations/arrival/arrival-chain/src/sweet.ts:13`.
- `desugar` span-preserving: `arrival-chain-view/src/desugar.ts:22,28-29`.
- `resolveNames` binding graph: `arrival-chain-view/src/scheme-scope.ts:113`.
- Front-end composed independently of JS emit: `arrival-chain-view/src/assemble.ts:16-26`.
- Run-faithful builtin lowering (the divergence): `arrival-chain-view/src/stdlib.ts:55,67-68` (`cons`/`car`/`cdr`), `lower.ts:234` (`letBlock`), `lower.ts:345` (`lowerQuote`).
- Second sibling emitter precedent: `arrival-chain-view/src/python.ts:14,16`.
- Typed-TS emission precedent: `arrival-chain-view/src/prompt.ts:92` (`argType` object type).
- Two-path format split precedent: `arrival-chain-view/src/project.ts:16` (formatted) vs `:21` (raw).
- Builtins are `any`: `arrival-scheme/src/sandbox-env.ts:193,326,330` ; `rosetta.ts:51` (`type Fn = (...args:any[])=>any`).
- Oracle is per-token/prefix (the dual): `arrival-scheme/src/oracle/contract.ts:16-17`.
- `signatureOf` returns null today (the Layer-T seam): `arrival-scheme/src/oracle/env.ts:69`.
- Layer T invites the unification: `sift/docs/CONSTRAINT-KERNEL-SPEC.md:153-160`; A4 keystone `(@ Field row)`: `:171-176`; honest-bounds: `:183-187`.
- Volar packages verified on registry: `@volar/language-core@2.4.28`, `@volar/typescript@2.4.28`, `@volar/language-server@2.4.28`, `muggle-string@0.4.1`.
