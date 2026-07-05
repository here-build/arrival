// The FUTILITY DOOR's pure shape-logic (futility.ts + doors.ts futile/duplicate generators).
// Split from arrival-manifold's `futility.test.ts` (2026-07-05 package split): the full MCP-wiring
// half (a real upstream + a real manifold server observing the advisory Note: blocks) stays in
// arrival-manifold (server.ts/manifold-tool.ts are binder-owned); this half tests `FutilityTracker`
// and `normalizeResultText` directly, with no MCP transport at all.

import { describe, expect, it } from "vitest";

import { FutilityTracker, normalizeResultText } from "../futility.js";

describe("normalizeResultText", () => {
  it("washes out digit runs, so timestamp-only differences collapse", () => {
    expect(normalizeResultText("retry in 3 minutes")).toBe(normalizeResultText("retry in 5 minutes"));
    expect(normalizeResultText("rate limited, retry after 100")).toBe(
      normalizeResultText("rate limited, retry after 999999"),
    );
  });

  it("washes out UUIDs and long hex runs", () => {
    expect(normalizeResultText("request 550e8400-e29b-41d4-a716-446655440000 failed")).toBe(
      normalizeResultText("request 6ba7b810-9dad-11d1-80b4-00c04fd430c8 failed"),
    );
    expect(normalizeResultText("trace deadbeefcafebabefeed done")).toBe(normalizeResultText("trace done"));
  });

  it("keeps genuinely different prose distinct", () => {
    expect(normalizeResultText("no results found")).not.toBe(normalizeResultText("here are your results"));
  });
});

describe("FutilityTracker (pure)", () => {
  it("queues one futile-retry door on the 3rd identical result across distinct args", () => {
    const t = new FutilityTracker();
    t.record("srv_search", { q: "a" }, "no results");
    t.record("srv_search", { q: "b" }, "no results");
    expect(t.drainPending()).toHaveLength(0);
    t.record("srv_search", { q: "c" }, "no results");
    const drained = t.drainPending();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.door.code).toBe("envelope/futile-retry");
    expect(drained[0]!.tool).toBe("srv_search");
  });

  it("queues a duplicate-call door on identical (args,result) repeat, and does not re-fire", () => {
    const t = new FutilityTracker();
    t.record("srv_x", { q: "a" }, "body");
    t.record("srv_x", { q: "a" }, "body");
    const first = t.drainPending();
    expect(first).toHaveLength(1);
    expect(first[0]!.door.code).toBe("envelope/duplicate-call");
    t.record("srv_x", { q: "a" }, "body"); // still identical — no re-fire
    expect(t.drainPending()).toHaveLength(0);
  });

  it("re-fire gate RESETS once the result hash changes, allowing a later fresh fire", () => {
    const t = new FutilityTracker();
    t.record("srv_x", { q: "a" }, "body");
    t.record("srv_x", { q: "a" }, "body");
    t.drainPending(); // duplicate fired once
    t.record("srv_x", { q: "a" }, "DIFFERENT"); // result changed — clears the gate
    t.record("srv_x", { q: "a" }, "DIFFERENT"); // identical again → fires afresh
    const drained = t.drainPending();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.door.code).toBe("envelope/duplicate-call");
  });
});
