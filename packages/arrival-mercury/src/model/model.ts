/**
 * SchemeSemanticModel — the class skeleton. E0-RED STATE: every spine member
 * throws `Unimplemented`; the red suite (`__tests__/model-spine.test.ts`)
 * pins the design as `it.fails` rows that un-red one by one as views land
 * (the corpus's self-firing promote convention).
 *
 * v1 constructor takes (source, registry): the capability composition is
 * already harvested into an EmitRegistry everywhere this package works; the
 * full `(source, capabilities)` constructor lands with the interpreter
 * wiring phase (`interpreter.run(model, …)`), when the model re-homes toward
 * arrival core.
 *
 * ── E0: the compiler-view stratum (engine plan §2 E0) ───────────────────────
 * Alongside the (untouched) provenance spine below, this class also carries
 * the first COMPILER views: `coreform` (already landed), `narrowsMembers`,
 * `factsAt`/`factsMap`, `registryRow`, `importsOf`. Two disciplines, both
 * deliberate departures from plan §1 S4's literal infrastructure — flagged
 * here for review, not silently applied:
 *
 *  - Every new member is a plain INSTANCE FIELD (an arrow-function or a
 *    directly-assigned value) — never `get foo()`/`foo() {}` method syntax.
 *    `model-spine.test.ts`'s R11 row polices the class PROTOTYPE as an exact
 *    allow-list (spine members only); instance fields never reach the
 *    prototype (verified: `coreform` itself is already one), so the
 *    compiler-view stratum grows without that test needing an edit. Truly
 *    internal helpers below follow the SAME field-not-method discipline,
 *    TS-`private` rather than native `#`-private: `#` needs `tslib`'s
 *    brand-check helper under this package's `importHelpers: true` (verified
 *    by an isolated repro — required even at this package's ES2024 target,
 *    and `tslib` is not one of its dependencies), so a bare `#` would add a
 *    real runtime dependency purely for a privacy guarantee the field-only
 *    discipline already provides for free.
 *  - Memoization is plain (`WeakMap`, a lazily-filled private field), not
 *    mobx's `ComputedWeakMap` (S4's named mechanism). This is a conscious
 *    deferral: v1's constructor takes an IMMUTABLE `(source, registry)`
 *    snapshot, so nothing mutates within one instance's lifetime and there is
 *    no invalidation source for mobx's reactivity to buy anything —
 *    `ComputedWeakMap.get()` would compute once and cache forever, identical
 *    to the plain `WeakMap` below, at the cost of a new runtime dependency
 *    (mobx + `@here.build/collections`) this package doesn't otherwise carry.
 *    The SEMANTIC property S4 asks for — "memoization-on-immutability IS the
 *    semantics" — is what's implemented; swapping in the literal mobx
 *    mechanism later (E4, when the model gains an actual mutation to react
 *    to) is call-site-invisible. `./types.js`'s own header makes the same
 *    call for the spine's v1 ("no mobx… wraps this in the editor phase").
 */
import type { App, ClassifyResult, CoreForm, NodeId } from "../coreform/types.js";
import { classify } from "../coreform/classify.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { asyncnessOf } from "../naming/asyncness.js";
import type { AsyncnessFacts } from "../naming/asyncness.js";
import { bindingCensusOf } from "../naming/census.js";
import { sharedBindingsOf } from "../naming/shared-bindings.js";
import type { BindingCensus } from "../naming/types.js";
import type { SharedBindingsView } from "../naming/shared-bindings.js";
import { idiomDecisionAt, maxNodeId, programShadowsPeepholeNames } from "../peepholes/index.js";
import type { EmitRegistry, EmitRegistryRow } from "../registry/harvest.js";
import type { CompilationUnit } from "../residual/types.js";
import { narrowsMembersOf } from "../type-emit/narrows.js";
import type { FactsExtraction } from "../typefacts/facts.js";
import { extractFacts } from "../typefacts/extract.js";
import { runtimeRefsOf, walk } from "../walker/walk.js";
import type {
  Anchor,
  AnchorPort,
  Chain,
  ChainProgram,
  DemandGraph,
  EdgeKey,
  RunnableSlice,
  Transfer,
  WireUneval,
} from "./types.js";

// `TypeFacts` is arrival core's canonical, dependency-free vocabulary (never
// re-defined here — typefacts/facts.ts's own header forbids the adaptation
// layer); imported directly, matching how walker/walk.ts already does it.
import type { TypeFacts } from "@here.build/arrival/emit";

