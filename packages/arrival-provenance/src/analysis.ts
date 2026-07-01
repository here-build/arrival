// @here.build/arrival-provenance/analysis — the opt-in full-build analysis
// surface: render-models (statechart / flow graph / forest-collapse) plus the
// reverse-chain slicer (uneval/slice). The default `.` entry stays the capture +
// region-model primitives (trace, forest, regions) — this subpath is for
// consumers that need the heavier render/analysis stack on top of a trace.
// Note: `CandidateBox`/`BoxType` are intentionally NOT re-exported here — they
// moved to the primitive layer (`trace-to-forest.js`) since they describe the
// forest's own candidate-box vocabulary, not an analysis-only concept.

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
export { traceToLineage, wireOpChains, type LineageGraph, type LineageWire } from "./trace-to-lineage.js";
export {
  collapseMDL,
  type CollapseParams,
  type CollapseResult,
} from "./mdl-collapse.js";
export {
  traceToFlowGraph,
  flowForwardCone,
  flowBackwardCone,
  type FlowGraph,
  type FlowGraphNode,
  type FlowGraphEdge,
  type FlowNodeKind,
  type FlowGraphOptions,
} from "./trace-to-flow-graph.js";
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
export { buildUneval, type Uneval, type UnevalContainer } from "./uneval.js";
