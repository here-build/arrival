// `store/` — Q10 (docs/PROVENANCE-PLAN.md): the retrospective-stream storage seam,
// interface-first (PROVENANCE-PLAN.md's harness decision). LEAF module — nothing in
// `src/eval`/`src/values` imports this yet; emission (Q11a/Q11b), tiering policy/
// envelope (Q14), and the workerd adapter (Q19) build ON this, not the reverse.

export type { OrdinalPath, PayloadHash, RecordId, RegionEpoch, RegionId, RegionSeq, TemplateHash } from "./ids.js";
export { recordIdKey } from "./ids.js";

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
  StreamHeader,
} from "./interfaces.js";

export {
  PayloadNotFound,
  PayloadStoreFake,
  PayloadWriteFailure,
  ProvenanceStoreFake,
  ProvenanceWriteFailure,
} from "./fakes.js";