/** Thrown by every not-yet-landed view — the red suite's expected signal. */
export class Unimplemented extends Error {
  constructor(view: string) {
    super(`SchemeSemanticModel.${view}: unimplemented (E0 red state — see model-spine.test.ts)`);
    this.name = "Unimplemented";
  }
}

export class SchemeSemanticModel {
  readonly source: string;
  readonly registry: EmitRegistry;

  /** Stratum 0 — already-landed machinery, wrapped (the one green part of E0-red). */
  readonly coreform: ClassifyResult;

  /**
   * Every harvested symbol carrying a Law-N `narrows` declaration
   * (registry-emit.md; `type-emit/narrows.ts`, wrapped verbatim). No LSP
   * consumer of its own — it feeds `factsAt`/`factsMap`'s own extraction, the
   * narrowing-form grammar's key set. Compiler consumer: `extractFacts` (Law
   * N), same as today.
   */
  readonly narrowsMembers: ReadonlySet<string>;

  /**
   * Per-node type facts (typefacts-extraction.md), read behind the LS epoch —
   * one whole-program TS Program/LanguageService build, lazily materialized
   * on first query and cached for the model's lifetime (the private `facts`
   * field below). LSP consumer: hover (S4: "hover (factsAt + the registry
   * row's contract)").
   * Compiler consumer: the walker's Law T `truthTest` / Law A arg-gating /
   * registry rules' fact-directed branches (`null?`/`pair?`'s clean form).
   */
  readonly factsAt: (node: CoreForm) => TypeFacts | undefined;

  /**
   * The whole-program fact table `factsAt` reads from — exposed because
   * `walk()`'s existing `WalkOptions.facts` takes the raw
   * `ReadonlyMap<NodeId, TypeFacts>` (a signature E0 does not change; "the
   * pipeline's passes stay, they just read from the model"). Same lazy
   * extraction as `factsAt`, not a second one. No LSP consumer of its own —
   * `factsAt` is the point-query surface; this is the pass-facing companion.
   */
  readonly factsMap: () => ReadonlyMap<NodeId, TypeFacts>;

  /**
   * Contract row for a harvested registry symbol (registry-emit.md) — a thin
   * wrap over `registry.lookup` (already an O(1) `Map` hit; a second cache
   * layer here would earn nothing). LSP consumer: completions detail (a
   * builtin's signature/doc). Compiler consumer: the walker's §4.2 dispatch
   * ladder (rule / eta / shim / door) and `importsOf` below.
   */
  readonly registryRow: (name: string) => EmitRegistryRow | undefined;

  /**
   * THE FIRST RECURSIVE DECISION-VIEW (engine plan §2 E0): the runtime-module
   * import symbols `node`'s own subtree requires. LSP consumer:
   * organize-imports (once emission splits per-artifact, E4). Compiler
   * consumer: the E1b import materializer (`naming/imports.ts`'s
   * `materializeImports`, driven by `oracle/harness.ts`'s
   * `compileGreenfield`) — imports are emitted FROM this view; the `frame`
   * post-pass that used to recompute the same knowledge from the walked tree
   * post-render is DELETED (E1b, engine plan §2).
   * `src/__tests__/model-imports-agree.test.ts` pins this view's answer
   * against the actual emitted import list as the standing regression guard.
   *
   * Implementation deliberately delegates to the SAME `walk()`/
   * `runtimeRefsOf()` machinery `frame`'s census is built from, scoped to
   * `node`'s own subtree (a synthetic one-form "program") — never a
   * hand-rolled re-derivation of the §4.2 rule ladder, so it can never drift
   * from the walker's actual dispatch as rules grow (a rule may mint zero or
   * more `RuntimeRef`s via `ctx.runtime(...)`, decided by facts the walker
   * already has — re-deriving that decision procedure here would duplicate
   * it, dishonestly, the moment a future rule's policy changes).
   *
   * One honest, documented limit (Law F: never wrong, always visible), not
   * hidden behind a green test: a symbol lexically bound only by a scope
   * OUTSIDE `node` resolves here as free — harmless UNLESS that outer binding
   * happens to SHADOW a real registry name (an adversarial pattern absent
   * from today's corpus): a free symbol either finds a registry row or
   * doors, it never invents a WRONG `RuntimeRef`, so this is an
   * over-approximation risk, never a silent-wrong one.
   *
   * DISSOLVED at E2 (engine plan §2 E2, the second half): this view used to
   * carry a SECOND limit — it answers for exactly the node it is HANDED, so a
   * caller querying `sm.coreform`'s own (pre-peephole) forms would see the
   * WRONG census once the peephole pass folded a symbol (`infer` →
   * `infer/scalar`), and `oracle/harness.ts`'s `compileGreenfield` had to
   * work around it by querying over the PEEPHOLED forms instead — a
   * caller-side rule pinned by `model-imports-agree.test.ts`. That rule is
   * gone along with the pass it existed to route around:
   * `computeImportsOf`'s own synthetic walk (below) now consults `idiomAt`
   * exactly like the real pipeline's walk does, so `importsOf`'s answer over
   * `sm.coreform`'s ORIGINAL forms already agrees with the emitted imports —
   * the view and the tree agree BY CONSTRUCTION, not by a call-site
   * discipline a future caller could forget.
   */
  readonly importsOf: (node: CoreForm) => ReadonlySet<string>;

