/**
 * store/emit.ts — Q11a: the retrospective-stream EMISSION CORE (docs/PROVENANCE.md §5;
 * docs/PROVENANCE-PLAN.md Q11a "record emission core, flag-gated sidecar"). Pure
 * functions that build ONE `ProvenanceRecord` and append it through the `ProvenanceStore`/
 * `PayloadStore` ports (Q10) — the "deciding WHEN to mint one of these" half `records.ts`'s
 * own header explicitly named as NOT that file's job.
 *
 * FLAG-GATED SIDECAR (task-mandated shape): `isEmissionEnabled()` gates every `emit*`
 * function's body, checked FIRST, before any hashing/store/payload work — default FALSE.
 * "Sunset byte-identical when off" is therefore a one-line argument per function: the
 * flag read is the only thing that runs, nothing is allocated, nothing awaited, no store
 * method is ever called.
 *
 * Territory: mint / mux-decision / fan-instantiation / ingress-binding were Q11a's
 * kinds. `emitTrackOpen`/`emitTrackClose`/`emitHostSchedule` are Q11b's addition —
 * PURE builders, same flag-gated shape as their Q11a siblings; the DECIDING-WHEN
 * (which B3 counter mutation triggers a call, which comparator invocation accumulates
 * a triple) is `src/values/primitives/region-scope.ts`'s job, per the Q11b split
 * (that file serializes with Q13/Q15, this one doesn't).
 *
 * MEASURED OVERHEAD (Q11a's own risk note: "measure in-step, budget ~µs/record") —
 * `__benchmarks__/provenance-emit.bench.test.ts`, in-process against the store fakes
 * (a LOWER bound on real DO-storage latency, not an upper one): `emitMint` flag OFF
 * ≈4.3µs/record (async-call overhead only — no store/payload work runs); `emitMint`
 * flag ON ≈5.2µs/record (hash + payload put + seq alloc + append); the three
 * payload-free kinds flag ON ≈0.5–1.0µs/record (`emitMuxDecision`/
 * `emitFanInstantiation`/`emitIngressBinding` — no payload hashing/put). All comfortably
 * inside the plan's µs/record budget.
 *
 * Idempotence (§5 C2/D1, the W3 law): every `emit*` function derives its record's
 * identity ENTIRELY from the caller-supplied `RecordId` (never from `seq`, which a fresh
 * `allocateSeq` call mints every time, even on a retry) — `ProvenanceStoreFake.append`
 * upserts by `recordIdKey(record.id)`, so two `emit*` calls carrying the SAME `RecordId`
 * for the SAME logical event land as ONE record in `readStream`'s output, exactly once,
 * regardless of how many times (or under what fault injection) the caller retries. This
 * file adds no de-duplication machinery of its own — the store's upsert contract IS the
 * mechanism, per §5 C2/D1: "persistence is IDEMPOTENT UPSERT keyed by record id."
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// The flag — default OFF, per the task brief ("DEFAULT OFF — sunset byte-identical
// when off"). Q20 eventually governs the SEPARATE eager-oracle flag
// (`values/op-helpers.ts`'s `isEagerProvenanceOracleEnabled`) — this is a DIFFERENT
// flag, for a DIFFERENT mechanism (the retrospective STREAM, not the eager stamp
// accumulation), never read or written by this file's own logic.
// ─────────────────────────────────────────────────────────────────────────────

let emissionEnabled = false;

/** Is the Q11a retrospective-stream emission sidecar live? False by default — nothing
 *  in production calls an `emit*` function or touches a `ProvenanceStore`/`PayloadStore`
 *  until a caller flips this AND wires a real store (the wireframe-walking driver,
 *  Q15/Q16). Test-only today, exactly like Q9's `isEagerProvenanceOracleEnabled`. */
export function isEmissionEnabled(): boolean {
  return emissionEnabled;
}

/** Test/production toggle. Never called ambiently — the caller that flips this owns
 *  flipping it back (no auto-reset), matching `op-helpers.ts`'s sibling flag's contract. */
export function setEmissionEnabled(enabled: boolean): void {
  emissionEnabled = enabled;
}

