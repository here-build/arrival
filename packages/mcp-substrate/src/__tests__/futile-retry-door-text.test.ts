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

  // A NEGATIVE-ONLY TEST IS A WEAK TEST — flagged by an adversarial review (2026-07-14).
  //
  // This test used to assert ONLY what the door must NOT say (three `not.toContain`). An EMPTY door
  // would have satisfied every one of them. The file as a whole is still a gate — its siblings below
  // assert positively on `fact` and `reason`, so a door that said nothing would fail those — but
  // THIS test, the one guarding the exact wording change that was asked for, could not tell a
  // correctly-reworded door from a deleted one.
  //
  // Absence of a lie is not the presence of the truth. So it now asserts BOTH: the removed
  // over-claims stay removed, AND the conditional framing that replaced them is actually there.
  it("says the RIGHT thing (conditional, fact-first) and not the wrong thing (diagnosis, outcome-prescription)", () => {
    const rendered = `${door.fact} ${door.reason} ${door.script}`.toLowerCase();

    // WHAT IT MUST NOT SAY — the two over-claims that were removed.
    // "the tool looks degraded" ASSERTED a diagnosis the medium cannot make: a tool returning the
    // same result may be perfectly healthy and simply have nothing to give.
    expect(rendered).not.toContain("the tool looks degraded");
    expect(rendered).not.toContain("the tool is degraded");
    // "give your best final answer" was OUTCOME FINE-TUNING — steering the model to stop working and
    // guess, which is not teaching, it is nudging toward a plausible-sounding surrender.
    expect(rendered).not.toContain("give your best final answer");

    // WHAT IT MUST SAY — the replacement, positively pinned. Deleting the door's text entirely (or
    // reverting to a bare refusal) now FAILS here rather than passing on an absence.
    expect(rendered).toContain("if"); // conditional, never a diagnosis stated as fact
    expect(rendered).toContain("degraded"); // the possibility is still named — it is a real one
    // ...and so is the OTHER possibility, which is the whole point of the rewording: an empty result
    // is very often the true answer, and the medium must not tell the model otherwise.
    expect(rendered).toMatch(/real|working/);
    // It must still hand back a usable next move rather than a verdict.
    expect(rendered).toMatch(/change the argument|different route|arguments/);
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
