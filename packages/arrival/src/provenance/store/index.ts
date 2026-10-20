// `store/` — retrospective-stream storage seam, interface-first leaf.
// Only `src/eval/provenance-hooks.ts` (via `store/emit`) imports this from the evaluator side, and
// `src/values` imports nothing from it; emission, tiering, and adapters build ON this, not the reverse.
//
// Public subpath is a studio read-slice (types only): record shapes +
// `EvidenceTier`. Write side (`emit*`/`fold*`/fakes) stays package-internal.

export type {
  FanInstantiationRecord,
  IngressBindingRecord,
  MintRecord,
  MuxDecisionRecord,
  ProvenanceRecord,
  RecordKind,
  TrackCloseRecord,
  TrackOpenRecord,
} from "./records.js";
export type { RecordId } from "./ids.js";
export type { OrdinalPath } from "./ids.js";
export type { RegionFoldState } from "./fold.js";
export type { EvidenceTier } from "./interfaces.js";
