// `@inhuman.tools/arrival/provenance` — the mobx-free trace-capture spine
// (EvalTrace/Invocation/NodeRecord/computeProvenance), the plain trace
// projection (snapshotTrace), scope identity (scopeId), and the static
// wireframe plane (extractDefines, slice/uneval-wire, buildWireframe, gamma)
// that the replay/offload/define-bake machinery depends on. This is core's
// half of the tracing substrate: it captures a finished trace but never
// drives the evaluator and carries no reactive/mobx dependency (P12).
//
// The render-model ANALYSIS stack (forest/region/statechart/flow-graph/
// lineage/reverse-chain-slicer) that turns a finished trace into diagrams
// no longer lives here — it moved to `@inhuman.tools/arrival-provenance`'s
// own `src/analysis/*` (provenance analysis-stack relocation), which now
// owns that code natively instead of re-exporting it from this subpath.
// The handful of names below that exist ONLY to feed that analysis stack
// (`userCallSite`, `classify`/`fieldResolve`/their types, `slotsOf`/
// `AutoBindings`) are exported here for exactly that cross-package read —
// see each export's own comment.
//
// `@inhuman.tools/arrival-provenance`'s default entry still re-exports this
// subpath's capture/wireframe primitives (its two-tier public contract —
// default entry vs `/analysis` — is preserved there). Its `EvalTrace` export
// is `ObservableEvalTrace`, a mobx-reactive subclass of this package's
// `EvalTrace` (see the seam design documented in trace.ts), kept there so
// studio/UI consumers keep byte-identical reactive semantics without this
// package taking on a mobx dependency.

export { EvalTrace, Invocation, NodeRecord, DEFAULT_TRACE_CAP, type InvocationState } from "./trace.js";
export { snapshotTrace, type PlainTrace, type PlainInv } from "./trace-snapshot.js";
// `DOTPROMPT_SOURCE_MARKER`/`ScopedParented` unexported (export restructure,
// docs/plans/stage-c-corpse-deletion.md §"Export restructure") — module-internal to
// arrival-provenance's own analysis stack, never a sibling-package read.
// `headOf`/`scopeId` stay (arrival-provenance's `/analysis` entry re-exports them).
// `userCallSite` is now ALSO exported: since the provenance analysis-stack relocation,
// `trace-to-regions.ts`/`trace-to-chain.ts` (arrival-provenance's own analysis modules)
// read it as a real cross-package import instead of an in-package relative one.
export { headOf, scopeId, userCallSite } from "./scope-id.js";

// ── Primitive layer (arrival-provenance's default entry) ──
export { extractDefines, type DefineInfo, type SourceLocation } from "../reader/extract-defines.js";
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
// leaves (export restructure, docs/plans/stage-c-corpse-deletion.md §"Export restructure").
// (The retrospective `buildUneval`/`Uneval`/`UnevalContainer` half of this file moved to
// arrival-provenance's analysis stack — provenance analysis-stack relocation; only the
// prospective wire-emission half, a wireframe-build-time dependency, stays here.)
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

// `classify`/`fieldResolve` + their `LineageNode`/`Bindings`/`Classifier` types (lineage.ts)
// and `slotsOf` + `AutoBindings` (lineage-auto-bindings.ts) are exported here SOLELY for the
// provenance analysis-stack relocation: `trace-to-lineage.ts`/`trace-region-fold.ts`/
// `trace-to-regions.ts`/`trace-to-chain.ts`/`statechart.ts`/`carrier-fields.ts` (now in
// arrival-provenance's analysis stack) read them as a cross-package import. `lineage.ts`
// itself stays in core (`classify`'s own static-classification engine is part of the
// prelude/hermetic-env static plane, not analysis) — only these two names cross the boundary.
export { classify, fieldResolve, type LineageNode, type Bindings, type Classifier } from "./lineage.js";
export { slotsOf, type AutoBindings } from "./lineage-auto-bindings.js";

// `replayProgramWithPlayback`/`PlaybackReplayOptions`/`ReplayedValue` unexported — the
// whole-program replay driver is arrival's own replay-testing machinery, never a sibling-
// package read (nothing outside this package constructs a playback replay). `ReplayScopeError`
// stays off this list too (thrown only from inside that same driver). The stray `Payload`
// re-export (store/interfaces.js) is dropped too — `/provenance/store` is the one sanctioned
// door to the store's types now.
