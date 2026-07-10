// `store/` — the retrospective-stream storage seam, interface-first. LEAF module
// — nothing in `src/eval`/`src/values` imports this; emission, tiering policy/
// envelope, and the workerd adapter all build ON this, not the reverse.
// One inward dependency: `TemplateStore`'s shape names `WireframeGraph`
// (`../wireframe/types.js`) — one-directional (wireframe never imports store), so
// this is still a leaf from `src/eval`/`src/values`'s point of view.

export type {
  OrdinalPath,
  PayloadHash,
  RecordId,
  RegionEpoch,
  RegionId,
  RegionSeq,
  SiteHash,
  TemplateHash,
} from "./ids.js";
export {
  appendOrdinal,
  compareOrdinalPaths,
  ordinalPathKey,
  parentOrdinalPath,
  recordIdKey,
  ROOT_ORDINAL_PATH,
  trailingOrdinal,
} from "./ids.js";

export type {
  AggregatableRecordKind,
  AggregationRun,
  FanInstantiationRecord,
  HostScheduleRecord,
  HostScheduleTriple,
  IngressBindingRecord,
  MintRecord,
  MuxDecisionRecord,
  ProvenanceRecord,
  RecordKind,
  TrackCloseRecord,
  TrackOpenRecord,
} from "./records.js";
export { assertNeverRecord } from "./records.js";

export type {
  EvidenceTier,
  Payload,
  PayloadRecord,
  PayloadStore,
  PayloadTier,
  ProvenanceStore,
  RetentionClass,
  StoredTemplate,
  StreamHeader,
  TemplateStore,
} from "./interfaces.js";

export {
  PayloadNotFound,
  PayloadStoreFake,
  PayloadWriteFailure,
  ProvenanceStoreFake,
  ProvenanceWriteFailure,
  TemplateNotFound,
  TemplateStoreFake,
} from "./fakes.js";

// Record emission core (flag-gated sidecar): mint/mux-decision/fan-instantiation/
// ingress-binding/track-open/track-close/host-schedule, all one module, one flag —
// deciding-WHEN still lives outside this file (evaluator.ts's generic apply site,
// region-scope.ts's pending counters).
export {
  DEFAULT_SEMANTICS_EPOCH,
  emitFanInstantiation,
  emitHostSchedule,
  emitIngressBinding,
  emitMint,
  emitMuxDecision,
  emitTrackClose,
  emitTrackOpen,
  ensureStreamHeader,
  isEmissionEnabled,
  setEmissionEnabled,
} from "./emit.js";

// Event-sourced regions + flush. `fold.ts` is the fold-as-recovery
// law's implementation (pure, over `readStream`'s output); `flush.ts` is the
// ring/port-completion-barrier contract (fake-backed; real wiring is a later concern).
export type { FoldTrackCoordinate, RegionFoldState } from "./fold.js";
export { foldRegionState, foldRegionStream, nextTrackOrdinal } from "./fold.js";

export type { ProvenanceRingOptions } from "./flush.js";
export { ProvenanceRing } from "./flush.js";

// Payload tiering: the `ring` tier `PayloadStore` doesn't model,
// plus the read-side `PayloadEvidenceEnvelope` every `recorded`/`stub`-arm drill-in
// answer carries, plus the egress-proxy `TierGate` integration.
export type { PayloadEvidenceEnvelope } from "./tiering.js";
export { evidenceTierOf, PayloadNotRingResident, PayloadTierMachine, tierGateFromSnapshot } from "./tiering.js";

// Path-scoped RLE aggregation. `RunStore` is the
// write-side hook's ADDITIVE companion port to `ProvenanceStore` (interfaces.ts);
// `RunStoreFake` (fakes.ts) is its in-memory implementation; everything else is
// `aggregate.ts`'s own surface — the type/runtime never-list door, fold/unfold,
// and `AggregatingProvenanceStore`, the reference write-side hook.
export type { RunStore } from "./interfaces.js";
export { RunStoreFake } from "./fakes.js";
export type { AggregatableRecord, FoldResult, RunKey, UnfoldedFact } from "./aggregate.js";
export {
  AggregatingProvenanceStore,
  assertAggregatable,
  foldRuns,
  isAggregatableKind,
  NeverAggregatable,
  runKeyString,
  unfoldRun,
} from "./aggregate.js";
