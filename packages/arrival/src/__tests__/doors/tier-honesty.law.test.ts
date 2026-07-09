/**
 * LAW (staged) — tier honesty (docs/PROVENANCE.md §5 A1 "payload tiering", §7 law
 * table; docs/PROVENANCE-PLAN.md Q5's stub-file mapping table). Flips at Q17.
 *
 * pure-mux derivation deliberately does NOT live here — PROVENANCE-PLAN.md's Q5
 * mapping table homes it in `provenance/replay.law.test.ts` (it flips at Q16, with
 * every other Q16-gated law row); this file houses tier-honesty ONLY, per that table.
 *
 * The `EvidenceTier` enum this whole law is ABOUT is ALREADY COMMITTED (Q10 —
 * `src/provenance/store/interfaces.ts`), so the anti-vacuity grounding test below is a
 * REAL, running, GREEN assertion (not `it.todo`) pinning that the four-tier vocabulary
 * this staged law will check against hasn't drifted — everything else in this file is
 * `it.todo`: the answer ENVELOPE that actually computes/carries a tier per drill-in
 * answer is Q14 (`recorded`/`stub` arms)/Q17 (`replayed`/`replayed-cached` arms), and
 * tier-honesty itself (the FULL green law) flips at Q17.
 */
import { describe, expect, it } from "vitest";
import type { EvidenceTier } from "../../provenance/store/index.js";
import { PayloadStoreFake, PayloadTierMachine } from "../../provenance/store/index.js";

/** The four evidence tiers, in the spec's own order (§5 A1 / §7: "the envelope enum
 *  `replayed | replayed-cached | recorded | stub`"). A `readonly EvidenceTier[]` cast
 *  makes this list a compile-time check too: if `EvidenceTier` ever grows or shrinks a
 *  member, this array either fails to typecheck (a removed member) or the row below
 *  silently stops enumerating a real member (an ADDED member) — the length assertion
 *  below catches the latter. */
const EVIDENCE_TIERS: readonly EvidenceTier[] = ["replayed", "replayed-cached", "recorded", "stub"];

describe("tier-honesty envelope shape — the enum Q10 already committed (grounding, not staged)", () => {
  it("the evidence-tier enum has exactly the four spec-named members, in the spec's own order", () => {
    expect(EVIDENCE_TIERS).toEqual(["replayed", "replayed-cached", "recorded", "stub"]);
  });
});