  /**
   * E2's idiom decision-view (engine plan §2 E2, second half): "the peephole
   * pair become… idiom decision views (`sm.idiomAt(node)`) — decided
   * pre-census". Given an `App`, answers the cross-node idiom rewrite the
   * dissolved `peephole()` PASS used to apply eagerly (infer-scalar-fold,
   * cache-key-elide — `../peepholes/`) — or `undefined`. The WALKER consumes
   * it inline (`../walker/walk.ts`'s `lowerApp`, at the top of its §4.2
   * dispatch ladder) instead of the tree having been pre-rewritten; this
   * view's OWN synthetic walk (`computeImportsOf`, below) passes the SAME
   * function, so `importsOf` and the real emission path can never disagree
   * about which symbols a folded call needs (see `importsOf`'s own doc,
   * just above, for the caller-side rule this dissolves).
   *
   * Memoized per node identity (a `WeakMap`, matching `importsOf`'s own
   * discipline) — `inferScalarFold`'s recursive lookup on its inner call
   * (`../peepholes/index.ts`'s `idiomDecisionAt`, the `recurse` dependency)
   * re-enters THIS same memoized entry point, never a private second
   * traversal. `idiomShadowed`/`nextIdiomId` below are the two per-model,
   * lazily-computed pieces of state `idiomDecisionAt` needs but does not own
   * (the whole-program shadow verdict — computed ONCE, not per query — and a
   * monotonically-increasing id-mint floor seeded above every id
   * `classify()` produced): both are exactly the state the dissolved
   * `peephole()` pass used to thread through a single whole-tree call,
   * now threaded through a per-node view instead. No LSP consumer of its own
   * yet (a hover/inlay-hint surface showing "this compiles to `infer/scalar`"
   * is the natural one); compiler consumer: `walker/walk.ts`'s `lowerApp`,
   * this view's own `computeImportsOf`.
   */
  readonly idiomAt: (node: App) => App | undefined;

  /**
   * E2's sharing decision-view (engine plan §2 E2, second half): "CSE…
   * become… sharing… decision views (`sm.sharedBindingsOf(unit)`) — decided
   * pre-census so shared bindings get named like everything else". Given a
   * walked (post-`walk()`, fully-materialized-name) `CompilationUnit`,
   * answers WHICH pure-region common-subexpression groups are shareable
   * (provenance/cacheClass-gated — the exact eligibility rule the dissolved
   * `legibility/cse.ts` pass read off `this.registry`, ported verbatim) —
   * the DECISION only; `../naming/shared-bindings.ts`'s
   * `materializeSharedBindings` is the mechanical commit (splice the hoisted
   * `Const`s, substitute occurrences, then route their NAMES through the
   * SAME `bindingCensusOf`/`allocateNames` machinery E1a's naming phase
   * uses — "real allocated names", not a bespoke glue-minting helper). A
   * THIN wrap over `sharedBindingsOf` — the SAME "delegate to the same
   * machinery" discipline as every other view above. No LSP consumer of its
   * own yet; compiler consumer: `oracle/harness.ts`'s `compileGreenfield`.
   */
  readonly sharedBindingsOf: (unit: CompilationUnit) => SharedBindingsView;

