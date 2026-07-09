/**
 * store/fakes.ts — in-memory `ProvenanceStore`/`PayloadStore` implementations, per
 * PROVENANCE-PLAN.md's harness decision: "law and unit tests run against in-memory
 * fakes implementing the same interfaces with fault injection (write failure, forced
 * eviction..., delayed R2 settle) — default CI, no cloud, no browser." A workerd
 * suite validating a real adapter against this same contract is a later node's job.
 *
 * DETERMINISTIC BY CONSTRUCTION: no `setTimeout`/real timers anywhere. Delayed R2
 * settlement is modeled with an injected virtual clock (`PayloadStoreFake.step`) —
 * a test controls exactly when simulated time advances, never a race.
 */
import { ordinalPathKey, recordIdKey, type PayloadHash, type RegionId, type RegionSeq } from "./ids.js";
import type { OrdinalPath, SiteHash, TemplateHash } from "./ids.js";
import type {
  Payload,
  PayloadRecord,
  PayloadStore,
  ProvenanceStore,
  PayloadTier,
  StoredTemplate,
  StreamHeader,
  TemplateStore,
} from "./interfaces.js";
import type { ProvenanceRecord } from "./records.js";
import type { WireframeGraph } from "../wireframe/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// ProvenanceStore fake
// ─────────────────────────────────────────────────────────────────────────────

interface RegionSlot {
  header: StreamHeader | undefined;
  nextSeq: number;
  records: Map<string, ProvenanceRecord>;
}

function freshSlot(): RegionSlot {
  return { header: undefined, nextSeq: 1, records: new Map() };
}

/** §5 C3: "a failed write kills the request." Thrown by `append` while the fake's
 *  write-failure knob is armed — the one door this fake needs, since production
 *  behavior on write failure is "throw, caller aborts the request." */
export class ProvenanceWriteFailure extends Error {
  constructor(regionId: RegionId) {
    super(`ProvenanceStoreFake: injected write failure for region ${JSON.stringify(regionId)}`);
    this.name = "ProvenanceWriteFailure";
  }
}

/** In-memory `ProvenanceStore` with one fault-injection knob: `setWriteFailure`.
 *  Everything else (append/allocateSeq/readStream/header) is a straightforward
 *  Map-backed implementation of the real contract — no timers, no async work beyond
 *  the `Promise` shape the interface requires. */
export class ProvenanceStoreFake implements ProvenanceStore {
  private readonly regions = new Map<RegionId, RegionSlot>();
  private writeFailure = false;

  private slot(regionId: RegionId): RegionSlot {
    let s = this.regions.get(regionId);
    if (s === undefined) {
      s = freshSlot();
      this.regions.set(regionId, s);
    }
    return s;
  }

  /** Fault-injection knob (item 2, "write-failure on demand"): while armed, every
   *  `append` throws `ProvenanceWriteFailure` instead of writing — models §5 C3's
   *  "a failed write kills the request." */
  setWriteFailure(on: boolean): void {
    this.writeFailure = on;
  }

  async append(regionId: RegionId, record: ProvenanceRecord): Promise<void> {
    if (this.writeFailure) throw new ProvenanceWriteFailure(regionId);
    // §5 C2/D1: idempotent upsert keyed by record id — a retry with the same id
    // overwrites in place, never duplicates in `readStream`'s output.
    this.slot(regionId).records.set(recordIdKey(record.id), record);
  }

  async allocateSeq(regionId: RegionId): Promise<RegionSeq> {
    const s = this.slot(regionId);
    const seq = s.nextSeq;
    s.nextSeq += 1;
    return seq;
  }

  async readStream(regionId: RegionId): Promise<readonly ProvenanceRecord[]> {
    return [...this.slot(regionId).records.values()].toSorted((a, b) => a.seq - b.seq);
  }

  async getHeader(regionId: RegionId): Promise<StreamHeader | undefined> {
    return this.slot(regionId).header;
  }

