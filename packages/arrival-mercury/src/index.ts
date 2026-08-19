/**
 * @inhuman.tools/arrival-mercury — the scheme→TS compiler: front (parse/desugar) ·
 * classify · `SchemeSemanticModel` · registry · residual · ts.factory emit ·
 * typefacts. Browser + node; free of `tsx` and `node:fs`.
 *
 * The tsx-bound differential-oracle harness (interpreter ≡ compiled, corpus runner,
 * error classifier) now lives in `@inhuman.tools/arrival-mercury-oracle`. The
 * session-assembly seam (`openOracleSession`/`greenfieldRegistryFor`) and the pure
 * value utilities (`oracleEqual`/`show`) are compiler-owned (tsx-free, with
 * compiler-side callers) and re-exported here from their homes.
 */
export { greenfieldRegistryFor, openOracleSession, type OracleSession } from "./registry/greenfield-session.js";
export { oracleEqual, show } from "./verdict/value-equal.js";

// ── front (canonical desugar/nodes/parse) + CoreForm IR ──
export { desugar } from "./front/desugar.js";
export {
  type Atom,
  head,
  isAtom,
  isBool,
  isKeyword,
  isList,
  isNil,
  isNumber,
  keywordName,
  type ListNode,
  type Node,
} from "./front/nodes.js";
export { parseSexprs } from "./front/parse.js";

// ── organ 1: semantic model (Roslyn-style handle) + product compile ──
export { SchemeSemanticModel, Unimplemented } from "./model/model.js";
export {
  compileSource,
  type CompileRegister,
  type CompileSourceOptions,
  type CompileSourceResult,
} from "./product/compile-source.js";
export {
  collectEmittedDependencies,
  EMITTED_DEP_VERSIONS,
  emittedPackageJson,
  type EmittedFileLike,
  type EmittedPackageJsonOptions,
} from "./product/emitted-deps.js";

// ── the TYPE pass — Law T + the §5.3 narrowing-form grammar (type-emit-lawt.md) ──
export {
  emitTypes,
  type EmitTypesOptions,
  type EmitTypesResult,
  type Mapping,
  narrowsMembersOf,
} from "./type-emit/index.js";

// ── the TYPEFACTS extraction — the tsc→facts membrane (typefacts-extraction.md;
//    constitution §3.3/§5.3). `TypeFacts` re-exports @inhuman.tools/arrival/emit's
//    canonical vocabulary — one type, two readers, no adaptation layer. ──
export {
  type ClassifiedSource,
  type DeriveContext,
  deriveFacts,
  extractFacts,
  type ExtractFactsOptions,
  type FactsExtraction,
  hasFacts,
  type HoleReason,
  litFacts,
  quoteFacts,
  type TypeFacts,
} from "./typefacts/index.js";

// ── the engine walker (engine-walker.md; constitution §3.5/§4.2/§5.2) ──
export { runtimeRefsOf, walk, WalkDoorError, type WalkOptions } from "./walker/index.js";

// ── LEGIBILITY — constitution §3.5's third invention. All three legs have now
//    dissolved into views (destructure/singularize into ./naming/ at E1a; pure-
//    region CSE into ./naming/shared-bindings.ts at E2 — engine plan §2 E2); this
//    directory survives only as the shared `R`-structural substrate every
//    dissolution keeps importing (see legibility/index.ts's header). ──
export { elementNameOf } from "./legibility/index.js";

// ── NAMING — E1a's census + allocation phase (engine plan §2 E1a): the binding
//    census view, the lexical-namer allocation adapter, and the materialize step
//    walker/walk.ts drives internally before it ever returns a CompilationUnit.
//    Plus E1b's import materialization (engine plan §2 E1b) — the RuntimeRef→
//    Ref commit that replaced the dissolved `frame/` pass (constitution §3.4/§9
//    Phase 1's minimal FRAME no longer exists; see naming/imports.ts's header
//    for where its knowledge went) — E1c's asyncness materialization (engine
//    plan §2 E1c): `asyncnessOf` (the call-graph fixpoint, confined inside a
//    model view — SchemeSemanticModel wraps it as `sm.asyncnessOf`) +
//    `materializeAsyncness` (the mechanical Await/`.async` rewrite), the
//    dissolved `async-ify/` post-pass's replacement — and E2's shared-bindings
//    materialization (engine plan §2 E2, second half): `sharedBindingsOf` (the
//    CSE decision view — SchemeSemanticModel wraps it as `sm.sharedBindingsOf`)
//    + `materializeSharedBindings` (the mechanical splice/substitute/real-
//    allocate rewrite), the dissolved `legibility/cse.ts` pass's replacement. ──
export {
  allocateNames,
  AsyncnessDoorError,
  asyncnessOf,
  bindingCensusOf,
  materializeAsyncness,
  materializeImports,
  materializeNames,
  materializeSharedBindings,
  MaterializeImportsDoorError,
  sharedBindingsOf,
  type AsyncnessFacts,
  type AsyncType,
  type BindingCensus,
  type BindingOrigin,
  type BindingSite,
  type DestructureShape,
  type EntityKind,
  type FieldDestructureShape,
  type FnDef,
  type MaterializeImportsOptions,
  type NameAllocation,
  type ScopeCensus,
  type SharedBindingGroup,
  type SharedBindingsView,
} from "./naming/index.js";

