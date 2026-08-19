// element-enum-symbol-mismatch.test.ts — RED REPRODUCTION of the remaining BUG-2 sub-case: a multi-token
// enum member whose RAW value contains a non-identifier char (a SPACE) is SPLIT at an ARRAY-ELEMENT enum
// slot. `Scenic_View` (the sanitised scheme symbol the model emits + the grant env binds) is masked because
// the element-enum domain the lens stamps holds the RAW string literal `"Scenic View"` (a SPACE), not the
// symbol — so the Σ∩T element narrowing's symbol-prefix check (`isLiveSymbolPrefix(frag, elementEnum)`) never
// matches, and the member corrupts to `Scenic` (a live prefix of `"Scenic View"`) then drops `_View`.
//
// THE DISCRIMINATOR (why this is NOT the already-fixed mid-atom re-keying — mid-atom-continuation.test.ts):
//   • the SCALAR enum slot is CORRECT for the same space-bearing literal — `getTypeValidCandidates` narrows
//     the SYMBOL set (assignability of `typeof Scenic_View = "Scenic View"` to the union), so the symbol
//     `Scenic_View` is kept WHOLE. (Pinned green below — the scalar path is sound.)
//   • the ARRAY-ELEMENT enum slot (CUT A) is WRONG, and it fails at a CLEAN BOUNDARY too (not just mid-atom),
//     so the `continuesAtom` re-keying discriminator is NOT the cause — the element-enum domain is in the
//     WRONG SPACE (raw strings, not symbols). (The RED rows below.)
//
// Mirrors scalar-enum-integration.test.ts (same mock+real lens + REAL arrival oracle + REAL classifyCandidate).
// Model-free. DEFAULT suite (a verdict). A green run here is the fix's acceptance gate; do NOT relax the asserts.

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import { assembleHostPrelude, createSchemeLanguageService } from "@inhuman.tools/arrival-lsp";
import { describe, expect, it } from "vitest";

import { classifyCandidate } from "../../src/mask-compiler.js";
import { narrowByTypeAsync, type AsyncTypeLens } from "../../src/typed-scanner-async.js";

const callable = (x: unknown): unknown => x;

// `set_prefs(prefs: T[])` — an ARRAY of an enum whose member's RAW value has a SPACE: "Scenic View" | "Fastest".
// The grant env binds the SANITISED symbols (`Scenic_View`, `Fastest`) — exactly what the bfcl adapter does
// (sanitiseSymbol: space → `_`); the model emits these symbols.
function arrayGrantEnv(): OracleEnvΣ {
  return oracleEnvFromBindings({ set_prefs: callable, Scenic_View: callable, Fastest: callable, list: callable });
}

/** The host prelude byte-shaped like the bfcl adapter's output for an ARRAY-of-enum param: the union is over
 *  the RAW value literals (`"Scenic View"`), the param typed `T[]`, each sanitised symbol declared `: T`. */
function arrayHost(): ReturnType<typeof assembleHostPrelude> {
  return assembleHostPrelude(
    [
      ["set_prefs", "(prefs: T[]): string"],
      ["Scenic_View", ": T"],
      ["Fastest", ": T"],
    ],
    { preamble: `type T = "Scenic View" | "Fastest";` },
  );
}

/** The scalar twin: `get_route(route_type: T)` — same space-bearing union, but a SCALAR slot (no `[]`). Used
 *  to PIN that the scalar path is sound for the same literal (the discriminator). */
function scalarHost(): ReturnType<typeof assembleHostPrelude> {
  return assembleHostPrelude(
    [
      ["get_route", "(route_type: T): string"],
      ["Scenic_View", ": T"],
      ["Fastest", ": T"],
    ],
    { preamble: `type T = "Scenic View" | "Fastest";` },
  );
}

function lensFor(host: ReturnType<typeof assembleHostPrelude>): AsyncTypeLens {
  const ls = createSchemeLanguageService({ host });
  return {
    getTypeValidCandidates: (s, o, c) => Promise.resolve(ls.getTypeValidCandidates(s, o, [...c])),
    getSlotIsArray: (s, o) => Promise.resolve(ls.getSlotIsArray(s, o)),
    getSlotAcceptsBareWord: (s, o) => Promise.resolve(ls.getSlotAcceptsBareWord(s, o)),
    getSlotElementType: (s, o) => Promise.resolve(ls.getSlotElementType(s, o)),
    getHeadReturnsArray: (s, h) => Promise.resolve(ls.getHeadReturnsArray(s, h)),
    getSlotIsStringTyped: (s, o) => Promise.resolve(ls.getSlotIsStringTyped(s, o)),
  };
}

/** The LIVE greedyDescend slot-state rebase: at a mid-atom argument/operator, re-analyze at the boundary
 *  (`prefix + " "`) so the type-derived gates describe the slot the next value opens in. */