/** §5 C6's stream-header placeholder value: the semantics-epoch this wave mints when no
 *  richer interpreter-version source exists yet. Q18 ("offload protocol") is the node
 *  that makes epoch comparison load-bearing (worker-side refusal / sampled verification
 *  on mismatch) — Q11a's job is only to land a real, stable value the header can carry,
 *  following the FNV-hash versioning convention this codebase already uses
 *  (`wireframe/hash.ts`'s `template-v0`/`site-v0` prefixes): bump the trailing digit,
 *  never the shape, when the interpreter's replay-relevant semantics actually change. */
export const DEFAULT_SEMANTICS_EPOCH = "arrival-provenance-v0";

/** FNV-1a over a JSON-peeled payload — the SAME algorithm `wireframe/hash.ts`'s private
 *  `fnv1a` uses (one content-hash idiom across the codebase), a separate small copy on
 *  purpose: that one hashes a `WireframeGraph`'s canonical TEXT (a prospective-layer
 *  concern), this one hashes a retrospective PAYLOAD (value + stamp ids, §5 D2) — this
 *  store leaf has no reason to depend on the wireframe layer for four lines of math.
 *  `stampIds` are folded in (not just `value`) so two mints with identical VALUES but
 *  different provenance lineage never collide on payload identity. */