// ── the stage-0 runtime manifest (constitution §4.4 Stage 0; the module itself is
//    runtime source the emitted project imports — only the symbol→export map is API) ──
export {
  RAMDA_DIVERGENCES,
  RAMDA_MODULE,
  RUNTIME_LOCALS,
  RUNTIME_MANIFEST,
  STAGE0,
  type RuntimeEntry,
  type RuntimeSource,
} from "./runtime/runtime-manifest.js";
export { render } from "./residual/render.js";
export type { CompilationUnit } from "./residual/types.js";

// ── the Contract.emit registry harvest (constitution §4.1/§4.5; registry-emit.md) ──
export {
  assertNarrowsWitnessed,
  dryActivation,
  type EmitRegistry,
  type EmitRegistryRow,
  emitRegistryOf,
} from "./registry/index.js";

// ── Phase-1 symbol rules + the registry overlay (phase1-symbol-rules.md; §4.3/§7 —
//    interim compiler-side placement, see rules/overlay.ts) ──
export {
  inferAsyncSeeds,
  type OverlayEmitRegistry,
  type OverlayRegistryRow,
  phase1Rules,
  type SymbolRule,
  type SymbolRuleTable,
  withRules,
} from "./rules/index.js";

// ── the schema-driven fuzzer (oracle-harness.md §4.4; constitution §5.4/Law N) ──
export {
  arbitrarySchemeValue,
  PREDICATE_CONSUMERS,
  renderSchemeLiteral,
  type SchemeSample,
  synthesizeSingleWitnessProgram,
  witnessesMissingConsumers,
} from "./fuzz/index.js";
export {
  type And,
  type App,
  type Base,
  type Begin,
  type Binding,
  classify,
  type ClassifyResult,
  type CoreForm,
  type Define,
  type DefineFn,
  type Dict,
  type Door,
  type DoorCategory,
  type If,
  type KwEntry,
  type Lambda,
  type Let,
  type LetKind,
  type Lit,
  type LitValue,
  type NamedLet,
  type NodeId,
  type Or,
  type Param,
  type Quote,
  type QuoteDatum,
  type Ref,
  type Require,
  type ScalarLit,
  type Span,
} from "./coreform/index.js";

// ── the ATTRIBUTION CIRCUIT — extract (CoreForm → StaticProv, I1's totality proof) +
//    circuitToSexpr (its homoiconic render), plus the registry `extractProgram` needs
//    (static-prov.ts's G1 freeze; circuit-sexpr.ts's T6b). The ONE surface a host that
//    already depends on both this compiler and `@inhuman.tools/arrival-provenance/reflect`
//    (e.g. inhuman-mcp-worker) needs to inject a live `circuit` capability into a
//    `ResultHandle` — see `/reflect`'s `circuitOf` for why the analysis plane does not
//    import this package. ──
export { extractProgram, type ExtractCtx } from "./extract/index.js";
export { defaultRegistry } from "./extract/arm-containers.js";
export { circuitToSexpr } from "./model/circuit-sexpr.js";
// The two other circuit projections (§2f's consumers): circuitToMermaid — the
// eyeball-able flowchart for reviews + the MCP `(circuit h :as mermaid)` option;
// toWireframe — the StaticProv→WireframeGraph projection the studio ELK pane
// consumes. Both pure, same host-facing surface as circuitToSexpr.
export { circuitToMermaid, type MermaidOptions } from "./model/circuit-mermaid.js";
export { toWireframe, type WireframeProjection, type WireframeSideMaps } from "./model/to-wireframe.js";
// The FOURTH projection (provenance-beautiful-child, Wave 1): the compose
// formula lens + the C2 census it shares with circuit-sexpr's `:id` numbering.
// `HoleReason` is aliased here ONLY because the root barrel already exports
// typefacts' unrelated `HoleReason`; the browser-safe `/circuit` subpath
// exports it under its own name.
export { census, type Census } from "./model/census.js";
export {
  type ComposeExpr,
  type ComposeHole,
  type ComposeTemplate,
  type HoleId,
  type HoleReason as ComposeHoleReason,
  renderComposeText,
  type SourceLens,
  toComposeTemplate,
} from "./model/compose-template.js";
// The fifth projection (provenance-beautiful-child, control-plane-collapse.md):
// the hierarchical state machine over the same StaticProv circuit — same
// browser-safe, pure-projection surface as the other four.
export {
  collapseView,
  type ControlMachine,
  type ControlState,
  type EgressRef,
  type LensEdge,
  type LensEdgeId,
  type PortId,
  type StateId,
  type StateKind,
  type StateRef,
} from "./model/collapse-view.js";
export type {
  BuildProv,
  ChoiceProv,
  ConstProv,
  FanProv,
  FusedProv,
  HeadRegistry,
  InputProv,
  Integrity,
  MintIntegrity,
  MintProv,
  MuxProv,
  OpaqueProv,
  StaticProv,
  StringProv,
} from "./model/static-prov.js";