  async putHeader(regionId: RegionId, header: StreamHeader): Promise<void> {
    this.slot(regionId).header = header;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PayloadStore fake
// ─────────────────────────────────────────────────────────────────────────────

/** Default DO per-value size cap this fake enforces before routing a `put` to the
 *  `pending` (oversize-awaiting-R2) tier instead of `do` — §5 A1 point 2: "bounded
 *  by per-value size limits... verify current SQLite-DO row caps at implementation."
 *  128KB-CLASS placeholder per the task brief; a real adapter's cap is whatever DO
 *  actually enforces, configurable here so law tests can probe both sides of it. */
const DEFAULT_VALUE_SIZE_CAP_BYTES = 128 * 1024;

interface PayloadSlot {
  tier: PayloadTier;
  value: unknown;
  stampIds: readonly number[];
  /** Set while `tier === "pending"` and a `settle` call is scheduled but not yet
   *  applied (delayed-R2-settle fault injection) — cleared once `step` applies it. */
  scheduled: { outcome: "settled" | "failed"; dueAtTick: number } | undefined;
}

/** Thrown by `get`/`settle` for a hash this store never saw — distinct from `stub`
 *  (evicted-but-known) per interfaces.ts's `get` doc: "never returns a fabricated
 *  stub for an unknown hash." */
export class PayloadNotFound extends Error {
  constructor(hash: PayloadHash) {
    super(`PayloadStoreFake: no payload ever put under hash ${JSON.stringify(hash)}`);
    this.name = "PayloadNotFound";
  }
}

/** Thrown when `put` is called under the fake's write-failure knob — the R2/DO-
 *  storage-leg analogue of `ProvenanceWriteFailure`. */
export class PayloadWriteFailure extends Error {
  constructor(hash: PayloadHash) {
    super(`PayloadStoreFake: injected write failure for payload ${JSON.stringify(hash)}`);
    this.name = "PayloadWriteFailure";
  }
}

/** Best-effort size estimate for the fake's size-cap knob. Payloads are "peeled to
 *  plain JS" values (per `provenance/uneval.ts`'s convention) so JSON round-trips in
 *  the common case; a value that doesn't stringify (BigInt, a live AValue box, etc.)
 *  falls back to `String(value).length` rather than throwing — sizing is a fault-
 *  injection KNOB here, not a correctness-load-bearing computation. */
function estimateSizeBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    try {
      return String(value).length;
    } catch {
      return 0;
    }
  }
}

/** In-memory `PayloadStore` with fault-injection knobs: `setPutFailure`,
 *  `setValueSizeCapBytes` (drives the `do`-vs-`pending` routing on `put`),
 *  `setSettleDelayTicks` + `step` (deterministic delayed-R2-settle, no real timers),
 *  and `evict`/`evictAll` (forced eviction to `stub`, from any tier). */
export class PayloadStoreFake implements PayloadStore {
  private readonly payloads = new Map<PayloadHash, PayloadSlot>();
  private putFailure = false;
  private valueSizeCapBytes = DEFAULT_VALUE_SIZE_CAP_BYTES;
  private settleDelayTicks = 0;
  private now = 0;

  /** Fault-injection knob: while armed, every `put` throws `PayloadWriteFailure`. */
  setPutFailure(on: boolean): void {
    this.putFailure = on;
  }

  /** Fault-injection knob: the size threshold (bytes, `estimateSizeBytes`) above
   *  which `put` routes to `pending` instead of `do` — lets a law test probe the
   *  §5 A1 "oversize payloads... R2 by hash reference" leg with small fixtures. */
  setValueSizeCapBytes(bytes: number): void {
    this.valueSizeCapBytes = bytes;
  }

  /** Fault-injection knob: how many `step` ticks a scheduled `settle` waits before
   *  applying — 0 (default) settles synchronously within `settle` itself. */
  setSettleDelayTicks(ticks: number): void {
    this.settleDelayTicks = ticks;
  }

  /** Deterministic virtual clock advance — applies any `settle` scheduled at or
   *  before the new `now`. No wall-clock time is ever read; a test drives this
   *  explicitly to observe a payload sitting at `pending` before the settle lands. */
  step(ticks = 1): void {
    this.now += ticks;
    for (const [hash, slot] of this.payloads) {
      if (slot.scheduled !== undefined && slot.scheduled.dueAtTick <= this.now) {
        this.applySettle(hash, slot, slot.scheduled.outcome);
      }
    }
  }

  private applySettle(hash: PayloadHash, slot: PayloadSlot, outcome: "settled" | "failed"): void {
    if (outcome === "settled") {
      slot.tier = "r2";
    } else {
      // §5 m6: "on R2 failure the payload degrades to stub under tier honesty."
      slot.tier = "stub";
      slot.value = undefined;
    }
    slot.scheduled = undefined;
  }

