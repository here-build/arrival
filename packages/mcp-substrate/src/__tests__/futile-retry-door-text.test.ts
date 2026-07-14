// futileRetryDoor text — C2/B2 (benchmark-defect-register.md §C + ADDENDUM B2). ~60% of the
// door's real-world firings were WORKING tools truthfully returning empty (met-museum "No
// objects found", memory empty), yet the old text asserted "the tool looks degraded or
// rate-limited" as FACT and prescribed "give your best final answer" — pushing a model to
// abandon a recoverable search and confabulate. Observed harm: the model proposed the WINNING
// query and the door vetoed it (5 of 6 claims lost); the fabricated diagnosis leaked into
// user-facing final answers twice.
//
// V RULING: report the FACT, frame the interpretation CONDITIONALLY, prescribe NOTHING. No
// "give your best final answer" anywhere — that is outcome fine-tuning (load-bearing constraint
// #6 in the register), not teaching.

import { describe, expect, it } from "vitest";

import { futileRetryDoor } from "../doors.js";

describe("futileRetryDoor — fact-only, conditionally-framed, no outcome prescription (C2/B2)", () => {
  const door = futileRetryDoor("srv_search");

  it("never asserts degradation as FACT, and never tells the model to give its best final answer", () => {
    const rendered = `${door.fact} ${door.reason} ${door.script}`.toLowerCase();
    expect(rendered).not.toContain("give your best final answer");
    expect(rendered).not.toContain("the tool looks degraded");
    expect(rendered).not.toContain("the tool is degraded");
  });

  it("fact names only the observable: same result, different arguments — no diagnosis", () => {
    expect(door.fact).toContain("srv_search");
    expect(door.fact).toMatch(/same result/i);
    expect(door.fact).toMatch(/different argument/i);
  });

  it("reason frames BOTH possibilities conditionally — degraded-tool AND legitimate-empty-answer — prescribing neither", () => {
    expect(door.reason).toMatch(/if/i); // conditional framing, not an assertion
    const reason = door.reason.toLowerCase();
    expect(reason).toContain("degraded");
    expect(reason).toContain("real");
    expect(reason).toContain("working");
    expect(reason).toContain("what need to change");
  });

  it("script prescribes changing arguments or route — never abandoning the search", () => {
    expect(door.script.toLowerCase()).not.toContain("stop retrying");
    expect(door.script.toLowerCase()).not.toContain("best final answer");
    expect(door.script.toLowerCase()).toMatch(/change|different route/);
  });
});
