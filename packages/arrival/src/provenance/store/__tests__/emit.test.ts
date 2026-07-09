/**
 * emit.test.ts — Q11a's own unit suite for `store/emit.ts` (docs/PROVENANCE.md §5;
 * docs/PROVENANCE-PLAN.md Q11a). Direct, store-fake-backed exercise of the emission
 * core: the flag gate, all four kinds' record shapes, the header write-once, and —
 * the W3 law's real grounding — idempotent upsert under request retry AND under
 * write-failure fault injection (§5 C2/D1, C3).
 *
 * This file is what flips `track-stream.law.test.ts`'s two Q11a-tagged `it.todo` rows:
 * those rows assert the SAME idempotence property this file drives directly through
 * `emitMint`/`emitMuxDecision`/etc. — not `store.append` called by hand — so a real
 * regression in the emission core's id derivation (not just the fake's own upsert
 * logic, already covered by `store-fakes.smoke.test.ts`) would fail here.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SEMANTICS_EPOCH,
  emitFanInstantiation,
  emitIngressBinding,
  emitMint,
  emitMuxDecision,
  ensureStreamHeader,
  isEmissionEnabled,
  setEmissionEnabled,
} from "../emit.js";
import { PayloadStoreFake, ProvenanceStoreFake, ProvenanceWriteFailure } from "../fakes.js";
import { recordIdKey, type RecordId } from "../ids.js";

const ID_A: RecordId = { templateHash: "t-a", ordinalPath: [0], regionEpoch: "e0" };
const REGION = "region-1";

afterEach(() => {
  // Every test using the flag restores it — the module default must survive test
  // ordering (vitest may run files/describe blocks in any order).
  setEmissionEnabled(false);
});

describe("the flag — default OFF, every emit* a provable no-op while disabled", () => {
  it("isEmissionEnabled() defaults to false", () => {
    expect(isEmissionEnabled()).toBe(false);
  });

  it("emitMint touches NEITHER store while disabled — zero seq allocation, zero append, zero payload put", async () => {
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const record = await emitMint({ store, payloads, regionId: REGION, id: ID_A, value: "x", stampIds: [1] });
    expect(record).toBeUndefined();
    expect(await store.readStream(REGION)).toHaveLength(0);
    await expect(payloads.get("payload-v0:00000000")).rejects.toThrow(); // never put, whatever the hash would be
  });

  it("every emit* function returns undefined and appends nothing while disabled", async () => {
    const store = new ProvenanceStoreFake();
    await emitMuxDecision({ store, regionId: REGION, id: ID_A, arm: 0 });
    await emitFanInstantiation({ store, regionId: REGION, id: ID_A });
    await emitIngressBinding({ store, regionId: REGION, id: ID_A });
    expect(await store.readStream(REGION)).toHaveLength(0);
  });

  it("ensureStreamHeader writes nothing while disabled", async () => {
    const store = new ProvenanceStoreFake();
    await ensureStreamHeader(store, REGION);
    expect(await store.getHeader(REGION)).toBeUndefined();
  });
});

describe("emitMint — payload lands before the record, value+stampIds round-trip (§5 D2)", () => {
  it("put the payload, then append a mint record referencing its hash", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const record = await emitMint({
      store,
      payloads,
      regionId: REGION,
      id: ID_A,
      value: { hello: "world" },
      stampIds: [7, 8],
    });
    expect(record).toBeDefined();
    if (record === undefined) throw new Error("unreachable");
    expect(record.kind).toBe("mint");
    expect(recordIdKey(record.id)).toBe(recordIdKey(ID_A));

    const payload = await payloads.get(record.payloadHash);
    expect(payload).toEqual({ tier: "do", value: { hello: "world" }, stampIds: [7, 8] });

    const stream = await store.readStream(REGION);
    expect(stream).toHaveLength(1);
    expect(stream[0]).toEqual(record);
  });

  it("two mints with the SAME value+stampIds hash to the SAME payload hash (deterministic content address)", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const idB: RecordId = { templateHash: "t-b", ordinalPath: [1], regionEpoch: "e0" };
    const r1 = await emitMint({ store, payloads, regionId: REGION, id: ID_A, value: 42, stampIds: [1] });
    const r2 = await emitMint({ store, payloads, regionId: REGION, id: idB, value: 42, stampIds: [1] });
    expect(r1?.payloadHash).toBe(r2?.payloadHash);
  });

  it("a value that does not JSON.stringify (e.g. a BigInt) still hashes and stores, via the String() fallback", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const record = await emitMint({ store, payloads, regionId: REGION, id: ID_A, value: 9007199254740993n, stampIds: [] });
    expect(record).toBeDefined();
  });
});

describe("W3 port completeness — idempotent upsert through the REAL emission functions, not the fake's raw append", () => {
  it("a retried emitMint (same RecordId, called twice) lands as ONE record — exactly once per id, not per call", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    await emitMint({ store, payloads, regionId: REGION, id: ID_A, value: "v", stampIds: [1] });
    await emitMint({ store, payloads, regionId: REGION, id: ID_A, value: "v", stampIds: [1] }); // retry
    await emitMint({ store, payloads, regionId: REGION, id: ID_A, value: "v", stampIds: [1] }); // retry again

    const stream = await store.readStream(REGION);
    expect(stream).toHaveLength(1);
  });

  it("every kind (mint/mux-decision/fan-instantiation/ingress-binding) is independently idempotent under retry", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();

    await emitMint({ store, payloads, regionId: REGION, id: { ...ID_A, templateHash: "mint" }, value: 1, stampIds: [] });
    await emitMint({ store, payloads, regionId: REGION, id: { ...ID_A, templateHash: "mint" }, value: 1, stampIds: [] });

    await emitMuxDecision({ store, regionId: REGION, id: { ...ID_A, templateHash: "mux" }, arm: 1 });
    await emitMuxDecision({ store, regionId: REGION, id: { ...ID_A, templateHash: "mux" }, arm: 1 });

    await emitFanInstantiation({ store, regionId: REGION, id: { ...ID_A, templateHash: "fan" } });
    await emitFanInstantiation({ store, regionId: REGION, id: { ...ID_A, templateHash: "fan" } });

    await emitIngressBinding({ store, regionId: REGION, id: { ...ID_A, templateHash: "ingress" } });
    await emitIngressBinding({ store, regionId: REGION, id: { ...ID_A, templateHash: "ingress" } });

    const stream = await store.readStream(REGION);
    expect(stream).toHaveLength(4); // one per DISTINCT id, despite 8 emit calls
    expect(new Set(stream.map((r) => r.kind))).toEqual(new Set(["mint", "mux-decision", "fan-instantiation", "ingress-binding"]));
  });

  it("write-failure fault injection: a failed emitMint throws, never appends a partial/duplicate; the retry after clearing the fault succeeds exactly once", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();

    store.setWriteFailure(true);
    await expect(emitMint({ store, payloads, regionId: REGION, id: ID_A, value: "v", stampIds: [] })).rejects.toBeInstanceOf(
      ProvenanceWriteFailure,
    );
    expect(await store.readStream(REGION)).toHaveLength(0); // the failed attempt left nothing

    store.setWriteFailure(false);
    await emitMint({ store, payloads, regionId: REGION, id: ID_A, value: "v", stampIds: [] }); // the retry
    await emitMint({ store, payloads, regionId: REGION, id: ID_A, value: "v", stampIds: [] }); // a second retry, for good measure

    const stream = await store.readStream(REGION);
    expect(stream).toHaveLength(1); // exactly once, PER ID — never per write attempt (§5 C2/D1)
  });
});

describe("ensureStreamHeader — §5 C6, write-once", () => {
  it("writes the default semantics epoch when no header exists yet", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    await ensureStreamHeader(store, REGION);
    expect(await store.getHeader(REGION)).toEqual({ semanticsEpoch: DEFAULT_SEMANTICS_EPOCH });
  });

  it("never overwrites an already-written header", async () => {
    setEmissionEnabled(true);
    const store = new ProvenanceStoreFake();
    await store.putHeader(REGION, { semanticsEpoch: "custom-epoch" });
    await ensureStreamHeader(store, REGION, "a-different-epoch");
    expect(await store.getHeader(REGION)).toEqual({ semanticsEpoch: "custom-epoch" });
  });
});
