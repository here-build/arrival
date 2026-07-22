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
export { headOf, scopeId, userCallSite, DOTPROMPT_SOURCE_MARKER, type ScopedParented } from "./scope-id.js";

// ── Primitive analysis layer (arrival-provenance's default entry) ──
export { extractDefines, type DefineInfo, type SourceLocation } from "../reader/extract-defines.js";
export {
  traceToForest,
  type ForestOptions,
  type CandidateBox,
  type BoxType,
  type Decision,
  STRUCTURAL_FORMS,
  staticRecursiveHeads,
  staticLoopBodyScopes,
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
export { buildUneval, unevalWire, type Uneval, type UnevalContainer, type WireEmission } from "./uneval.js";
export * from "./wireframe/index.js";
export {
  classifyProgramPrelude,
  assertPreludeEligible,
  buildPreludeSource,
  reachesPort,
  type PreludeMembership,
} from "./prelude.js";
export { hermeticEnv, type HermeticEnv, type IngressBindings } from "./hermetic-env.js";
export { hermeticApply, type HermeticApplyOptions } from "./gamma.js";

// ── Replay drivers — the "every crossing answered from the recorded payload stream" claim,
// exported as real API (a `src/…` path is never customer surface).
// `replayProgramWithPlayback` is the whole-program face: re-run under a hermetic env whose
// only membrane ops are playback sources, silent region, queue underflow = teaching door
// (never a live re-fetch).
export {
  replayProgramWithPlayback,
  ReplayScopeError,
  type PlaybackReplayOptions,
  type ReplayedValue,
} from "./replay.js";
export type { Payload } from "./store/interfaces.js";
