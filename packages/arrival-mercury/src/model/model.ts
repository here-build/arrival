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
import type { ClassifyResult, CoreForm, NodeId } from "../coreform/types.js";
import { classify } from "../coreform/classify.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { bindingCensusOf } from "../naming/census.js";
import type { BindingCensus } from "../naming/types.js";
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
   * Two honest, documented limits (Law F: never wrong, always visible), not
   * hidden behind a green test:
   *  1. a symbol lexically bound only by a scope OUTSIDE `node` resolves here
   *     as free — harmless UNLESS that outer binding happens to SHADOW a real
   *     registry name (an adversarial pattern absent from today's corpus): a
   *     free symbol either finds a registry row or doors, it never invents a
   *     WRONG `RuntimeRef`, so this is an over-approximation risk, never a
   *     silent-wrong one.
   *  2. answers for exactly the node it is HANDED — so a caller that queries
   *     the model's own `sm.coreform` forms sees the PRE-peephole census: a
   *     peephole-folded symbol (`infer` → `infer/scalar`) is E2's `sm.idiomAt`
   *     integration ("CSE and the peephole pair become sharing/idiom decision
   *     views… decided pre-census" — engine plan §2 E2), not E0's. Until E2,
   *     the E1b consumer (`oracle/harness.ts`'s `compileGreenfield`) resolves
   *     this at the call site by querying the view over the PEEPHOLED forms —
   *     the program the walk actually lowers.
   */
  readonly importsOf: (node: CoreForm) => ReadonlySet<string>;

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

  constructor(source: string, registry: EmitRegistry) {
    this.source = source;
    this.registry = registry;
    this.coreform = classify(desugar(parseSexprs(source)));
    this.narrowsMembers = narrowsMembersOf(registry);
    this.factsAt = (node) => this.facts().facts.get(node.id);
    this.factsMap = () => this.facts().facts;
    this.registryRow = (name) => this.registry.lookup(name);
    this.bindingCensus = (unit) => bindingCensusOf(unit);
    this.importsOf = (node) => {
      const hit = this.importsCache.get(node);
      if (hit !== undefined) return hit;
      const symbols = this.computeImportsOf(node);
      this.importsCache.set(node, symbols);
      return symbols;
    };
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
   *  implementation), then read the same census `frame` reads today. */
  private readonly computeImportsOf = (node: CoreForm): ReadonlySet<string> => {
    const oneForm: ClassifyResult = { forms: [node], originAtom: new Map(), parentOf: new Map(), doors: [] };
    const unit = walk(oneForm, { registry: this.registry, facts: this.facts().facts, register: "run" });
    return runtimeRefsOf(unit);
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
