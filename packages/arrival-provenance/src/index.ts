// @here.build/arrival-provenance — the trace-capture substrate + the
// region-model primitives (forest, region tree). Reads finished traces; never
// drives the evaluator. The heavier analysis stack (statechart, flow graph,
// MDL forest-collapse, and the reverse-chain slicer) lives at the `/analysis`
// subpath — see `analysis.ts`.

export { EvalTrace, Invocation, NodeRecord, type InvocationState } from "./trace.js";
export { extractDefines, type DefineInfo, type SourceLocation } from "./extract-defines.js";
export { traceToForest, scopeId, type ForestOptions, type CandidateBox, type BoxType, type Decision } from "./trace-to-forest.js";
export { traceToRegions, type Region, type RegionGraph } from "./trace-to-regions.js";
// Incremental twin of `traceToRegions` — maintains the same RegionGraph in O(Δ) per streamed tick (vs O(N) full rebuild) for the live blueprint render. Parity-locked to traceToRegions.
export { TraceRegionFold } from "./trace-region-fold.js";
export { serializeTrace, loadTraceArtifact, TRACE_PROTOCOL_VERSION, type TraceArtifact } from "./trace-artifact.js";
// Plain (serializable) trace snapshot + structural clone — consumed by trace
// tooling and tests that round-trip a trace without the mobx-reactive class.
export { snapshotTrace, type PlainTrace, type PlainInv } from "./trace-snapshot.js";
