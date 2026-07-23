// `store/` — the retrospective-stream storage seam, interface-first. LEAF module
// — nothing in `src/eval`/`src/values` imports this; emission, tiering policy/
// envelope, and the workerd adapter all build ON this, not the reverse.
//
// CURATED to a STUDIO READ-SLICE (export restructure, docs/plans/stage-c-corpse-deletion.md
// §"Export restructure"): the one external consumer of this subpath (inhuman's studio
// workbench, `record-stream-overlay.ts`/`wireframe-evidence.ts`) reads record SHAPES + the
// evidence-tier vocabulary, type-only — never the write side (`emit*`/`fold*`/`Ring`/
// `Aggregating*`), never the fakes (those are arrival's own test doubles). Twelve names:
// the record-kind union + five member shapes, `RecordId`/`OrdinalPath` (the idempotent-
// upsert key + its path component), `RegionFoldState` (the fold-as-recovery result shape),
// and `EvidenceTier` (the payload-tiering vocabulary the overlay's read renders against).
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
