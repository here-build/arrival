/**
 * Retrospective-stream emission core — pure builders through
 * ProvenanceStore/PayloadStore. WHEN to emit is region-scope's job.
 *
 * No enable flag (P19): whether a run emits is `RunContext.emission !== undefined`, decided by
 * the callers (provenance-hooks, region-scope) — these builders are only ever called once a
 * sink exists. Identity is caller-supplied `RecordId` (not seq) — store upserts by id, so
 * retries are idempotent without de-dup here, and DISTINCT events MUST carry distinct ids.
 */
import { contentHash } from "./hash.js";
import type { PayloadHash, RecordId, RegionId, RegionSeq } from "./ids.js";
import type {
  FanInstantiationRecord,
  HostScheduleRecord,
  HostScheduleTriple,
  IngressBindingRecord,
  MintRecord,
  MuxDecisionRecord,
  TrackCloseRecord,
  TrackOpenRecord,
} from "./records.js";
import type { Payload, PayloadStore, ProvenanceStore } from "./interfaces.js";
import type { RunEmission } from "../../run/RunContext.js";

/** Next free instance ordinal per emission target. WeakMap keyed by the run's `RunEmission`
 *  (keyed residency, P19 — lifetime = the emission's, never a module counter). */
const instanceOrdinals = new WeakMap<RunEmission, number>();

/**
 * Claim the next INSTANCE ordinal under `emission.coordinate` — shared by every event kind a run
 * emits there (port mints AND track open/close), because the store upserts by `RecordId` alone
 * (not kind): two events minting the same `coordinate ++ [n]` would collapse into one record.
 * One counter per emission makes id-collision-freedom structural across kinds and scopes.
 */
export function claimInstanceOrdinal(emission: RunEmission): number {
  const ordinal = instanceOrdinals.get(emission) ?? 0;
  instanceOrdinals.set(emission, ordinal + 1);
  return ordinal;
}

/** Stream-header epoch when no richer interpreter version exists. Bump trailing digit on replay-relevant semantic change. */
export const DEFAULT_SEMANTICS_EPOCH = "arrival-provenance-v0";

/** Content hash over value + stampIds (stampIds prevent value-only collisions). */
function hashPayload(value: unknown, stampIds: readonly number[], raised: boolean): PayloadHash {
  let canonicalValue: string;
  try {
    canonicalValue = JSON.stringify(value) ?? "null";
  } catch {
    canonicalValue = String(value);
  }
  return `payload-v1:${contentHash("payload-v1", `${raised ? "raised:" : ""}${canonicalValue}#${stampIds.join(",")}`)}`;
}

/** Write stream header once (by absence); never overwrite an existing epoch. */
export async function ensureStreamHeader(
  store: ProvenanceStore,
  regionId: RegionId,
  semanticsEpoch: string = DEFAULT_SEMANTICS_EPOCH,
): Promise<void> {
  const existing = await store.getHeader(regionId);
  if (existing === undefined) await store.putHeader(regionId, { semanticsEpoch });
}

/** Mint: put payload then append record (hash never dangles). */
export async function emitMint(opts: {
  readonly store: ProvenanceStore;
  readonly payloads: PayloadStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
  readonly value: unknown;
  readonly stampIds: readonly number[];
  /** The crossing rejected: `value` is the condition message (see `Payload.raised`). */
  readonly raised?: true;
}): Promise<MintRecord | undefined> {
  const { store, payloads, regionId, id, value, stampIds, raised } = opts;
  const payloadHash = hashPayload(value, stampIds, raised === true);
  const payload: Payload = { value, stampIds, ...(raised === true ? { raised: true as const } : {}) };
  await payloads.put(payloadHash, payload);
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: MintRecord = { kind: "mint", id, seq, payloadHash };
  await store.append(regionId, record);
  return record;
}

/** Port-coupled mux arm index (pure-selector muxes are never recorded). */
export async function emitMuxDecision(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
  readonly arm: number;
}): Promise<MuxDecisionRecord | undefined> {
  const { store, regionId, id, arm } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: MuxDecisionRecord = { kind: "mux-decision", id, seq, arm };
  await store.append(regionId, record);
  return record;
}

/** Fan instance presence at ordinal (aggregation is fold's job). */
export async function emitFanInstantiation(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
}): Promise<FanInstantiationRecord | undefined> {
  const { store, regionId, id } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: FanInstantiationRecord = { kind: "fan-instantiation", id, seq };
  await store.append(regionId, record);
  return record;
}

/** Stable binder ingress wiring (varying values are mints, not this kind). */
export async function emitIngressBinding(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
}): Promise<IngressBindingRecord | undefined> {
  const { store, regionId, id } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: IngressBindingRecord = { kind: "ingress-binding", id, seq };
  await store.append(regionId, record);
  return record;
}

/** Track open (raw per-call; fold aggregates). */
export async function emitTrackOpen(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
}): Promise<TrackOpenRecord | undefined> {
  const { store, regionId, id } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: TrackOpenRecord = { kind: "track-open", id, seq };
  await store.append(regionId, record);
  return record;
}

/** Track close. Production always `settled: true`; false is shape-test only. */
export async function emitTrackClose(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
  readonly settled: boolean;
}): Promise<TrackCloseRecord | undefined> {
  const { store, regionId, id, settled } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: TrackCloseRecord = { kind: "track-close", id, seq, settled };
  await store.append(regionId, record);
  return record;
}

/** Full host comparator schedule once at boundary; empty triples → no write. */
export async function emitHostSchedule(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
  readonly triples: readonly HostScheduleTriple[];
}): Promise<HostScheduleRecord | undefined> {
  const { store, regionId, id, triples } = opts;
  if (triples.length === 0) return undefined;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: HostScheduleRecord = { kind: "host-schedule", id, seq, triples };
  await store.append(regionId, record);
  return record;
}
