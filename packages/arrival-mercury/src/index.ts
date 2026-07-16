/**
 * @inhuman.tools/arrival-mercury — the mercury differential-oracle harness.
 * Public surface per oracle-harness.md §2 (frozen interfaces), plus the
 * corpus-row runner the tier-1 bug-cell test consumes (§4.3's three-way check).
 */
export { classifyCompiledError, classifyInterpreterError, type ErrorClass } from "./oracle/error-classifier.js";
export {
  agreementOf,
  cleanupOracleScratch,
  compileGreenfield,
  evalCompiled,
  type EvalCompiledOptions,
  evalInterpreter,
  openOracleSession,
  oracleEqual,
  OracleImportHangError,
  type OracleSession,
  type OracleSubject,
  type OracleVerdict,
  type Outcome,
  runOracle,
  show,
} from "./oracle/harness.js";
export { type CorpusVerdict, type ExpectedOutcome, outcomeMatches, runCorpusCase } from "./oracle/expected.js";

// ── the new pipeline's front end (copy-as-chunk, constitution §4.5) + CoreForm IR ──
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

// ── the TYPE pass — Law T + the §5.3 narrowing-form grammar (type-emit-lawt.md) ──
export {
  emitTypes,
  type EmitTypesOptions,
  type EmitTypesResult,
  type Mapping,
  narrowsMembersOf,
} from "./type-emit/index.js";

// ── the TYPEFACTS extraction — the tsc→facts membrane (typefacts-extraction.md;
//    constitution §3.3/§5.3). `TypeFacts` re-exports @here.build/arrival/emit's
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

// ── the ASYNC-IFY pass — post-emit {sync, promise} dataflow (Law W §5.2; async-await-plane.md) ──
export { AsyncIfyDoorError, asyncIfy, type AsyncIfyOptions } from "./async-ify/index.js";

// ── LEGIBILITY — the third-invention pass (constitution §3.5): implicit destruction +
//    element-name singularization + pure-region CSE. Runs PRE-ASYNC-IFY (a documented
//    deviation from the constitution's pipeline diagram — see legibility.ts's header). ──
export {
  destructureParams,
  elementNameOf,
  legibility,
  type LegibilityOptions,
  pureRegionCse,
  singularizeHofParams,
} from "./legibility/index.js";

// ── minimal FRAME — the RuntimeRef→import materializer (constitution §3.4/§9 Phase 1) ──
export { frame, FrameDoorError, type FrameOptions } from "./frame/index.js";

// ── the stage-0 runtime manifest (constitution §4.4 Stage 0; the module itself is
//    runtime source the emitted project imports — only the symbol→export map is API) ──
export { STAGE0 } from "./runtime/stage0.js";
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
//    (static-prov.ts's G1 freeze; circuit-sexpr.ts's T6b). The ONE surface a host OUTSIDE
//    the arrival-mercury → arrival-run → arrival-reflect cycle (e.g. inhuman-mcp-worker) needs
//    to inject a live `circuit` capability into an arrival-reflect `ResultHandle` — see
//    arrival-reflect's `handle-provenance.ts` (`circuitOf`) for why arrival-reflect itself can
//    never import this package directly. ──
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
// wiring lives OUTSIDE this package (mcp-worker, which sits outside the
// arrival-mercury → arrival-run → arrival-reflect cycle — see arrival-reflect's
// `circuitOf` doc for why). Exporting these is pure plumbing: no logic here
// changes, every symbol is re-exported verbatim from its owning module. ──
export { channels, circuitVerdict, planeOf, type Channels, type ChannelAnchor, type ChannelTerminals, type CircuitRole, type CircuitVerdict, type Plane } from "./verdict/circuit-verdict.js";
export { seal, type LeafRole, type SealVerdict } from "./seal.js";
export { leafVerdicts, type LeafVerdict, type LeafVerdictKind, type ProbeAttempt, type ProbeOutcome } from "./probe/verdict.js";
export type { LeafPath as DynamicLeafPath } from "./probe/verdict.js";
export { witnessesFor, type Witness, type WitnessAxis, type WitnessOptions } from "./probe/witness.js";