// ── T6c — the live conjunction's remaining ingredients: the static verdict
// channel (T4), the seal (I2), the dynamic leaf-verdict classifier + witness
// generator (T5c's siblings). None of these were previously reachable outside
// this package (only extract/circuitToSexpr were, for T6b's `circuit`
// capability) — T6c's whole job is wiring the two rails together, and the
// wiring lives OUTSIDE this package (mcp-worker, which already depends on both
// this compiler and `@inhuman.tools/arrival-provenance/reflect` — see `/reflect`'s
// `circuitOf` doc for why). Exporting these is pure plumbing: no logic here
// changes, every symbol is re-exported verbatim from its owning module. ──
export { channels, circuitVerdict, planeOf, type Channels, type ChannelAnchor, type ChannelTerminals, type CircuitRole, type CircuitVerdict, type Plane } from "./verdict/circuit-verdict.js";
// field-granular access (provenance-beautiful-child, lens 3, Wave 1) — PURE
// subcircuit-valued lens over StaticProv, re-exported verbatim (also available
// from the browser-safe `/circuit` subpath — see circuit.ts).
export { fieldProv, type FieldPath, type FieldProvResult } from "./verdict/field-prov.js";
export { seal, type LeafRole, type SealVerdict } from "./seal.js";
export { leafVerdicts, type LeafVerdict, type LeafVerdictKind, type ProbeAttempt, type ProbeOutcome } from "./probe/verdict.js";
export type { LeafPath as DynamicLeafPath } from "./probe/verdict.js";
export { witnessesFor, type Witness, type WitnessAxis, type WitnessOptions } from "./probe/witness.js";

// ── `inhuman build` — the build-emitter surface (docs/working-proposals/
//    inhuman-build-cli.md): module-faced emission composing the pipeline
//    above (walk/materialize*/render), the require→import rewrite, and the
//    export contract (module face + program face + v0's pipeline wrap). The
//    CLI package (`@inhuman.tools/inhuman`) is the sole consumer; this is the
//    ONE new public surface this lane adds — everything else above is
//    untouched. ──
export { buildProject, type BuildProjectOptions } from "./build/project.js";
export type {
  BuildFile,
  BuildResult,
  BuildWarning,
  BuildWarningCode,
  CompileFileOptions,
  CompileFileResult,
  ExportShape,
  PendingWarning,
  RequireResolution,
} from "./build/types.js";
export { compileDataFile, DATA_EXTENSIONS } from "./build/data-module.js";
export { compileScmModule, type ScmCompileDeps } from "./build/scm-module.js";
export { flattenTopBegins, hasProgramFace, scanRequires, topLevelDefineNames, type RequireOccurrence } from "./build/require-scan.js";
export {
  buildEnvChain,
  buildEnvOrDefault,
  envKeyFor,
  foldCoercionTag,
  foldOverridableExports,
  isLiftableOverridable,
  liftFlowedUpOverridable,
  liftLocalOverridable,
  liftOverridable,
  MODULE_OVERRIDABLE_SYMBOL,
  moduleOverridableSymbolRule,
  OVERRIDABLE_SYMBOL,
  overridableSymbolRule,
  PIPELINE_PARAMS_SCHEME_NAME,
  type CoercionTag,
  type FlowedUpOverridable,
  type OverridableExport,
} from "./build/overridable.js";
// The pluggable file-classification seam: a project supplies its own
// `ClassifyFile` (`inhuman.config.json`'s `build.classifier`, resolved by
// the CLI's `build.ts`) instead of `buildProject`'s derivable default.
export { defaultClassifier, pipelinesDirClassifier, type ClassifyFile, type FileClass } from "./build/classify.js";
