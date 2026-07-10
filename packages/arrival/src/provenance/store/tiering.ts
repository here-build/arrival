/**
 * store/tiering.ts — payload tiering. Built and gated against
 * `PayloadStoreFake`'s synthetic payloads; full production wiring (real
 * emission driving `ringPut`/`flush`, and a live γ-replay or memo-hit
 * computing the `replayed`/`replayed-cached` envelope arms) is a later
 * concern.
 *
 * ── The state machine ──────────────────────────────────────────────────────────
 * `PayloadTier` (`ring | do | pending | r2 | stub`, interfaces.ts) is the STORAGE
 * tier. `do`/`pending`/`r2`/`stub` and the NAMED `pending → r2` settlement transition
 * are already `PayloadStore`'s contract (`fakes.ts`) — this module does not
 * re-implement that leg, it delegates. This module's OWN job is the ONE tier
 * `PayloadStore` doesn't model: `ring` ("in-memory ring, hot, bounded" —
 * a layer ABOVE the DO/R2 store), plus the read-side envelope every tier feeds.
 *
 *   ring --flush(fits size cap)-------> do   --evict--> stub
 *   ring --flush(oversize)------------> pending --settle("settled")--> r2 --evict--> stub
 *                                       pending --settle("failed")----------------> stub
 *   ring --evict (pre-flush, never durable)-----------------------------------> stub
 *
 * Every transition moves strictly toward `stub`, WRONG-STATE-IMPOSSIBLE BY
 * CONSTRUCTION rather than by runtime check: there is no "un-evict"/"un-flush" method
 * on this class or on `PayloadStore` — silent degradation is excluded by design;
 * tier-honesty: "a payload's tier only ever moves toward stub, never silently
 * reports a tier it no longer occupies."
 *
 * ── The answer envelope ────────────────────────────────────────────────────────
 * "An answer states its evidence tier from the enum `replayed |
 * replayed-cached | recorded | stub`." This module owns the `recorded`/`stub` arms
 * ONLY:
 *   - any storage tier where a VALUE is present (`ring`/`do`/`pending`/`r2`) answers
 *     `recorded` — we have the payload, whether or not it is durably in R2 yet;
 *   - `stub` (value evicted) answers `stub` — "value evicted, lineage intact."
 * The fuller envelope (`replay-memo.ts`) SUPERSEDES a `recorded` answer with
 * `replayed`/`replayed-cached` when a live replay or memo hit served the read instead
 * of a raw payload fetch — this module never claims either of those two arms itself
 * (tier-honesty applied to this module's own boundary: never a tier it didn't itself
 * compute).
 *
 * `PayloadEvidenceEnvelope` is deliberately the shape the fuller query envelope
 * will WRAP, not duplicate — that layer adds the walk/memo machinery around a
 * read that still bottoms out here for its `recorded`/`stub` arms.
 */
import type { PayloadHash } from "./ids.js";
import type { Payload, PayloadStore, PayloadTier, EvidenceTier, RetentionClass } from "./interfaces.js";
import type { TierGate } from "../../values/egress-proxy.js";

/** One ring-resident payload — this module's own bookkeeping, never durable until
 *  `flush`. `stubbed` distinguishes a pre-flush FORCED eviction (applied
 *  to a payload that never reached the store) from the ordinary ring-resident case;
 *  once `stubbed`, the slot is functionally a `stub` record forever (no un-evict). */
interface RingSlot {
  readonly value: unknown;
  readonly stampIds: readonly number[];
  readonly retention: RetentionClass;
  stubbed: boolean;
}

/** Map a STORAGE tier to the EVIDENCE tier a `recorded`/`stub`-arm answer
 *  carries. Exhaustive switch (house style — `records.ts`'s `assertNeverRecord`) so a
 *  future `PayloadTier` member is a compile error here, not a silently-wrong mapping. */
