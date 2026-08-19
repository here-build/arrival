// kwargs-profile.test.ts — the OPT-IN kwargs tool-call profile in the mask-compiler.
//
// A {@link ToolCallProfile} tightens the constrained-decode gate so a tool call takes the shape
//   (fn  pos1 … pos_requiredCount   [:optkey value]…)
// — required args POSITIONAL (forced present), optional args as `:keyword value` (keywords from the
// profile's set, omittable). Two enforcements, both at a TOP-LEVEL argument slot:
//   (a) once `requiredCount` positionals are placed, a further BARE value is masked → only `:` or `)`.
//   (b) after a `:`, the keyword is narrowed to `optionalKeywords`.
//
// CRUCIALLY: with NO profile the gate is BYTE-UNCHANGED (the positional `grammar` path). This file pins
// both the profile-on shape AND the profile-off identity, model-free, like tool-call-grammar.test.ts.

// Resolved to arrival-scheme SOURCE via vitest alias (see vitest.config.ts) — the REAL oracle.
import { makeOracle, oracleEnvFromBindings } from "@inhuman.tools/arrival/oracle";
import { describe, it, expect } from "vitest";

import { classifyCandidate, type ToolCallProfile } from "../../src/mask-compiler.js";

/** Identity stand-in for a callable binding value (a function value ⇒ callable in arrival's env). */
const callable = (x: unknown): unknown => x;

// A grant env mirroring a BFCL "simple" function: ONE operator `find` bound + the `list`/`array` argument
// callables the adapter always binds. Σ admits `find` at the operator slot and `list`/`array` as argument
// callables; bare numbers/strings are structurally admitted as argument VALUES. This is the SAME env shape
// the real `grammar`/`grammar-kwargs` modes build (bfclToGrantEnv), so the gate sees the same Σ a run does
// — built here directly to keep arrival-sampler's tests free of an intent-eval import.
function grantEnvFind(): ReturnType<typeof makeOracle> {
  const env = oracleEnvFromBindings({ find: callable, list: callable, array: callable });
  return makeOracle(env);
}

const PROFILE: ToolCallProfile = { requiredCount: 3, optionalKeywords: ["dietary_requirements", "max_price"] };
// A 2-required profile for the BEFORE-budget force tests (the `:`/`)`-while-under-budget masking).
const PROFILE2: ToolCallProfile = { requiredCount: 2, optionalKeywords: ["unit", "max_price"] };

describe("kwargs profile — (a) positional budget then :/) only", () => {
  const scanner = grantEnvFind();

  // After the 3 required positionals are placed, a 4th BARE value must be masked (structural tightening).
  it("masks a 4th bare value past requiredCount (number)", () => {
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" 5 `, "7", PROFILE)).toBe("structural");
  });
  it("masks a 4th bare value past requiredCount (string open) — even mid-string where Σ can't see it", () => {
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" 5 `, '"x', PROFILE)).toBe("structural");
  });

  // `:` (open a kwarg) and `)` (done) remain legal at that slot.
  it("admits `:` to open a keyword after the required positionals", () => {
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" 5 `, ":dietary_requirements", PROFILE)).toBe("feasible");
  });
  it("admits `)` to close after the required positionals", () => {
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" 5`, ")", PROFILE)).not.toBe("structural");
  });

  // WITHIN the required positionals, bare values are still legal (the budget is not yet spent).
  it("admits the 1st/2nd/3rd positional values", () => {
    expect(classifyCandidate(scanner, "(find ", '"NYC"', PROFILE)).toBe("feasible");
    expect(classifyCandidate(scanner, `(find "NYC" `, '"Thai"', PROFILE)).toBe("feasible");
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" `, "5", PROFILE)).toBe("feasible");
  });

  // Extending the 3rd positional's OWN atom (5 → 50) is NOT a 4th positional — must stay feasible.
  it("admits extending the 3rd positional's own atom (5 → 50)", () => {
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" 5`, "0", PROFILE)).toBe("feasible");
  });

  // A WITHIN-budget positional being typed mid-string (2nd positional, mid-string) must NOT be masked —
  // the over-budget check is per-positional-index, not "any mid-string past some count".
  it("admits a within-budget positional mid-string (2nd of 3)", () => {
    expect(classifyCandidate(scanner, `(find "NYC" "Th`, "a", PROFILE)).toBe("feasible");
  });

  // The 4th positional masked WHETHER it opens as a bare atom, a number, or a `(` nested form.
  it("masks a 4th positional opening as a nested (list …) form", () => {
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" 5 `, "(list", PROFILE)).toBe("structural");
  });

  // A keyword's VALUE is a legal bare value even though positionals are exhausted.
  it("admits a keyword's value (a bare value after :keyword)", () => {
    // `(find "NYC" "Thai" 5 :max_price ` → the next bare value is max_price's value.
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" 5 :max_price `, "23", PROFILE)).toBe("feasible");
  });

  // A list-constructor argument as a keyword value is fine (the bound `(list …)` call opens a nested form).
  it("admits (list …) as a keyword value", () => {
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" 5 :dietary_requirements `, "(list", PROFILE)).toBe(
      "feasible",
    );
  });

  // After a complete kwarg pair, a further BARE positional value is masked (only :/) remain).
  it("masks a bare value after a complete kwarg pair", () => {
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" 5 :max_price 23 `, "9", PROFILE)).toBe("structural");
  });
});

