// element-gate-e2e.test.ts — the PROOF that the ARRAY-ELEMENT force-quote / enum-narrow gate (CUT A) fires
// end-to-end, across BOTH live array surfaces (`(list …)` app-argument and `'(…)` quote).
//
// Model-free: a MOCK async lens stamps the element verdict by detecting the enclosing array surface in the
// slot prefix (a free-form string element ⇒ {isStringy:true}, an enum element ⇒ {enum:[…]}), exactly as the
// real `getSlotElementType` does over the TS contextual type. narrowByTypeAsync stamps
// `elementIsStringy`/`elementEnum` onto the OracleState (firing inside a QUOTE form too, the `'(…)` surface);
// the real arrival oracle supplies the structural state; classifyCandidate applies the gate.
//
// Runs in the DEFAULT suite (a verdict, per .claude/rules/tests.md).

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import { describe, expect, it } from "vitest";

import { classifyCandidate } from "../../src/mask-compiler.js";
import { narrowByTypeAsync, type AsyncTypeLens } from "../../src/typed-scanner-async.js";

const callable = (x: unknown): unknown => x;

// `set-diet` (enum array of T_pref), `set-tags` (free-form string array), plus `list` (the materializer
// constructor) + a bare symbol — all bound so the oracle reports a real application / quote.
function grantEnv(): OracleEnvΣ {
  return oracleEnvFromBindings({
    "set-diet": callable,
    "set-tags": callable,
    list: callable,
    vegan: callable,
    vegetarian: callable,
    ref: callable,
  });
}

const DIET_MEMBERS = ["vegan", "vegetarian", "pescatarian"];

/** A MOCK async lens. `getSlotElementType` recognizes when the cursor is inside an array surface of a known
 *  callee and returns the element verdict (the real lens does this over the TS contextual type):
 *   - inside `set-diet`'s array (via `(list …)` OR `'(…)`)  ⇒ enum element  → {isStringy:false, enum:DIET}
 *   - inside `set-tags`'s array (via `(list …)` OR `'(…)`)  ⇒ string element → {isStringy:true,  enum:null}
 *   - anywhere else ⇒ inert {null,null}. The other axes are inert (this suite isolates the element gate). */
function mockLens(): AsyncTypeLens {
  const elementOwner = (prefix: string): "diet" | "tags" | null => {
    // Inside an array surface? The prefix's trailing open form must be a `(list` OR a `'(`.
    const inListCtor = /\(\s*list\b[^()]*$/.test(prefix);
    const inQuoteList = /'\([^()]*$/.test(prefix);
    if (!inListCtor && !inQuoteList) return null;
    // The enclosing tool call (the first head atom) decides the element domain.
    if (/\(\s*set-diet\b/.test(prefix)) return "diet";
    if (/\(\s*set-tags\b/.test(prefix)) return "tags";
    return null;
  };
  return {
    getTypeValidCandidates: (_s, _o, candidates) => Promise.resolve([...candidates]),
    getSlotIsArray: () => Promise.resolve(null),
    getSlotAcceptsBareWord: () => Promise.resolve(null),
    getSlotElementType: (scheme, off) => {
      const owner = elementOwner(scheme.slice(0, off));
      if (owner === "diet") return Promise.resolve({ isStringy: false, enum: [...DIET_MEMBERS] });
      if (owner === "tags") return Promise.resolve({ isStringy: true, enum: null });
      return Promise.resolve({ isStringy: null, enum: null });
    },
  };
}

describe("element-gate-e2e — force-quote at a FREE-FORM string element (both surfaces)", () => {
  it.each([
    ["(list …)", "(set-tags (list "],
    ["'(…)", "(set-tags '("],
  ] as const)(
    "%s: a bare-word / nested-list element is MASKED; the quoted string + a call pass",
    async (label, slot) => {
      const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
      await scanner.prefill(slot);
      const state = scanner.analyze(slot);
      expect(state.elementIsStringy, `${label}: the element stamp must reach the OracleState`).toBe(true);

      // The forced quoted-string form PASSES.
      expect(classifyCandidate(scanner, slot, '"open hole"', undefined, state)).toBe("feasible");
      // A BARE WORD is MASKED (forced to quote upfront — the multi-word whitespace-split fix).
      expect(classifyCandidate(scanner, slot, "open", undefined, state)).toBe("structural");
      // A NESTED list-opener is MASKED (the over-listing nested-wrap).
      expect(classifyCandidate(scanner, slot, "'", undefined, state)).toBe("structural");
      expect(classifyCandidate(scanner, slot, "[", undefined, state)).toBe("structural");
      // A CLOSER passes (the array may legally be empty / end here — never force a spurious element).
      expect(classifyCandidate(scanner, slot, ")", undefined, state)).toBe("feasible");
    },
  );

  it("'(…): a whitespace-LED bare word (` open`) is masked too (the glued-token case)", async () => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(set-tags '(";
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);
    // The opener char is the first NON-whitespace char of the candidate.
    expect(classifyCandidate(scanner, slot, " open", undefined, state)).toBe("structural");
    expect(classifyCandidate(scanner, slot, ' "open hole"', undefined, state)).toBe("feasible");
  });
});

describe("element-gate-e2e — enum-narrow at a CLOSED string-literal element (both surfaces)", () => {
  it.each([
    ["(list …)", "(set-diet (list "],
    ["'(…)", "(set-diet '("],
  ] as const)("%s: mid-element, only the enum members survive Σ; a non-member is masked", async (label, slot) => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    await scanner.prefill(slot);
    // The enum verdict reaches the state at the element boundary.
    const boundary = scanner.analyze(slot);
    expect(boundary.elementEnum, `${label}: the enum stamp must reach the OracleState`).toEqual(DIET_MEMBERS);
    // A member is admitted; a bound NON-member symbol (`ref`) is narrowed OUT (sigma).
    expect(classifyCandidate(scanner, slot, "vegan", undefined, boundary)).toBe("feasible");
    expect(classifyCandidate(scanner, slot, "ref", undefined, boundary)).toBe("sigma");
  });
});

describe("element-gate-e2e — INERT off the element surface (no over-fire)", () => {
  it("a non-array tool's argument is untouched (every opener passes)", async () => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(ref "; // not an array surface
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);
    expect(state.elementIsStringy ?? null).toBeNull();
    expect(classifyCandidate(scanner, slot, "open", undefined, state)).not.toBe("structural");
    expect(classifyCandidate(scanner, slot, '"open"', undefined, state)).toBe("feasible");
  });
});
