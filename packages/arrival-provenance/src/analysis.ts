// @here.build/arrival-provenance/analysis — thin re-export shim over
// `@here.build/arrival/provenance` (core, per REWORK-DAG.md node C0): the
// opt-in full-build analysis surface — render-models (statechart / flow
// graph / forest-collapse) plus the reverse-chain slicer (uneval/slice) —
// now lives in core alongside the rest of the tracing spine (P12). The
// default `.` entry (see `index.ts`) stays the capture + region-model
// primitives (trace, forest, regions) — this subpath is for consumers that
// need the heavier render/analysis stack on top of a trace.
// Note: `CandidateBox`/`BoxType` are intentionally NOT re-exported here — they
// belong to the primitive layer (`trace-to-forest.js`) since they describe the
// forest's own candidate-box vocabulary, not an analysis-only concept.

export {
  traceToStatechart,
  forwardCone,
  backwardCone,
  type Statechart,
  type ChartNode,
  type ChartEdge,
  type EdgeKind,
} from "@here.build/arrival/provenance";
export { carrierFieldEdges } from "@here.build/arrival/provenance";
export {
  traceToLineage,
  producerPluckFields,
  wireOpChains,
  type LineageGraph,
  type LineageWire,
} from "@here.build/arrival/provenance";
export { collapseMDL, type CollapseParams, type CollapseResult } from "@here.build/arrival/provenance";
export {
  traceToFlowGraph,
  flowForwardCone,
  flowBackwardCone,
  type FlowGraph,
  type FlowGraphNode,
  type FlowGraphEdge,
  type FlowNodeKind,
  type FlowGraphOptions,
} from "@here.build/arrival/provenance";
export { traceToFlowGraphNaive } from "@here.build/arrival/provenance";
export {
  traceToChain,
  type ProvenanceChain,
  type ChainNode,
  type ChainEdge,
} from "@here.build/arrival/provenance";
export { regionBoundaries, type RegionBoundary } from "@here.build/arrival/provenance";
export {
  buildSlice,
  writeForm,
  referencedSymbols,
  defineNameOf,
  lastTopLevelForm,
  resolveReadIds,
  type Slice,
} from "@here.build/arrival/provenance";
export { buildUneval, type Uneval, type UnevalContainer } from "@here.build/arrival/provenance";