export function evidenceTierOf(storageTier: PayloadTier): EvidenceTier {
  switch (storageTier) {
    case "ring":
    case "do":
    case "pending":
    case "r2":
      return "recorded";
    case "stub":
      return "stub";
    default: {
      const exhaustive: never = storageTier;
      throw new Error(`evidenceTierOf: unhandled PayloadTier ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** The payload-side read result: the answer's `EvidenceTier` (the fuller query
 *  envelope will wrap this), the underlying STORAGE tier that produced it (honest
 *  extra detail — reporting more than tier-honesty requires is never a violation of
 *  it), and the value/stampIds/retention triple that survives every tier per
 *  this module's privacy-LIMIT plumbing. */
export interface PayloadEvidenceEnvelope {
  readonly tier: EvidenceTier;
  readonly storageTier: PayloadTier;
  readonly value: unknown | undefined;
  readonly stampIds: readonly number[];
  readonly retention: RetentionClass;
}

/** Thrown by `flush`/ring-read operations for a hash this machine never saw
 *  ring-resident — `PayloadNotFound`'s (fakes.ts) analogue at this layer: never
 *  fabricate ring residency for an unknown hash. */
export class PayloadNotRingResident extends Error {
  constructor(hash: PayloadHash) {
    super(`PayloadTierMachine: hash ${JSON.stringify(hash)} is not ring-resident`);
    this.name = "PayloadNotRingResident";
  }
}

/**
 * The tier-1 (`ring`) owner, wrapping a `PayloadStore` (tiers 2-4: `do`/`pending`/
 * `r2`/`stub`) for everything past the ring. Built and gated against
 * `PayloadStoreFake` with synthetic payloads — a real adapter satisfies the
 * same `PayloadStore` contract, so this class is unchanged at integration time.
 */
export class PayloadTierMachine {
  private readonly ring = new Map<PayloadHash, RingSlot>();

  constructor(private readonly store: PayloadStore) {}

  /** Land a payload ring-resident — hot, not yet durable. Idempotent
   *  upsert by hash (same contract shape as `PayloadStore.put`) as long as the hash
   *  isn't ALREADY flushed (once flushed, the store — not this ring — is the tier's
   *  source of truth; re-`ringPut`ing a flushed hash would silently resurrect a
   *  payload that already moved past `ring`, violating "moves toward stub only"). */
  ringPut(hash: PayloadHash, payload: Payload): void {
    this.ring.set(hash, {
      value: payload.value,
      stampIds: payload.stampIds,
      retention: payload.retention ?? "standard",
      stubbed: false,
    });
  }

  /** Flush a ring-resident payload to the durable store —
   *  delegates entirely to `PayloadStore.put` (small-vs-oversize routing to
   *  `do`/`pending` is THAT contract's job, never duplicated here). The ring no
   *  longer holds this hash afterward: the store becomes the tier's source of truth,
   *  and `currentTier`/`read` fall through to it. Throws `PayloadNotRingResident` if
   *  `hash` was never `ringPut` (including: already flushed, or force-stubbed
   *  pre-flush — a stubbed ring slot never reaches the store, per the state
   *  machine's doc above). */
  async flush(hash: PayloadHash): Promise<void> {
    const slot = this.ring.get(hash);
    if (slot === undefined || slot.stubbed) throw new PayloadNotRingResident(hash);
    await this.store.put(hash, { value: slot.value, stampIds: slot.stampIds, retention: slot.retention });
    this.ring.delete(hash);
  }

  /** Settle a `pending` (oversize, awaiting-R2) payload — pure delegation,
   *  this machine adds no policy beyond `PayloadStore.settle`'s own contract
   *  ("settled" → `r2`; "failed" → `stub` under tier honesty). Only meaningful once a
   *  payload has been `flush`ed past the ring (a ring-resident payload was never
   *  `put`, so it can never be `pending`) — `PayloadStore.settle`'s own "throws if
   *  never pending" door covers the rest. */
  async settle(hash: PayloadHash, outcome: "settled" | "failed"): Promise<void> {
    await this.store.settle(hash, outcome);
  }

  /** Force-evict from ANY tier, including pre-flush ring-resident (never durable —
   *  applied a layer up from `PayloadStore.evict`). A ring-resident
   *  eviction degrades LOCALLY (the store never saw this hash — nothing to tell it);
   *  a flushed hash delegates to `PayloadStore.evict`. Either way: "value dropped,
   *  identity + stamps retained." */
  async evict(hash: PayloadHash): Promise<void> {
    const slot = this.ring.get(hash);
    if (slot !== undefined) {
      slot.stubbed = true;
      return;
    }
    await this.store.evict(hash);
  }

  /** The hash's current STORAGE tier — `"ring"` while ring-resident-and-not-stubbed,
   *  `"stub"` for a ring-resident payload force-evicted pre-flush, else whatever
   *  `PayloadStore.get` reports (`do`/`pending`/`r2`/`stub`). Throws (propagated from
   *  `PayloadStore.get`) for a hash this machine never saw at all — never fabricates
   *  a tier for an unknown hash, matching `PayloadStore`'s own convention. */
  async currentTier(hash: PayloadHash): Promise<PayloadTier> {
    const slot = this.ring.get(hash);
    if (slot !== undefined) return slot.stubbed ? "stub" : "ring";
    return (await this.store.get(hash)).tier;
  }

  /** The full payload-side read — tier-honest by construction, since it
   *  is the SAME switch (`evidenceTierOf`) every tier, ring included, is computed
   *  through. */
  async read(hash: PayloadHash): Promise<PayloadEvidenceEnvelope> {
    const slot = this.ring.get(hash);
    if (slot !== undefined) {
      const storageTier: PayloadTier = slot.stubbed ? "stub" : "ring";
      return {
        tier: evidenceTierOf(storageTier),
        storageTier,
        value: slot.stubbed ? undefined : slot.value,
        stampIds: slot.stampIds,
        retention: slot.retention,
      };
    }
    const rec = await this.store.get(hash);
    return {
      tier: evidenceTierOf(rec.tier),
      storageTier: rec.tier,
      value: rec.value,
      stampIds: rec.stampIds,
      retention: rec.retention,
    };
  }

  /** Resolve several hashes' CURRENT envelopes ahead of time — the async pre-pass a
   *  synchronous `TierGate` (egress-proxy.ts) needs, since Proxy traps cannot await.
   *  Unknown hashes are simply absent from the returned map (never thrown through a
   *  batch — a caller building a gate over a mixed known/unknown key set treats
   *  "absent" as "not payload-tracked," matching `tierGateFromSnapshot`'s doc). */
  async snapshot(hashes: readonly PayloadHash[]): Promise<ReadonlyMap<PayloadHash, PayloadEvidenceEnvelope>> {
    const out = new Map<PayloadHash, PayloadEvidenceEnvelope>();
    for (const hash of hashes) {
      try {
        out.set(hash, await this.read(hash));
      } catch {
        // Unknown hash — never fabricated into the snapshot (PayloadStore.get's own
        // "throws on unknown, never a fabricated stub" convention, propagated here).
      }
    }
    return out;
  }
}

/**
 * The egress-proxy integration: builds the
 * `TierGate` `egress-proxy.ts`'s `egressContainerProxy` consumes, from a pre-resolved
 * `PayloadTierMachine.snapshot` and a caller-supplied `keyToHash` — the proxy's
 * `EgressReader` keys are container-shape keys (array indices / object property
 * names), not payload hashes, so this is the ADDITIVE seam: a key with no known
 * payload hash (`keyToHash` returns `undefined`) always passes through ungated —
 * this machine has no opinion on non-payload-backed elements. When every tracked
 * hash's envelope reports `tier !== "stub"` (e.g. every payload is ring-resident),
 * `allows` is `true` for every key — the gate is a pure pass-through, byte-stable.
 */
export function tierGateFromSnapshot(
  keyToHash: (key: string) => PayloadHash | undefined,
  snapshot: ReadonlyMap<PayloadHash, PayloadEvidenceEnvelope>,
): TierGate {
  return {
    allows(key: string): boolean {
      const hash = keyToHash(key);
      if (hash === undefined) return true; // not payload-tracked — never gated
      const entry = snapshot.get(hash);
      return entry === undefined || entry.tier !== "stub";
    },
    stubbedValue(key: string): unknown {
      const hash = keyToHash(key);
      const entry = hash === undefined ? undefined : snapshot.get(hash);
      // "Value dropped, identity + stamps retained," made machine-readable:
      // identity (the hash) + stamps survive; the value itself does not.
      return { "provenance/tier": "stub" as const, payloadHash: hash, stampIds: entry?.stampIds ?? [] };
    },
  };
}
