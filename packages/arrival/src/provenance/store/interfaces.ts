/**
 * store/interfaces.ts — the two storage PORTS the DO surface is built interface-first
 * against (PROVENANCE-PLAN.md's harness decision, docs/PROVENANCE.md §5): `ProvenanceStore`
 * (DO-storage-shaped: append/read/upsert/seq/header) and `PayloadStore` (R2-shaped:
 * put/get by hash, async settle, tiered degradation). Law and unit tests run against
 * `fakes.ts`'s in-memory implementations with fault injection — default CI, no cloud.
 * A workerd adapter proving these same contracts against real DO/R2 is Q19's concern,
 * not this node's.
 */
import type { OrdinalPath, PayloadHash, RegionId, RegionSeq, SiteHash, TemplateHash } from "./ids.js";
import type { ProvenanceRecord } from "./records.js";
import type { WireframeGraph } from "../wireframe/types.js";

/** §5 C6: "the stream header records the interpreter version (semantics epoch)."
 *  One header per region's stream, written once at region-open; Q18's offload
 *  protocol reads it to refuse (or sampled-verify) a stale replay request. */
export interface StreamHeader {
  readonly semanticsEpoch: string;
}

/** §5 D2: "a persisted payload is the VALUE plus its STAMP IDS" — the write/read
 *  round-trip unit containment laws at replay need (the stamp ids are the eager-
 *  oracle's numeric ids, `AValue.provenance`'s TEST-ONLY today, `op-helpers.ts`). */
export interface Payload {
  readonly value: unknown;
  readonly stampIds: readonly number[];
}

/** §5 A1's four-stage tiering pipeline: `ring` (in-memory, hot, bounded) → `do` (DO
 *  storage, fits the per-value size cap) → `pending`/`r2` (oversize, async R2
 *  settlement per m6's named `pending → R2-ref` transition) → `stub` (evicted; value
 *  dropped, identity + stamps retained). */
export type PayloadTier = "ring" | "do" | "pending" | "r2" | "stub";

/** §6/§5 A1's answer-envelope evidence tier — reproduced here (read-only reference)
 *  because `PayloadTier` state feeds it directly; the OWNING definition (the full
 *  answer envelope, `replayed`/`replayed-cached` distinguishing live-γ from memo-hit)
 *  is Q14/Q17's (`store/tiering.ts`, `replay-memo.ts`) — this store never computes it. */
export type EvidenceTier = "replayed" | "replayed-cached" | "recorded" | "stub";

/** A `PayloadStore.get` snapshot. §5 A1 tier 4: "value dropped, identity + stamps
 *  retained" — `value` is `undefined` at `stub` (and nowhere else); `stampIds`
 *  survives every tier including `stub` (small, identity-bearing, never evicted). */
export interface PayloadRecord {
  readonly tier: PayloadTier;
  readonly value: unknown | undefined;
  readonly stampIds: readonly number[];
}

/** DO-storage-shaped port. `regionId` (see `ids.ts`) selects which region's stream;
 *  a `RecordId`'s `regionEpoch` component (opaque, minted upstream) disambiguates
 *  records within that region's lifetime across reopens — this store does not
 *  interpret it, only stores/returns it verbatim as part of each record's id. */
export interface ProvenanceStore {
  /** §5 C2/D1: idempotent UPSERT keyed by `record.id` — "CF request retries and
   *  multi-request programs re-emit safely"; two `append`s with the same id are one
   *  record (the second overwrites, assumed-identical content), never a duplicate.
   *  §5 C3: a failed write must abort the request (the fake's write-failure knob
   *  models this) — the caller relies on `append` throwing, never silently dropping. */
  append(regionId: RegionId, record: ProvenanceRecord): Promise<void>;

  /** §5 D4: "per-region monotonic sequence" — allocate the next `seq` for a record
   *  about to be appended to `regionId`. Monotonic for the region's WHOLE lifetime
   *  (never resets on reopen — `RegionEpoch` disambiguates reopens, not this counter).
   *  Callers must allocate once per logical record and reuse that `seq` across a
   *  retry (re-`append`ing the identical record) — this store guarantees id-dedup,
   *  not "the same seq comes back if you call this twice." */
  allocateSeq(regionId: RegionId): Promise<RegionSeq>;

  /** §5 D4: the region's total order, EMISSION order (settlement order for async) —
   *  returned sorted by `seq` ascending. §5 C1: this is what fold-as-recovery
   *  replays after a DO wake/eviction to reconstruct region state; "the stream IS
   *  the durable region state," never a derived cache. */
  readStream(regionId: RegionId): Promise<readonly ProvenanceRecord[]>;

  /** §5 C6: read the region's stream header (`undefined` before it has been written). */
  getHeader(regionId: RegionId): Promise<StreamHeader | undefined>;

  /** §5 C6: write the region's stream header — called once, at region-open. */
  putHeader(regionId: RegionId, header: StreamHeader): Promise<void>;
}

/** R2-shaped port, content-addressed by `PayloadHash`. §5 A1's tiering state machine
 *  lives behind this contract; `tiering.ts`'s (Q14) fuller policy/envelope wraps it,
 *  never replaces it. */
