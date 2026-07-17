// @inhuman.tools/arrival-provenance — thin re-export shim over
// `@inhuman.tools/arrival/provenance` (core, per REWORK-DAG.md node C0): the
// trace-capture substrate + the region-model primitives (forest, region
// tree) live in core now. Reads finished traces; never drives the
// evaluator. The heavier analysis stack (statechart, flow graph, MDL
// forest-collapse, and the reverse-chain slicer) lives at the `/analysis`
// subpath — see `analysis.ts` (also a shim over the same core subpath).
//
// The only non-passthrough export is `EvalTrace`: this file keeps the local
// mobx-reactive `ObservableEvalTrace` (from `./trace.js`) so studio/UI
// consumers keep byte-identical reactive semantics without core taking on
// a mobx dependency.

export { EvalTrace, Invocation, NodeRecord, type InvocationState } from "./trace.js";
export { extractDefines, type DefineInfo, type SourceLocation } from "@inhuman.tools/arrival/provenance";
export {
  traceToForest,
  scopeId,
  type ForestOptions,
  type CandidateBox,
  type BoxType,
  type Decision,
} from "@inhuman.tools/arrival/provenance";
export { traceToRegions, type Region, type RegionGraph } from "@inhuman.tools/arrival/provenance";
// Incremental twin of `traceToRegions` — maintains the same RegionGraph in O(Δ) per streamed tick (vs O(N) full rebuild) for the live blueprint render. Parity-locked to traceToRegions.
export { TraceRegionFold } from "@inhuman.tools/arrival/provenance";
export {
  serializeTrace,
  loadTraceArtifact,
  TRACE_PROTOCOL_VERSION,
  type TraceArtifact,
} from "@inhuman.tools/arrival/provenance";
// Plain (serializable) trace snapshot + structural clone — consumed by trace
// tooling and tests that round-trip a trace without the mobx-reactive class.
// (`snapshotTrace` accepts core's plain `EvalTrace`; this package's
// `ObservableEvalTrace` is a subclass, so passing either works.)
export { snapshotTrace, type PlainTrace, type PlainInv } from "@inhuman.tools/arrival/provenance";