describe("kwargs profile — BEFORE the budget, required args are FORCED (no `:`/`)` until requiredCount)", () => {
  const scanner = grantEnvFind();

  // requiredCount=2: with only 1 positional placed, opening a kwarg `:` is masked — the model must NOT
  // drop a required arg and jump to kwargs (the `(calculate_triangle_area 10 :unit …)` failure).
  it("masks `:` opening a kwarg with only 1 of 2 required positionals", () => {
    expect(classifyCandidate(scanner, `(find 10 `, ":unit", PROFILE2)).toBe("structural");
  });
  // … and CLOSING the call early (`)`) with only 1 of 2 required is masked — required args forced present.
  it("masks `)` closing the call with only 1 of 2 required positionals", () => {
    expect(classifyCandidate(scanner, `(find 10 `, ")", PROFILE2)).toBe("structural");
    expect(classifyCandidate(scanner, `(find 10`, ")", PROFILE2)).toBe("structural"); // glued, no space
  });
  // A bare positional value IS the only legal continuation under budget (descend, not jump).
  it("admits the 2nd required positional (a bare value) under budget", () => {
    expect(classifyCandidate(scanner, `(find 10 `, "20", PROFILE2)).toBe("feasible");
  });
  // A required arg opening as a nested `(list …)` counts as ONE positional under budget — legal.
  it("admits a required positional opening as a nested (list …) under budget", () => {
    expect(classifyCandidate(scanner, `(find 10 `, "(list", PROFILE2)).toBe("feasible");
  });
  // A within-budget required positional typed MID-STRING is legal (the value just hasn't closed yet).
  it("admits the 2nd required positional mid-string under budget", () => {
    expect(classifyCandidate(scanner, `(find 10 "Th`, "a", PROFILE2)).toBe("feasible");
  });

  // AT the budget (2 positionals placed) `:` and `)` become legal; a 3rd bare positional is over budget.
  it("admits `:`/`)` and masks a 3rd bare positional once 2 of 2 required are placed", () => {
    expect(classifyCandidate(scanner, `(find 10 20 `, ":unit", PROFILE2)).toBe("feasible");
    expect(classifyCandidate(scanner, `(find 10 20`, ")", PROFILE2)).not.toBe("structural");
    expect(classifyCandidate(scanner, `(find 10 20 `, "30", PROFILE2)).toBe("structural"); // 3rd positional over budget
  });

  // The same FORCE applies at requiredCount=3 (the find profile): `:`/`)` masked with only 2 of 3 placed.
  it("masks `:`/`)` with only 2 of 3 required (requiredCount=3)", () => {
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" `, ":dietary_requirements", PROFILE)).toBe("structural");
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" `, ")", PROFILE)).toBe("structural");
    expect(classifyCandidate(scanner, `(find "NYC" "Thai"`, ")", PROFILE)).toBe("structural"); // glued
  });

  // A nested-form `)` (closing a `(list …)` required arg, NOT the call) does NOT trip the premature-close
  // mask: depth returns to the call's argument level (1), not 0 — the call is still open, count unchanged.
  it("does NOT mask a nested-form `)` (closing a required (list …), not the call) under budget", () => {
    // `(find (list "a"` is 1 of 2 required (the list is positional #1, still open). Closing the list `)`
    // brings depth to 1 (still inside the call), so the premature-close gate must NOT fire.
    expect(classifyCandidate(scanner, `(find (list "a"`, ")", PROFILE2)).not.toBe("structural");
  });
});

describe("kwargs profile — (b) keyword narrowed to optionalKeywords", () => {
  const scanner = grantEnvFind();

  it("admits a prefix of a valid optional keyword", () => {
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" 5 `, ":diet", PROFILE)).toBe("feasible");
  });
  it("admits a full valid optional keyword", () => {
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" 5 `, ":max_price", PROFILE)).toBe("feasible");
  });
  it("masks a keyword that is not in the optional set", () => {
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" 5 `, ":bogus", PROFILE)).toBe("structural");
  });
  it("masks a keyword whose fragment cannot prefix any optional keyword", () => {
    // ":z…" prefixes neither dietary_requirements nor max_price.
    expect(classifyCandidate(scanner, `(find "NYC" "Thai" 5 `, ":z", PROFILE)).toBe("structural");
  });
});