  /**
   * E1a's global binding census (engine plan §2 E1a item 1) — every binding
   * site over a walked `CompilationUnit`, with entity kind and the use-shape
   * facts (destructure/singularize candidacy) the naming policy needs. A THIN
   * wrap over `bindingCensusOf` — the SAME function `walker/walk.ts` calls
   * internally as the first step of its own naming pipeline (census →
   * allocate → materialize), never a second derivation (matching `importsOf`'s
   * own "delegate to the same machinery" discipline, just above). No LSP
   * consumer of its own yet (`unit` is the walker's PROVISIONAL, pre-allocation
   * tree — not yet a value an LSP caller can construct independently); named
   * here per S4's discipline so the eventual consumer (rename-symbol /
   * go-to-definition's binding-site enumeration, once emission's naming
   * pipeline is itself a queryable model view rather than an internal walk()
   * step) has a stable seam to land on.
   */
  readonly bindingCensus: (unit: CompilationUnit) => BindingCensus;

  /**
   * E1c's asyncness view (engine plan §2 E1c): the call-graph fixpoint
   * (declared-bottom iteration, monotone, terminates) confined inside
   * `naming/asyncness.ts`'s `asyncnessOf` — a THIN wrap, same "delegate to
   * the same machinery" discipline as `importsOf`/`bindingCensus` above.
   * Seeded EXTERNALLY (`seeds`, e.g. `inferAsyncSeeds` from rules/phase1.ts)
   * rather than baked into the constructor: asyncness seeding is a
   * runtime-shim-registration fact orthogonal to `(source, registry)`, and
   * every other externally-supplied context this class needs (the registry
   * a caller wants `bindingCensus`'s `unit` walked against, the node
   * `importsOf` is asked about) already arrives as a call-site argument, not
   * a constructor field — matching that same precedent here.
   *
   * No LSP consumer of its own YET (inlay hints — "this call awaits" — are
   * the natural one, once the LSP wires in); compiler consumer:
   * `oracle/harness.ts`'s `compileGreenfield`, which feeds this view's
   * answer straight into `materializeAsyncness` (naming/asyncness.ts) —
   * the mechanical Await-minting/`.async`-setting rewrite that replaced the
   * dissolved `async-ify/` pass. Unlike `importsOf` (per-CoreForm-node,
   * memoized), this is per-`CompilationUnit` and uncached — matching
   * `bindingCensus`'s own precedent: the real pipeline calls it once per
   * compile, over the whole walked-and-CSE'd unit, so a cache would only
   * ever see one hit.
   */
  readonly asyncnessOf: (unit: CompilationUnit, seeds: ReadonlySet<string>) => AsyncnessFacts;

  // Internal-only caches, TS-`private` (compile-time) rather than `#`-native-
  // private: native `#` fields need `tslib`'s brand-check helpers under this
  // package's `importHelpers: true` (confirmed by isolated repro — the helper
  // is required even at this package's ES2024 target, and `tslib` is not a
  // dependency here), so a bare `#` would add a new runtime dependency purely
  // for a privacy guarantee this class doesn't need: these are plain FIELDS
  // (never `method() {}` syntax), so — exactly like `coreform`/the four public
  // views above — they never reach the prototype and R11's allow-list never
  // sees them, `#`-brand or not.
  private factsExtractionCache: FactsExtraction | undefined;
  private readonly importsCache = new WeakMap<CoreForm, ReadonlySet<string>>();
  /** `idiomAt`'s own memo — keyed by `App` identity, `WeakMap`-valued so a
   *  cached "no idiom applies" (`undefined`) is distinguishable from "never
   *  queried" via `.has()` (see `idiomAt`'s field, below). */
  private readonly idiomCache = new WeakMap<App, App | undefined>();
  /** The whole-program shadow verdict `idiomDecisionAt` needs (its `shadowed`
   *  dependency) — computed ONCE, lazily, on first `idiomAt` query, not per
   *  query (mirrors `facts()`'s own lazy-cache discipline just below). */
  private idiomShadowedCache: boolean | undefined;
  /** The next id `idiomAt`'s fusions may mint — seeded lazily, above every id
   *  `classify()` produced (`maxNodeId`, `../peepholes/index.ts`), then
   *  incremented on every mint. A plain mutable field (not a getter/method —
   *  the same field-only discipline this class's header requires). */
  private nextIdiomId: number | undefined;