  async put(hash: PayloadHash, payload: Payload): Promise<void> {
    if (this.putFailure) throw new PayloadWriteFailure(hash);
    const oversize = estimateSizeBytes(payload.value) > this.valueSizeCapBytes;
    this.payloads.set(hash, {
      tier: oversize ? "pending" : "do",
      value: payload.value,
      stampIds: payload.stampIds,
      scheduled: undefined,
    });
  }

  async get(hash: PayloadHash): Promise<PayloadRecord> {
    const slot = this.payloads.get(hash);
    if (slot === undefined) throw new PayloadNotFound(hash);
    return { tier: slot.tier, value: slot.tier === "stub" ? undefined : slot.value, stampIds: slot.stampIds };
  }

  async settle(hash: PayloadHash, outcome: "settled" | "failed"): Promise<void> {
    const slot = this.payloads.get(hash);
    if (slot === undefined) throw new PayloadNotFound(hash);
    if (slot.tier !== "pending") {
      throw new Error(
        `PayloadStoreFake.settle: hash ${JSON.stringify(hash)} is at tier "${slot.tier}", not "pending" — ` +
          "settle only applies to the oversize-awaiting-R2 leg (§5 m6).",
      );
    }
    if (this.settleDelayTicks <= 0) {
      this.applySettle(hash, slot, outcome);
    } else {
      slot.scheduled = { outcome, dueAtTick: this.now + this.settleDelayTicks };
    }
  }

  async evict(hash: PayloadHash): Promise<void> {
    const slot = this.payloads.get(hash);
    if (slot === undefined) throw new PayloadNotFound(hash);
    // §5 A1 tier 4: "value dropped, identity + stamps retained" — forced eviction
    // wins over any in-flight scheduled settle (it is, after all, forced).
    slot.tier = "stub";
    slot.value = undefined;
    slot.scheduled = undefined;
  }

  /** Bulk fault-injection convenience over `evict` — the harness decision's "forced
   *  eviction = drop all in-memory state" knob, at the payload-store grain. */
  async evictAll(): Promise<void> {
    for (const hash of this.payloads.keys()) await this.evict(hash);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TemplateStore fake (Q8b)
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown by `getTemplate` for a hash this store never saw — `PayloadNotFound`'s
 *  template-store analogue (never fabricate a miss as an empty template). */
export class TemplateNotFound extends Error {
  constructor(hash: TemplateHash) {
    super(`TemplateStoreFake: no template ever put under hash ${JSON.stringify(hash)}`);
    this.name = "TemplateNotFound";
  }
}

/** In-memory `TemplateStore`: a `Map<TemplateHash, WireframeGraph>` for the shared
 *  template pool (§5 C4), plus a nested `Map<TemplateHash, Map<pathKey, SiteHash>>`
 *  for the Q8b-amendment reverse index — DERIVABLE data (a caller-computed record,
 *  never invented by this store), kept as an ordinary in-memory map since a fake
 *  needs no persistence story beyond "the harness decision"'s default-CI shape. */
export class TemplateStoreFake implements TemplateStore {
  private readonly templates = new Map<TemplateHash, WireframeGraph>();
  private readonly siteIndex = new Map<TemplateHash, Map<string, SiteHash>>();

  async putTemplate(entry: StoredTemplate): Promise<void> {
    // §5 C4: idempotent upsert by hash — same contract shape as PayloadStore.put.
    this.templates.set(entry.templateHash, entry.graph);
  }

  async getTemplate(hash: TemplateHash): Promise<WireframeGraph> {
    const graph = this.templates.get(hash);
    if (graph === undefined) throw new TemplateNotFound(hash);
    return graph;
  }

  async registerSite(hash: TemplateHash, path: OrdinalPath, site: SiteHash): Promise<void> {
    let byPath = this.siteIndex.get(hash);
    if (byPath === undefined) {
      byPath = new Map();
      this.siteIndex.set(hash, byPath);
    }
    byPath.set(ordinalPathKey(path), site);
  }

  async resolveSite(hash: TemplateHash, path: OrdinalPath): Promise<SiteHash | undefined> {
    return this.siteIndex.get(hash)?.get(ordinalPathKey(path));
  }
}