function hashPayload(value: unknown, stampIds: readonly number[]): PayloadHash {
  let canonicalValue: string;
  try {
    canonicalValue = JSON.stringify(value) ?? "null";
  } catch {
    // Mirrors `store/fakes.ts`'s `estimateSizeBytes` fallback: a value that doesn't
    // JSON-stringify (BigInt, a live boxed AValue that slipped through un-peeled, …)
    // still needs a stable-enough hash input — sizing/hashing are fault-tolerant
    // conveniences here, never a correctness-load-bearing computation.
    canonicalValue = String(value);
  }
  const tagged = `payload-v0|${canonicalValue}#${stampIds.join(",")}`;
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < tagged.length; i++) {
    h ^= tagged.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return `payload-v0:${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** §5 C6: write the region's stream header, ONCE — idempotent-by-absence, never
 *  overwrites an already-written header (a region's semantics epoch is fixed at
 *  region-open per spec; a second call under a DIFFERENT epoch string is a caller bug
 *  this function refuses to paper over, not something Q11a resolves — Q13 owns the real
 *  region-open lifecycle this rides on top of). No-ops under the flag like every other
 *  function here. */
export async function ensureStreamHeader(
  store: ProvenanceStore,
  regionId: RegionId,
  semanticsEpoch: string = DEFAULT_SEMANTICS_EPOCH,
): Promise<void> {
  if (!isEmissionEnabled()) return;
  const existing = await store.getHeader(regionId);
  if (existing === undefined) await store.putHeader(regionId, { semanticsEpoch });
}

/** §5 A6 row 1 + §5 D2: a MINT — the one kind carrying a payload ("every payload is
 *  distinct information," never aggregates). Persists the payload (value + stamp ids)
 *  THEN appends the record referencing its hash — payload lands before the record that
 *  points to it, so a reader never observes a record whose payload hash resolves to
 *  nothing (the same landing order `TemplateStore`'s `putTemplate`-before-`registerSite`
 *  convention already implies for this store family). */
export async function emitMint(opts: {
  readonly store: ProvenanceStore;
  readonly payloads: PayloadStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
  readonly value: unknown;
  readonly stampIds: readonly number[];
}): Promise<MintRecord | undefined> {
  if (!isEmissionEnabled()) return undefined;
  const { store, payloads, regionId, id, value, stampIds } = opts;
  const payloadHash = hashPayload(value, stampIds);
  const payload: Payload = { value, stampIds };
  await payloads.put(payloadHash, payload);
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: MintRecord = { kind: "mint", id, seq, payloadHash };
  await store.append(regionId, record);
  return record;
}

/** §5 A6 row 2 + §1 A2: a mux DECISION — port-coupled muxes only (a pure-selector mux
 *  collapses into its wire and is never recorded; see `records.ts`'s `MuxDecisionRecord`
 *  doc). `arm` is the taken arm's 0-based, wireframe-arm-order index. */
export async function emitMuxDecision(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
  readonly arm: number;
}): Promise<MuxDecisionRecord | undefined> {
  if (!isEmissionEnabled()) return undefined;
  const { store, regionId, id, arm } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: MuxDecisionRecord = { kind: "mux-decision", id, seq, arm };
  await store.append(regionId, record);
  return record;
}

/** §5 A6 row 3: a FAN INSTANTIATION — one fan instance came into being at `id`'s
 *  trailing ordinal. No payload of its own; presence (aggregated: count) is the whole
 *  fact — see `records.ts`'s `AggregationRun` for the path-scoped RLE folding a later
 *  node (Q12) performs OVER a run of these, never this function's own concern. */
export async function emitFanInstantiation(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
}): Promise<FanInstantiationRecord | undefined> {
  if (!isEmissionEnabled()) return undefined;
  const { store, regionId, id } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: FanInstantiationRecord = { kind: "fan-instantiation", id, seq };
  await store.append(regionId, record);
  return record;
}

/** §5 A6 row 4: an INGRESS BINDING — a binder's ingress bound at this ordinal, over
 *  STABLE wiring (the structural wiring fact; a per-iteration VALUE that itself varies
 *  is a `MintRecord` at whatever port produced it, never this kind — see `records.ts`'s
 *  `IngressBindingRecord` doc). */
export async function emitIngressBinding(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
}): Promise<IngressBindingRecord | undefined> {
  if (!isEmissionEnabled()) return undefined;
  const { store, regionId, id } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: IngressBindingRecord = { kind: "ingress-binding", id, seq };
  await store.append(regionId, record);
  return record;
}

/** §5 A6 row 5 (open half) + Q11b: a TRACK OPENED — one re-entrant (scheme→JS) call
 *  started under a `RegionScope` (`region-scope.ts`'s B3 counters: `pending++`).
 *  Aggregates (counter deltas, per the applicability table) — this function mints one
 *  RAW record per call; folding a run of these into an `AggregationRun` is Q12's job,
 *  never this one's. No payload: presence at `id.ordinalPath`'s trailing ordinal is
 *  the whole fact. */
export async function emitTrackOpen(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
}): Promise<TrackOpenRecord | undefined> {
  if (!isEmissionEnabled()) return undefined;
  const { store, regionId, id } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: TrackOpenRecord = { kind: "track-open", id, seq };
  await store.append(regionId, record);
  return record;
}

/** §5 A6 row 5 (close half) + §3 I4 + Q11b: the SAME track's completion — `settled` is
 *  the promise-pending distinction (§4 R1: "a promise egress keeps its track PENDING
 *  until settled"). `region-scope.ts`'s `withRegionCall` only ever reaches its
 *  `finally` (where this fires) AFTER the call has settled one way or another, so
 *  production callers always pass `settled: true` here — `settled: false` stays
 *  representable for tests exercising the record SHAPE the incomplete door's
 *  precondition implies (records.ts's own doc), never something this function's
 *  caller constructs for a real crossing. */
export async function emitTrackClose(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
  readonly settled: boolean;
}): Promise<TrackCloseRecord | undefined> {
  if (!isEmissionEnabled()) return undefined;
  const { store, regionId, id, settled } = opts;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: TrackCloseRecord = { kind: "track-close", id, seq, settled };
  await store.append(regionId, record);
  return record;
}

/** §5 A6 row 6 + §5 D5 + Q11b: an order-dependent selector host's FULL comparator
 *  schedule (e.g. one `sort` call's every `less?` verdict) — "the sequence IS the
 *  record," never aggregated, never split across multiple `HostScheduleRecord`s for
 *  one host invocation. Callers accumulate triples over the host's run (see
 *  `region-scope.ts`'s `recordHostScheduleVerdict`/`RegionScope.hostSchedule`) and
 *  call this ONCE, at the host boundary — never once per triple. A caller passing
 *  zero triples gets `undefined` back with no store write: an order-dependent host
 *  that made no comparisons (a 0/1-element sort) schedules nothing, and "nothing
 *  happened" is not itself information worth a record. */
export async function emitHostSchedule(opts: {
  readonly store: ProvenanceStore;
  readonly regionId: RegionId;
  readonly id: RecordId;
  readonly triples: readonly HostScheduleTriple[];
}): Promise<HostScheduleRecord | undefined> {
  if (!isEmissionEnabled()) return undefined;
  const { store, regionId, id, triples } = opts;
  if (triples.length === 0) return undefined;
  const seq: RegionSeq = await store.allocateSeq(regionId);
  const record: HostScheduleRecord = { kind: "host-schedule", id, seq, triples };
  await store.append(regionId, record);
  return record;
}
