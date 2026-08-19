// structure-contract.test.ts — the CONTRACT for the type-derived list-structure gate (PRECISE variant).
//
// The gate is the win-lever for the candidates' residual gap to python: it fixes ARRAY UNDER-listing
// (the night's 38% sink — a model emitting `(f "a" "b")` for an array slot) and the LITERAL kind of
// SCALAR over-listing (`(g [1 2])` for a scalar slot). PRECISE means we gate only the UNAMBIGUOUS
// literal openers by the slot's TS type, and leave `(` (a call) and bare symbols (references / a chained
// call's output) untouched — so computed and chained args stay legal. "Matters for chained calls later."
//
// These tests are pure over (state, candidateStr). The lens→state plumbing (`slotIsArray`) and the
// perf-correct wiring into the mask/session path are separate, later increments; this file pins the LOGIC.
//
// ATTRIBUTION REFACTOR (rule-id enrichment): `violatesValueStructure` now returns its DECISIVE `RuleId`
// (`R-ARRAY-REJECTS-SCALAR` / `R-SCALAR-REJECTS-LIST` / `R-STRINGSLOT-REJECTS-NONSTRING` / …) on a violation
// and `null` on none, instead of a bare boolean (see rules.ts / mask-compiler attribution). The LOGIC pinned
// here is UNCHANGED — the same candidates are masked at the same slots — so the contract is re-expressed as
// "a violation yields a non-null RuleId; no violation yields null" (truthiness ≡ the old boolean).
import { describe, expect, it } from "vitest";

import { violatesValueStructure } from "../../src/mask-compiler.js";
import type { OracleState } from "../../src/oracle-types.js";

/** A value-slot-START state (token boundary, application argument) with a given array-ness. */
const slot = (slotIsArray: boolean | null | undefined): OracleState => ({
  midToken: false,
  position: "argument",
  formKind: "application",
  closeable: false,
  overClosed: false,
  validSymbols: () => null,
  slotIsArray,
});

describe("structure-contract — ARRAY slot forces a list (fixes under-listing)", () => {
  const arr = slot(true);
  // candidate opener → does the ARRAY-slot structure gate veto it? Scalar literals are wrong-shape
  // (vetoed); list materializers (`(`/`[`/`'`) and bare symbols (references / chained output) survive.
  it.each([
    { candidate: '"engine_size"', violates: true, why: 'a string literal `"x"` (the #126 / Wi-Fi shape)' },
    { candidate: "5", violates: true, why: "a number literal `5`" },
    { candidate: "#t", violates: true, why: "a #-literal `#t`" },
    { candidate: "(", violates: false, why: "`(list …)` via the `(` call opener (lens narrows the callee)" },
    { candidate: "[", violates: false, why: "the `[` vector materializer" },
    { candidate: "'", violates: false, why: "the `'(…)` quote-list materializer" },
    { candidate: "items", violates: false, why: "a bare symbol (a reference / chained call output)" },
  ])("$why → violates=$violates", ({ candidate, violates }) => {
    // A violation now yields a non-null RuleId; no violation yields null (truthiness ≡ the old boolean).
    expect(violatesValueStructure(arr, candidate) !== null).toBe(violates);
  });
});

describe("structure-contract — SCALAR slot forbids a list literal (the literal over-listing)", () => {
  const sca = slot(false);
  // candidate opener → does the SCALAR-slot structure gate veto it? List-literal openers (`[`/`'`) are
  // wrong-shape (vetoed); scalar literals, a `(` call (chained result), and bare symbols survive.
  it.each([
    { candidate: "[", violates: true, why: "a `[` vector literal" },
    { candidate: "'", violates: true, why: "a `'(…)` quote-list literal" },
    { candidate: '"km/h"', violates: false, why: 'a scalar literal `"km/h"` (the #101 shape, done right)' },
    { candidate: "546382", violates: false, why: "a number literal" },
    { candidate: "(", violates: false, why: "`(` — a CALL whose result is the scalar (chained: `(find-event …)`)" },
    { candidate: "result", violates: false, why: "a bare symbol (a scalar reference / chained output)" },
  ])("$why → violates=$violates", ({ candidate, violates }) => {
    expect(violatesValueStructure(sca, candidate) !== null).toBe(violates);
  });
});

describe("structure-contract — superset-safe self-disabling", () => {
  // No violation ⇒ the gate returns null (the post-attribution "doesn't fire" signal).
  it("unknown slotIsArray (undefined) ⇒ NEVER gates — grammar mode is byte-identical", () => {
    expect(violatesValueStructure(slot(undefined), "[")).toBeNull();
    expect(violatesValueStructure(slot(undefined), '"x"')).toBeNull();
  });
  it("null slotIsArray ⇒ NEVER gates (lens error / Σ-only fallback)", () => {
    expect(violatesValueStructure(slot(null), "[")).toBeNull();
    expect(violatesValueStructure(slot(null), '"x"')).toBeNull();
  });
  it("only at a value-slot-START — mid-atom never gates", () => {
    expect(violatesValueStructure({ ...slot(true), midToken: true }, '"x"')).toBeNull();
  });
  it("only at an ARGUMENT position — the operator slot never gates", () => {
    expect(violatesValueStructure({ ...slot(true), position: "operator" }, '"x"')).toBeNull();
  });
  it("only inside an APPLICATION — a lambda-list / quote form never gates", () => {
    expect(violatesValueStructure({ ...slot(true), formKind: "lambda-list" }, '"x"')).toBeNull();
  });
});
