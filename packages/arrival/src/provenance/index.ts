// `@here.build/arrival/provenance` — the mobx-free trace-capture spine
// (EvalTrace/Invocation/NodeRecord/computeProvenance), the plain trace
// projection (snapshotTrace), and scope identity (scopeId). This is core's
// half of the tracing substrate: it captures a finished trace but never
// drives the evaluator and carries no reactive/mobx dependency.
//
// `@here.build/arrival-provenance` builds on this subpath: its `EvalTrace`
// export is `ObservableEvalTrace`, a mobx-reactive subclass of this
// package's `EvalTrace` (see the seam design documented in trace.ts), kept
// there so studio/UI consumers keep byte-identical reactive semantics
// without this package taking on a mobx dependency.

export { EvalTrace, Invocation, NodeRecord, DEFAULT_TRACE_CAP, type InvocationState } from "./trace.js";
export { snapshotTrace, type PlainTrace, type PlainInv } from "./trace-snapshot.js";
export { headOf, scopeId, userCallSite, DOTPROMPT_SOURCE_MARKER, type ScopedParented } from "./scope-id.js";
