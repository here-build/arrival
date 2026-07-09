/**
 * LAW — W3 port completeness (GREEN at Q11a); stream fold + monotonicity +
 * fold-as-recovery, the I4 async-completion door remain STAGED (docs/PROVENANCE.md
 * §3 I2/I4, §5 "The retrospective stream", §7 law table; docs/PROVENANCE-PLAN.md Q5's
 * stub-file mapping table).
 *
 * Q5 CREATED this file as pure `it.todo` staged spec. W3 flips HERE, at Q11a (real
 * emission hooks: `src/provenance/store/emit.ts`'s `emitMint`/`emitMuxDecision`/
 * `emitFanInstantiation`/`emitIngressBinding`, exercised through the store fakes with
 * fault injection — the SAME idempotent-upsert contract `store/__tests__/emit.test.ts`
 * drives in more detail; these two rows are the LAW-FILE-HOMED assertion of that same
 * property, per Q5's mapping table). Stream fold/monotonicity/fold-as-recovery and the
 * I4 door still flip at Q13 (event-sourced regions + flush — §5 C1: "the SAME fold
 * reconstructs region state on DO wake... T7's fold law is not just a test invariant,
 * it is the recovery mechanism"; §3 I4's completion rule is asserted at Q13
 * specifically because that is where region-close semantics live, per
 * PROVENANCE-PLAN.md's own node table) — those five rows stay `it.todo` below.
 */
import { describe, expect, it } from "vitest";

import { emitFanInstantiation, emitIngressBinding, emitMint, emitMuxDecision, setEmissionEnabled } from "../../provenance/store/emit.js";
import { PayloadStoreFake, ProvenanceStoreFake, ProvenanceWriteFailure } from "../../provenance/store/fakes.js";
import type { RecordId } from "../../provenance/store/ids.js";

describe("W3 port completeness (§7; PROVENANCE-PLAN.md Q11a)", () => {
  const REGION = "w3-region";

  // @ledger: Q11a — LANDED
  it(
    "every mint/decision/instantiation/ingress-binding record is emitted EXACTLY ONCE " +
      "PER RECORD ID — idempotent under request retry/re-emission (a repeated real " +
      "emission call for the same logical event never duplicates in the stream)",
    async () => {
      setEmissionEnabled(true);
      try {
        const store = new ProvenanceStoreFake();
        const payloads = new PayloadStoreFake();
        const mintId: RecordId = { templateHash: "mint", ordinalPath: [0], regionEpoch: "e0" };
        const muxId: RecordId = { templateHash: "mux", ordinalPath: [1], regionEpoch: "e0" };
        const fanId: RecordId = { templateHash: "fan", ordinalPath: [2], regionEpoch: "e0" };
        const ingressId: RecordId = { templateHash: "ingress", ordinalPath: [3], regionEpoch: "e0" };

        // Each kind's emission function called TWICE with the identical RecordId — a
        // re-emission (the retry shape), never a fresh id per call.
        for (let i = 0; i < 2; i++) {
          await emitMint({ store, payloads, regionId: REGION, id: mintId, value: "v", stampIds: [1] });
          await emitMuxDecision({ store, regionId: REGION, id: muxId, arm: 0 });
          await emitFanInstantiation({ store, regionId: REGION, id: fanId });
          await emitIngressBinding({ store, regionId: REGION, id: ingressId });
        }

        const stream = await store.readStream(REGION);
        expect(stream).toHaveLength(4); // one record per DISTINCT id — never per emit call
      } finally {
        setEmissionEnabled(false);
      }
    },
  );

  // @ledger: Q11a — LANDED
  it(
    "W3's exactly-once is exactly-once PER ID, not per write attempt — a CF request " +
      "retry that re-emits the identical record overwrites in place (§5 C2/D1's " +
      "idempotent-upsert contract, exercised through real emission, not just the fake)",
    async () => {
      setEmissionEnabled(true);
      try {
        const store = new ProvenanceStoreFake();
        const payloads = new PayloadStoreFake();
        const id: RecordId = { templateHash: "mint-retry", ordinalPath: [0], regionEpoch: "e0" };

        // The FIRST attempt fails mid-write (the CF-request-retry shape §5 C3 names) —
        // nothing lands.
        store.setWriteFailure(true);
        await expect(
          emitMint({ store, payloads, regionId: REGION, id, value: "v", stampIds: [] }),
        ).rejects.toBeInstanceOf(ProvenanceWriteFailure);
        expect(await store.readStream(REGION)).toHaveLength(0);

        // The RETRY (clearing the fault, re-emitting the identical logical event)
        // succeeds — and a THIRD re-emission after that still overwrites in place,
        // never duplicates.
        store.setWriteFailure(false);
        await emitMint({ store, payloads, regionId: REGION, id, value: "v", stampIds: [] });
        await emitMint({ store, payloads, regionId: REGION, id, value: "v", stampIds: [] });

        const stream = await store.readStream(REGION);
        expect(stream).toHaveLength(1); // exactly once, per id — not per write attempt
      } finally {
        setEmissionEnabled(false);
      }
    },
  );
});

describe("stream fold + monotonicity + fold-as-recovery (§5 C1; PROVENANCE-PLAN.md Q13)", () => {
  // @ledger: Q13
  it.todo(
    "fold(events) = final region state — the SAME fold that answers a post-hoc \"what " +
      "was this region's state\" query also RECONSTRUCTS region state on DO wake after " +
      "eviction/hibernation (§5 C1: \"the law is the recovery mechanism\")",
  );

  // @ledger: Q13
  it.todo(
    "completed ≤ started, monotone, over EVERY emission order — async settlement " +
      "reordering (the stream's total order is settlement order for async, §5 D4) " +
      "never produces a state where more tracks are completed than were ever started",
  );

  // @ledger: Q13
  it.todo(
    "forced mid-run eviction followed by a refold reconstructs the IDENTICAL region " +
      "state the in-memory cache held before eviction — exercised under fault injection " +
      "(in-memory region state is a CACHE of the stream, never the source of truth, " +
      "§5 C1 EXCLUDED: production regions that exist only in memory)",
  );

  // @ledger: Q13
  it.todo(
    "the durable-write barrier: a failed durable write kills the request (never " +
      "silently drops), and the idempotent record id makes the retry's re-emission safe " +
      "(§5 C3 flush policy — port completion barriers on the durable write)",
  );
});

describe("I4 — completion, the async promise-pending door (§3 I4; its test home is Q13)", () => {
  // @ledger: Q13
  it.todo(
    "started = completed at region close — a region with any track still started-but-" +
      "not-completed throws the incomplete door at close time",
  );

  // @ledger: Q13
  it.todo(
    "a promise egress keeps its track PENDING until settled — region close with an " +
      "unsettled promise egress throws the incomplete door (§4 CHOSEN panel C9 async " +
      "rule); this row's test home is deliberately HERE, not in replay.law.test.ts, " +
      "because region-close semantics live where regions themselves live (§5 C1/C3)",
  );
});
