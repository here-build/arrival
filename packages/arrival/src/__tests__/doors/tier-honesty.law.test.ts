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

  // @ledger: Q14
  it.todo(
    "the `recorded` and `stub` arms of the envelope are honest against synthetic " +
      "payloads driven through Q10's fakes (`PayloadStoreFake`) BEFORE full production " +
      "emission exists — the `replayed`/`replayed-cached` arms are NOT claimed at this " +
      "gate, only once Q16/Q17 land",
  );
});
