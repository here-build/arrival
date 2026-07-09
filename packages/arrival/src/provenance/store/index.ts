// `store/` — Q10 (docs/PROVENANCE-PLAN.md): the retrospective-stream storage seam,
// interface-first (PROVENANCE-PLAN.md's harness decision). LEAF module — nothing in
// `src/eval`/`src/values` imports this yet; emission (Q11a/Q11b), tiering policy/
// envelope (Q14), and the workerd adapter (Q19) build ON this, not the reverse.
// Q8b ADDS one inward dependency: `TemplateStore`'s shape names `WireframeGraph`
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

// Q11a/Q11b — record emission core (flag-gated sidecar). mint/mux-decision/
// fan-instantiation/ingress-binding are Q11a's; track-open/track-close/host-schedule
// are Q11b's addition — same module, same flag, deciding-WHEN still lives outside
// this file (evaluator.ts's generic apply site for Q11a, region-scope.ts's B3 counters
// for Q11b).
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

// Q13 — event-sourced regions + flush (§5 C1/C3). `fold.ts` is the fold-as-recovery
// law's implementation (pure, over `readStream`'s output); `flush.ts` is the
// ring/port-completion-barrier contract (fake-backed; real wiring is Q15/Q16's).
export type { FoldTrackCoordinate, RegionFoldState } from "./fold.js";
export { foldRegionState, foldRegionStream, nextTrackOrdinal } from "./fold.js";

export type { ProvenanceRingOptions } from "./flush.js";
export { ProvenanceRing } from "./flush.js";

// Q14 — payload tiering (§5 A1/m6): the `ring` tier `PayloadStore` doesn't model,
// plus the read-side `PayloadEvidenceEnvelope` every `recorded`/`stub`-arm drill-in
// answer carries, plus the egress-proxy `TierGate` integration.
export type { PayloadEvidenceEnvelope } from "./tiering.js";
export { evidenceTierOf, PayloadNotRingResident, PayloadTierMachine, tierGateFromSnapshot } from "./tiering.js";

// Q12 — path-scoped RLE aggregation (§5 A6 + round-3 m4). `RunStore` is the
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