  constructor(source: string, registry: EmitRegistry) {
    this.source = source;
    this.registry = registry;
    this.coreform = classify(desugar(parseSexprs(source)));
    this.narrowsMembers = narrowsMembersOf(registry);
    this.factsAt = (node) => this.facts().facts.get(node.id);
    this.factsMap = () => this.facts().facts;
    this.registryRow = (name) => this.registry.lookup(name);
    this.bindingCensus = (unit) => bindingCensusOf(unit);
    this.asyncnessOf = (unit, seeds) => asyncnessOf(unit, seeds);
    this.importsOf = (node) => {
      const hit = this.importsCache.get(node);
      if (hit !== undefined) return hit;
      const symbols = this.computeImportsOf(node);
      this.importsCache.set(node, symbols);
      return symbols;
    };
    this.idiomAt = (node) => {
      if (this.idiomCache.has(node)) return this.idiomCache.get(node);
      const decision = idiomDecisionAt(node, {
        shadowed: this.isIdiomShadowed(),
        mintId: () => this.mintIdiomId(),
        recurse: this.idiomAt,
      });
      this.idiomCache.set(node, decision);
      return decision;
    };
    this.sharedBindingsOf = (unit) => sharedBindingsOf(unit, this.registry);
  }

  /** The lazy, once-per-model whole-program extraction `factsAt`/`factsMap`
   *  share — "behind the LS epoch": nothing pays for a TS Program build until
   *  the first fact is actually queried. Arrow-valued field (see the caches'
   *  comment above) rather than a `private facts()` method — a method would
   *  land on the prototype and trip R11's allow-list. */
  private readonly facts = (): FactsExtraction => {
    if (this.factsExtractionCache === undefined) {
      this.factsExtractionCache = extractFacts(
        { source: this.source, classified: this.coreform },
        { narrowsMembers: this.narrowsMembers },
      );
    }
    return this.factsExtractionCache;
  };

  /** `importsOf`'s cache-miss path: walk `node` as a synthetic one-form
   *  "program" (see `importsOf`'s doc for why this — not a hand-rolled
   *  re-derivation of the walker's dispatch ladder — is the honest
   *  implementation), then read the same census `frame` reads today.
   *  `idiomAt: this.idiomAt` is the load-bearing addition E2 makes: this
   *  synthetic walk must fold the SAME idioms the real pipeline's walk does,
   *  or this view would under/over-count relative to the actual emitted
   *  `RuntimeRef`s the moment a folded symbol (`infer` → `infer/scalar`) is
   *  involved — see `importsOf`'s own doc for the caller-side rule this
   *  dissolves. */
  private readonly computeImportsOf = (node: CoreForm): ReadonlySet<string> => {
    const oneForm: ClassifyResult = { forms: [node], originAtom: new Map(), parentOf: new Map(), doors: [] };
    const unit = walk(oneForm, {
      registry: this.registry,
      facts: this.facts().facts,
      idiomAt: this.idiomAt,
      register: "run",
    });
    return runtimeRefsOf(unit);
  };

  /** `idiomAt`'s `shadowed` dependency — lazy, computed once (see the field's
   *  own doc, above). Arrow-valued (not a method) for the same R11
   *  prototype-allow-list reason `facts` is. */
  private readonly isIdiomShadowed = (): boolean => {
    if (this.idiomShadowedCache === undefined) {
      this.idiomShadowedCache = programShadowsPeepholeNames(this.coreform.forms);
    }
    return this.idiomShadowedCache;
  };

  /** `idiomAt`'s `mintId` dependency — lazy floor, then monotonically
   *  increasing (see the field's own doc, above). */
  private readonly mintIdiomId = (): NodeId => {
    if (this.nextIdiomId === undefined) this.nextIdiomId = maxNodeId(this.coreform.forms) + 1;
    return this.nextIdiomId++ as NodeId;
  };

  nodeAt(_offset: number): CoreForm | undefined {
    throw new Unimplemented("nodeAt");
  }

  // ── the spine ──────────────────────────────────────────────────────────

  get anchors(): readonly Anchor[] {
    throw new Unimplemented("anchors");
  }

  get chains(): readonly Chain[] {
    throw new Unimplemented("chains");
  }

  chainFeeding(_input: AnchorPort): Chain {
    throw new Unimplemented("chainFeeding");
  }

  get demandGraph(): DemandGraph {
    throw new Unimplemented("demandGraph");
  }

  programOf(_chain: Chain): ChainProgram {
    throw new Unimplemented("programOf");
  }

  sliceOf(_chain: Chain): RunnableSlice {
    throw new Unimplemented("sliceOf");
  }

  transferOf(_chain: Chain): Transfer {
    throw new Unimplemented("transferOf");
  }

  unevalOf(_chain: Chain): WireUneval {
    throw new Unimplemented("unevalOf");
  }

  get wireMap(): ReadonlyMap<EdgeKey, readonly WireUneval[]> {
    throw new Unimplemented("wireMap");
  }
}