describe("kwargs profile — OFF is byte-identical to the positional grammar gate", () => {
  const scanner = grantEnvFind();

  // The SAME prefixes the profile would tighten, WITHOUT a profile: the gate must behave exactly as the
  // Σ-only `grammar` path. A bare value past 3 positionals is admitted (Σ admits a number as an arg value);
  // a `:keyword` of any name is admitted (Σ's blanket `:`-keyword member-read exemption). No tightening.
  const cases: [string, string][] = [
    [`(find "NYC" "Thai" 5 `, "7"], // a 4th positional — fine without a profile.
    [`(find "NYC" "Thai" 5 `, ":bogus"], // any keyword — fine without a profile.
    [`(find "NYC" "Thai" 5 :max_price 23 `, "9"], // a bare value after a pair — fine without a profile.
    [`(find "NYC" "Thai" `, "5"], // a within-budget positional — feasible either way.
    [`(find 10 `, ":unit"], // BEFORE-budget `:` — the profile masks it; no profile must NOT (byte-identical).
    [`(find 10`, ")"], // BEFORE-budget early close — the profile masks it; no profile must NOT.
  ];
  // An explicitly-absent profile (typed, not the literal) — proves the 4th-arg default path is unchanged.
  const noProfile: ToolCallProfile | undefined = undefined;
  it.each(cases)("classify(%j+%j) is identical with/without an absent profile", (prefix, cand) => {
    const withAbsent = classifyCandidate(scanner, prefix, cand, noProfile);
    const without = classifyCandidate(scanner, prefix, cand);
    expect(withAbsent).toBe(without);
    // And specifically: the 4th positional / bogus keyword that the profile masks is ADMITTED here
    // (feasible) — proving the profile-off path is the untightened `grammar` gate.
    if (cand === "7" || cand === ":bogus" || cand === "9") expect(without).toBe("feasible");
  });
});

// ── DETERMINISM: the gate is a PURE function of (prefix, candidate, profile) ───────────────────────────
//
// THE A2 FINDING (2026-06-21): a validator flagged greedy decode "non-reproducible" because the
// `grammar-kwargs` arm differed across two runs. Root cause was NOT decoder nondeterminism — the two runs
// straddled the gate-FORCE fix (commit 6ea96bd554; the pre-fix gate left `:`/`)` legal before the required
// positionals). The `grammar` path (untouched by that commit) was bit-identical across the same two runs.
// This block PINS the load-bearing invariant that makes greedy reproducible for FIXED code: the kwargs gate
// re-scans `next = prefix + candidate` from scratch every call and carries NO state, so identical inputs
// give an identical verdict — across repeated calls AND across a freshly-built scanner. A future change that
// smuggles per-call/per-decode state into the gate (the thing that WOULD make greedy genuinely flaky) breaks
// this test loudly.
describe("kwargs profile — PURE: identical (prefix, candidate, profile) ⇒ identical verdict (greedy determinism guard)", () => {
  // A representative cross-section of gate decisions: under-budget force, the keyword/close masks, the
  // over-budget bare-value mask, the keyword-narrowing accept/reject, and a within-budget admit.
  const probes: [string, string, ToolCallProfile][] = [
    [`(find 10 `, ":unit", PROFILE2], // under budget → keyword masked (the 6ea96bd fix).
    [`(find 10`, ")", PROFILE2], // under budget → early close masked.
    [`(find "NYC" "Thai" 5 `, "7", PROFILE], // over budget → 4th bare value masked.
    [`(find "NYC" "Thai" 5 `, ":dietary_requirements", PROFILE], // over budget → valid keyword admitted.
    [`(find "NYC" "Thai" 5 `, ":bogus", PROFILE], // over budget → unknown keyword masked.
    [`(find "NYC" "Thai" `, "5", PROFILE], // within budget → bare positional admitted.
  ];

  it("repeated calls on ONE scanner return the byte-identical CandidateClass (no per-call drift)", () => {
    const scanner = grantEnvFind();
    for (const [prefix, cand, profile] of probes) {
      const first = classifyCandidate(scanner, prefix, cand, profile);
      // Re-run many times AND interleave an UNRELATED classify (different prefix) between calls — if the gate
      // held state keyed off the last call, the interleave would perturb the verdict. It must not.
      for (let i = 0; i < 8; i++) {
        classifyCandidate(scanner, `(find "X" "Y" 1 `, ":max_price", profile); // unrelated, drains any state.
        expect(classifyCandidate(scanner, prefix, cand, profile)).toBe(first);
      }
    }
  });

  it("a FRESH scanner gives the same verdict (the gate doesn't depend on scanner identity/history)", () => {
    for (const [prefix, cand, profile] of probes) {
      const a = classifyCandidate(grantEnvFind(), prefix, cand, profile);
      const b = classifyCandidate(grantEnvFind(), prefix, cand, profile);
      expect(a).toBe(b);
    }
  });
});