function liveSlotState(scanner: ReturnType<typeof narrowByTypeAsync>, prefix: string) {
  const ps = scanner.analyze(prefix);
  return ps.midToken && (ps.position === "argument" || ps.position === "operator") ? scanner.analyze(`${prefix} `) : ps;
}

describe("element-enum symbol/raw-string mismatch — the LENS stamps raw literals, the model emits symbols", () => {
  it("the lens's element-enum domain holds the RAW literal (`Scenic View`), not the symbol (`Scenic_View`)", () => {
    // Pins the mechanism source: getSlotElementType returns the string-literal `.value` (a SPACE), so any
    // symbol-prefix check against it cannot match the sanitised symbol the model emits.
    const ls = createSchemeLanguageService({ host: arrayHost() });
    const slot = "(set_prefs (list ";
    const { enum: members } = ls.getSlotElementType(slot, slot.length);
    expect(members).toContain("Scenic View"); // the RAW literal with a SPACE
    expect(members).not.toContain("Scenic_View"); // NOT the sanitised symbol the grant env binds
  });

  it("CONTRAST (GREEN): the SCALAR slot keeps the whole symbol `Scenic_View` — the scalar path is sound", async () => {
    const scanner = narrowByTypeAsync(makeOracle(arrayGrantEnv()), lensFor(scalarHost()));
    // The scalar callee is get_route; bind it via a fresh env (Scenic_View/Fastest are shared bindings).
    const sc = narrowByTypeAsync(
      makeOracle(
        oracleEnvFromBindings({ get_route: callable, Scenic_View: callable, Fastest: callable, list: callable }),
      ),
      lensFor(scalarHost()),
    );
    void scanner;
    const slot = "(get_route ";
    await sc.prefill(slot);
    const state = sc.analyze(slot);
    expect(classifyCandidate(sc, slot, "Scenic_View", undefined, state), "whole symbol kept at scalar slot").toBe(
      "feasible",
    );
    // mid-atom continuation also survives at the scalar slot (the structure-gate fix + symbol-space narrowing).
    const ps = "(get_route Scenic";
    await sc.prefill(ps);
    expect(classifyCandidate(sc, ps, "_View", undefined, liveSlotState(sc, ps)), "scalar continuation kept").toBe(
      "feasible",
    );
  });

  it("RED (quote element, clean boundary): the whole symbol `Scenic_View` must be KEPT inside `'(`", async () => {
    const scanner = narrowByTypeAsync(makeOracle(arrayGrantEnv()), lensFor(arrayHost()));
    const slot = "(set_prefs '(";
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);
    // The model emits the sanitised symbol; it is the right answer (its denoted value IS an enum member).
    // CURRENT (red): masked ("sigma") because the element-enum domain holds `"Scenic View"`, not `Scenic_View`.
    expect(classifyCandidate(scanner, slot, "Scenic_View", undefined, state), "whole symbol at quote element").toBe(
      "feasible",
    );
    // The no-space member is unaffected (its symbol == its literal) — pins that the bug is the space mismatch.
    expect(classifyCandidate(scanner, slot, "Fastest", undefined, state), "the no-space member is fine").toBe(
      "feasible",
    );
  });

  it("RED (quote element, mid-atom continuation): `(set_prefs '(Scenic` ⊢ `_View` must be KEPT", async () => {
    const scanner = narrowByTypeAsync(makeOracle(arrayGrantEnv()), lensFor(arrayHost()));
    const prefix = "(set_prefs '(Scenic";
    await scanner.prefill("(set_prefs '(");
    await scanner.prefill(prefix);
    const ss = liveSlotState(scanner, prefix);
    // CURRENT (red): `_View` masked ⇒ the member corrupts to `Scenic` (a live prefix of `"Scenic View"`).
    expect(classifyCandidate(scanner, prefix, "_View", undefined, ss), "underscore continuation kept").toBe("feasible");
  });

  it("RED ((list …) element): the whole symbol `Scenic_View` must be KEPT inside `(list `", async () => {
    const scanner = narrowByTypeAsync(makeOracle(arrayGrantEnv()), lensFor(arrayHost()));
    const slot = "(set_prefs (list ";
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);
    expect(classifyCandidate(scanner, slot, "Scenic_View", undefined, state), "whole symbol at (list element").toBe(
      "feasible",
    );
  });

  it("REGRESSION (still mask a genuine non-member): `walking` is NOT an enum member ⇒ masked at the element", async () => {
    const scanner = narrowByTypeAsync(makeOracle(arrayGrantEnv()), lensFor(arrayHost()));
    const slot = "(set_prefs '(";
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);
    // `walking` is unbound AND not an enum member — it must STILL be masked (the fix only stops splitting a
    // REAL member; it must not loosen the closed domain). Σ masks an unbound symbol on the quote surface.
    expect(classifyCandidate(scanner, slot, "walking", undefined, state), "a non-member stays masked").not.toBe(
      "feasible",
    );
  });
});