export interface PayloadStore {
  /** §5 A1 tiers 1-2: persist a payload. Idempotent by hash — same hash assumed same
   *  content, a re-`put` is a no-op-shaped overwrite, never a duplicate. Lands at tier
   *  `do` if the value fits the store's size cap, `pending` (awaiting R2 settlement)
   *  if oversize — the size cap itself is a fake-only fault-injection knob (`fakes.ts`);
   *  a real adapter's cap is DO storage's own per-value limit (§5 A1 point 2). */
  put(hash: PayloadHash, payload: Payload): Promise<void>;

  /** §5 A1: "drill-in degrades PER TIER, deterministically, and NEVER silently" — read
   *  back whatever tier the payload currently lives at. Throws if `hash` was never
   *  `put` (never returns a fabricated `stub` for an unknown hash — that would conflate
   *  "we don't have this" with "we had this and evicted it"). */
  get(hash: PayloadHash): Promise<PayloadRecord>;

  /** §5 m6: settle a `pending` (oversize, awaiting-R2) payload — idempotent upsert to
   *  `r2` on `"settled"`, or degrade to `stub` on `"failed"` ("on R2 failure the
   *  payload degrades to stub under tier honesty"). No-op-shaped if already settled
   *  to the SAME outcome; throws if called on a payload that was never `pending`. */
  settle(hash: PayloadHash, outcome: "settled" | "failed"): Promise<void>;

  /** §5 A1 tier 4: force-evict to hash-only stub from ANY tier — "value dropped,
   *  identity + stamps retained." Models both real eviction policy (memory pressure)
   *  and the fault-injection "forced eviction" knob the law tests drive. */
  evict(hash: PayloadHash): Promise<void>;
}

/** §5 C4: "the template store is shared and immutable: wire templates + prelude live
 *  in a cross-DO store (KV/R2) keyed by template-hash." One `StoredTemplate` per
 *  `WireframeGraph` the wireframe builder emits (`WireframeProgram.main`, one per
 *  `DefineTemplate`, or a fan node's private `template` interior) — `templateHash` is
 *  `wireframe/hash.ts`'s `hashGraph(graph)`, so a re-`put` of a structurally-identical
 *  graph is a same-hash no-op, matching "identical across every DO running the
 *  program version." */
export interface StoredTemplate {
  readonly templateHash: TemplateHash;
  readonly graph: WireframeGraph;
}

/** Q8b's TEMPLATE STORE port — the DO-storage-shaped seam `hashGraph`/`siteHash`
 *  (`wireframe/hash.ts`) feed. Docs/PROVENANCE-PLAN.md Q8b's AMENDMENT (elk-render
 *  research, `docs/working-proposals/inhuman-elk-over-provenance.md`): "records key on
 *  template-hash + ordinal-path, the plane keys on site-hash... the template-store
 *  interface must expose ordinal-path → site-hash resolution (a DERIVABLE index, not
 *  new stored state)." `registerSite`/`resolveSite` are that reverse index: DERIVABLE
 *  because a `siteHash` is a pure function of (`templateHash`, instantiation span) —
 *  this store never invents one, it only remembers what a caller (the wireframe
 *  builder, which still holds live spans before `hashGraph` strips them) already
 *  computed, so the mapping could always be recomputed from the wireframe + its
 *  original spans rather than needing independent versioning. */
export interface TemplateStore {
  /** Persist a template's graph, keyed by its own hash. Idempotent by hash — same
   *  contract shape as `PayloadStore.put`: a re-`put` of the SAME hash is assumed
   *  identical content, never a duplicate. */
  putTemplate(entry: StoredTemplate): Promise<void>;

  /** Read a template's graph by hash. Throws if never `put` — `PayloadStore.get`'s
   *  convention (never fabricate a miss as an empty/absent template). */
  getTemplate(hash: TemplateHash): Promise<WireframeGraph>;

  /** Register ONE occurrence's reverse-index row: this `(templateHash, ordinalPath)`
   *  coordinate renders at this `SiteHash`. Called once per static site the builder
   *  discovers — potentially MANY per `templateHash` (dedup means one template may be
   *  instantiated at several sites; §5 D3: "the same expression at two program sites
   *  shares storage"... "the two sites render as two wires"). Idempotent — the same
   *  triple re-registered is a no-op; a DIFFERENT site registered under an
   *  already-registered `(hash, path)` pair overwrites (last-registered wins, mirroring
   *  every other upsert-by-key contract in this store family). */
  registerSite(hash: TemplateHash, path: OrdinalPath, site: SiteHash): Promise<void>;

  /** The reverse index itself: resolve a record's `(templateHash, ordinalPath)`
   *  coordinate to the `SiteHash` the plane renders it at. `undefined` if no site was
   *  ever registered for that exact pair (a caller never wired `registerSite` through
   *  for it, or the coordinate doesn't correspond to any real designated node). */
  resolveSite(hash: TemplateHash, path: OrdinalPath): Promise<SiteHash | undefined>;
}
