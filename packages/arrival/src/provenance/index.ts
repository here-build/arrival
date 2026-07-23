// `@inhuman.tools/arrival/provenance` — the mobx-free trace-capture spine
// (EvalTrace/Invocation/NodeRecord/computeProvenance), the plain trace
// projection (snapshotTrace), scope identity (scopeId), and the full
// analysis stack (forest/region/statechart/flow-graph/lineage/slice/uneval)
// that turns a finished trace into render-models. This is core's half of
// the tracing substrate: it captures a finished trace but never drives the
// evaluator and carries no reactive/mobx dependency (P12).
//
// `@inhuman.tools/arrival-provenance` is a thin re-export shim over this
// subpath (its two-tier public contract — default entry vs `/analysis` —
// is preserved there, both drawing from this one flat module). Its
// `EvalTrace` export is `ObservableEvalTrace`, a mobx-reactive subclass of
// this package's `EvalTrace` (see the seam design documented in trace.ts),
// kept there so studio/UI consumers keep byte-identical reactive semantics
// without this package taking on a mobx dependency.

export { EvalTrace, Invocation, NodeRecord, DEFAULT_TRACE_CAP, type InvocationState } from "./trace.js";
export { snapshotTrace, type PlainTrace, type PlainInv } from "./trace-snapshot.js";
// `userCallSite`/`DOTPROMPT_SOURCE_MARKER`/`ScopedParented` unexported (export restructure,
// docs/plans/stage-c-corpse-deletion.md §"Export restructure") — module-internal to
// arrival-provenance's own analysis stack, never a sibling-package read; `headOf`/`scopeId`
// stay (arrival-provenance's `/analysis` entry re-exports them).
export { headOf, scopeId } from "./scope-id.js";

// ── Primitive analysis layer (arrival-provenance's default entry) ──
export { extractDefines, type DefineInfo, type SourceLocation } from "../reader/extract-defines.js";
// `STRUCTURAL_FORMS`/`staticRecursiveHeads`/`staticLoopBodyScopes` unexported — internal to the
// forest builder's own recursion-detection pass, never read by a sibling package.
export {
  traceToForest,
  type ForestOptions,
  type CandidateBox,
  type BoxType,
  type Decision,
} from "./trace-to-forest.js";
export { traceToRegions, type Region, type RegionGraph } from "./trace-to-regions.js";
export { TraceRegionFold } from "./trace-region-fold.js";
export {
  serializeTrace,
  loadTraceArtifact,
  TRACE_PROTOCOL_VERSION,
  type TraceArtifact,
} from "./trace-artifact.js";

// ── Heavier analysis layer (arrival-provenance's `/analysis` entry) ──
export {
  traceToStatechart,
  forwardCone,
  backwardCone,
  type Statechart,
  type ChartNode,
  type ChartEdge,
  type EdgeKind,
} from "./statechart.js";
export { carrierFieldEdges } from "./carrier-fields.js";
export {
  traceToLineage,
  producerPluckFields,
  wireOpChains,
  type LineageGraph,
  type LineageWire,
} from "./trace-to-lineage.js";
export { collapseMDL, type CollapseParams, type CollapseResult } from "./mdl-collapse.js";
export { traceToFlowGraph, type FlowGraphOptions } from "./trace-to-flow-graph.js";
export {
  flowForwardCone,
  flowBackwardCone,
  type FlowGraph,
  type FlowGraphNode,
  type FlowGraphEdge,
  type FlowNodeKind,
} from "./flow-graph.js";
export { traceToFlowGraphNaive } from "./trace-to-flow-graph-naive.js";
export { traceToChain, type ProvenanceChain, type ChainNode, type ChainEdge } from "./trace-to-chain.js";
export { regionBoundaries, type RegionBoundary } from "./region-boundaries.js";
export {
  buildSlice,
  writeForm,
  referencedSymbols,
  defineNameOf,
  lastTopLevelForm,
  resolveReadIds,
  type Slice,
} from "./slice.js";
// `unevalWire`/`WireEmission` unexported — the wireframe builder's own internal emission
// leaves (export restructure, docs/plans/stage-c-corpse-deletion.md §"Export restructure");
// `buildUneval`/`Uneval`/`UnevalContainer` stay (arrival-provenance's `/analysis` entry
// re-exports them).
export { buildUneval, type Uneval, type UnevalContainer } from "./uneval.js";
export {
  type DefineTemplate,
  type EmittedWire,
  type Wire,
  type WireConsumer,
  type WireFact,
  type WireParam,
  type WireSlot,
  type WireframeGraph,
  type WireframeNode,
  type WireframeProgram,
} from "./wireframe/types.js";
export { buildWireframe, type WireframeBuildOptions } from "./wireframe/builder.js";
// `classifyProgramPrelude`/`assertPreludeEligible`/`buildPreludeSource`/`reachesPort`/
// `PreludeMembership` (prelude-analysis) and `hermeticEnv`/`HermeticEnv`/`IngressBindings`
// unexported — the replay/hermetic-env machinery's own internals, never a sibling-package
// read (`hermeticApply`/`HermeticApplyOptions`, gamma.ts's own public verb, stays).
export { hermeticApply, type HermeticApplyOptions } from "./gamma.js";

// `replayProgramWithPlayback`/`PlaybackReplayOptions`/`ReplayedValue` unexported — the
// whole-program replay driver is arrival's own replay-testing machinery, never a sibling-
// package read (nothing outside this package constructs a playback replay). `ReplayScopeError`
// stays off this list too (thrown only from inside that same driver). The stray `Payload`
// re-export (store/interfaces.js) is dropped too — `/provenance/store` is the one sanctioned
// door to the store's types now.