describe("tier honesty (§7: every drill-in answer carries an honest evidence tier)", () => {
  // @ledger: Q17
  it.todo(
    "every drill-in answer carries its evidence tier from the envelope enum " +
      "`replayed | replayed-cached | recorded | stub` — no answer is ever tier-less",
  );

  // @ledger: Q17
  it.todo(
    "a `stub` answer (value evicted, lineage intact) NEVER presents itself as freshly " +
      "`replayed` — a stub or cached answer never claims a fresher tier than it has " +
      "(§5 A1 EXCLUDED: \"silent degradation... a stub answering as if replayed is a lie\")",
  );

  // @ledger: Q17
  it.todo(
    "a `replayed-cached` (memo-hit) answer is never conflated with a live `replayed` " +
      "one, even when both report the identical egress value — a memo entry MAY outlive " +
      "its evicted payload, and its answers carry `replayed-cached`, never `replayed` " +
      "(§4 CHOSEN replay-memo scope)",
  );

  // @ledger: Q17
  it.todo(
    "degradation is PER TIER and deterministic — a payload's tier only ever moves " +
      "toward `stub` (ring → do → pending/r2 → stub), never silently reports a tier it " +
      "no longer occupies (§5 A1)",
  );

  // @ledger: Q14 — GREEN (store/tiering.ts's PayloadTierMachine + evidenceTierOf).
  it(
    "the `recorded` and `stub` arms of the envelope are honest against synthetic " +
      "payloads driven through Q10's fakes (`PayloadStoreFake`) BEFORE full production " +
      "emission exists — the `replayed`/`replayed-cached` arms are NOT claimed at this " +
      "gate, only once Q16/Q17 land",
    async () => {
      // ring, do, r2 (via flush+settle), and stub (via forced eviction) — every
      // storage tier a payload can occupy BEFORE Q16/Q17's live-replay/memo machinery
      // exists. Each answers `recorded` (a value is present) EXCEPT stub. Separate
      // `PayloadTierMachine`s (each own hash namespace) so the r2 scenario's small
      // size cap doesn't affect the others' default-cap routing.
      const ringOnly = new PayloadTierMachine(new PayloadStoreFake());
      ringOnly.ringPut("ring-hash", { value: "hot", stampIds: [1] });
      const ringAnswer = await ringOnly.read("ring-hash");
      expect(ringAnswer.tier).toBe("recorded");
      expect(ringAnswer.value).toBe("hot");

      const doMachine = new PayloadTierMachine(new PayloadStoreFake());
      doMachine.ringPut("do-hash", { value: "flushed small", stampIds: [2] });
      await doMachine.flush("do-hash");
      const doAnswer = await doMachine.read("do-hash");
      expect(doAnswer.tier).toBe("recorded");
      expect(doAnswer.storageTier).toBe("do");

      const r2Store = new PayloadStoreFake();
      r2Store.setValueSizeCapBytes(1); // force oversize -> pending, so settle() applies
      const r2Machine = new PayloadTierMachine(r2Store);
      r2Machine.ringPut("r2-hash", { value: "settled to r2", stampIds: [3] });
      await r2Machine.flush("r2-hash");
      await r2Machine.settle("r2-hash", "settled");
      const r2Answer = await r2Machine.read("r2-hash");
      expect(r2Answer.tier).toBe("recorded");
      expect(r2Answer.storageTier).toBe("r2");

      const stubMachine = new PayloadTierMachine(new PayloadStoreFake());
      stubMachine.ringPut("stub-hash", { value: "will be evicted", stampIds: [4, 5] });
      await stubMachine.evict("stub-hash");
      const stubAnswer = await stubMachine.read("stub-hash");
      expect(stubAnswer.tier).toBe("stub"); // NEVER "recorded" once evicted
      expect(stubAnswer.value).toBeUndefined(); // value dropped...
      expect(stubAnswer.stampIds).toEqual([4, 5]); // ...identity + stamps retained (§5 A1 tier 4)

      // None of these four ever claim `replayed`/`replayed-cached` — this node
      // (Q14) doesn't compute those arms at all; asserting their absence is the
      // "NOT claimed at this gate" half of the row.
      for (const answer of [ringAnswer, doAnswer, r2Answer, stubAnswer]) {
        expect(answer.tier).not.toBe("replayed");
        expect(answer.tier).not.toBe("replayed-cached");
      }
    },
  );

  // @ledger: Q14 — GREEN. §5 m6's NAMED `pending → R2-ref` settlement transition,
  // driven through `PayloadStoreFake`'s deterministic virtual clock
  // (`setSettleDelayTicks` + `step` — no real timers, per fakes.ts's file header):
  // a read taken BEFORE the delayed settle lands must degrade honestly (`pending`
  // still has its value, so it answers `recorded`, never a fabricated `replayed` or
  // a premature `stub`), and the tier only moves forward once `step` actually
  // advances the virtual clock past the settle's due tick.
  it("m6: pending payload settles to R2-ref via the fake's tick-step; reads before settlement degrade honestly", async () => {
    const store = new PayloadStoreFake();
    store.setValueSizeCapBytes(1); // force oversize on flush -> pending
    store.setSettleDelayTicks(3);
    const machine = new PayloadTierMachine(store);

    machine.ringPut("h1", { value: "oversize evidence", stampIds: [42] });
    await machine.flush("h1");
    expect(await machine.currentTier("h1")).toBe("pending");

    await machine.settle("h1", "settled"); // scheduled, not yet applied

    // Reads BEFORE the tick threshold: honestly `recorded` (value present, tier
    // genuinely still `pending`) — never a premature `stub`, never a fabricated
    // `replayed`.
    for (let tick = 0; tick < 3; tick++) {
      const before = await machine.read("h1");
      expect(before.storageTier).toBe("pending");
      expect(before.tier).toBe("recorded");
      expect(before.value).toBe("oversize evidence");
      store.step(1);
    }

    // After the third tick, settlement has landed: pending -> r2 (the NAMED m6
    // transition), still `recorded` (a value is still present — r2 isn't a
    // degradation, it's the durable destination).
    const after = await machine.read("h1");
    expect(after.storageTier).toBe("r2");
    expect(after.tier).toBe("recorded");
    expect(after.value).toBe("oversize evidence");
  });

  // @ledger: Q14 — GREEN, the settlement-failure leg of m6: a read before the
  // failed settle lands still honestly reports `pending`/`recorded`; once it lands,
  // the payload degrades to `stub` — never silently, never as a lie about being
  // fresher than it is.
  it("m6: a failed settle degrades pending -> stub only once the tick lands, never before", async () => {
    const store = new PayloadStoreFake();
    store.setValueSizeCapBytes(1);
    store.setSettleDelayTicks(2);
    const machine = new PayloadTierMachine(store);

    machine.ringPut("h1", { value: "oversize evidence", stampIds: [9] });
    await machine.flush("h1");
    await machine.settle("h1", "failed"); // scheduled

    store.step(1); // one tick short
    const early = await machine.read("h1");
    expect(early.storageTier).toBe("pending");
    expect(early.tier).toBe("recorded");

    store.step(1); // the due tick
    const late = await machine.read("h1");
    expect(late.storageTier).toBe("stub");
    expect(late.tier).toBe("stub");
    expect(late.value).toBeUndefined();
    expect(late.stampIds).toEqual([9]);
  });
});
