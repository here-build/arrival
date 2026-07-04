// The TYPO-ENRICHMENT half of the `polyglot-rich-errors` sub-capability
// (`env/polyglot-rich-errors/registry.ts`): when an unbound reference is a close
// typo of a WELL-KNOWN cross-dialect Lisp symbol, the "Unbound variable" error is
// enriched with a "did you mean …?" hint — live, at the arrival-side throw site
// (`Resolver.ts#resolveSynth`, `Environment.ts#get`), not merely as an exported
// registry a later consumer wires up. See `./polyglot-rich-errors-stubs.test.ts`
// for the sibling STUBS half.
//
// GATE UNDER TEST: the hint fires ONLY for names in the curated table (bound
// elsewhere, stubbed here, or famous-but-absent) — never for an arbitrary user
// identifier, which must still get the plain, unenriched "Unbound variable".

import { describe, expect, it } from "vitest";
import { exec } from "../index.js";
import { richErrorFor, WELL_KNOWN_SYMBOLS } from "../env/polyglot-rich-errors/registry.js";

describe("polyglot-rich-errors/registry — richErrorFor (unit, no eval)", () => {
  it("fires on a one-character typo of a BOUND well-known symbol", () => {
    expect(richErrorFor("reduse")).toMatch(/did you mean `reduce`/);
  });

  it("fires on a one-character typo of a STUBBED well-known symbol", () => {
    expect(richErrorFor("printlm")).toMatch(/did you mean `println`/);
  });

  it("fires on a one-character typo of a FAMOUS-BUT-ABSENT well-known symbol", () => {
    expect(richErrorFor("folf")).toMatch(/did you mean `fold`/);
    expect(richErrorFor("folf")).toMatch(/not implemented in this runtime/);
  });

  it("fires on a CANONICAL-FORM match (dash/underscore/case variance)", () => {
    expect(richErrorFor("string_split")).toMatch(/did you mean `string-split`/);
    expect(richErrorFor("StringSplit")).toMatch(/did you mean `string-split`/);
  });

  it("does NOT fire for an arbitrary, non-well-known identifier", () => {
    expect(richErrorFor("csv-content")).toBeUndefined();
    expect(richErrorFor("my-custom-helper-fn")).toBeUndefined();
  });

  it("does NOT fire for an EXACT well-known name (nothing to suggest — it either resolves or the stub itself doors it)", () => {
    expect(richErrorFor("reduce")).toBeUndefined();
    expect(richErrorFor("println")).toBeUndefined();
    expect(richErrorFor("fold")).toBeUndefined();
  });

  it("the table has no duplicate canonical names", () => {
    const seen = new Set<string>();
    for (const entry of WELL_KNOWN_SYMBOLS) {
      expect(seen.has(entry.name)).toBe(false);
      seen.add(entry.name);
    }
  });
});

describe("polyglot-rich-errors — LIVE enrichment at the arrival throw site (default env)", () => {
  it("a typo of a bound symbol throws with the rich hint", async () => {
    await expect(exec("reduse")).rejects.toThrow(/Unbound variable `reduse' — did you mean `reduce`/);
  });

  it("a typo of a stubbed symbol throws with the rich hint", async () => {
    await expect(exec("printlm")).rejects.toThrow(/Unbound variable `printlm' — did you mean `println`/);
  });

  it("a canonical-form miss (string-splt, one char short of string-split) throws with the rich hint", async () => {
    await expect(exec("string-splt")).rejects.toThrow(/did you mean `string-split`/);
  });

  it("an arbitrary unbound identifier throws the PLAIN message — no hint fabricated", async () => {
    await expect(exec("csv-content")).rejects.toThrow(/^Unbound variable `csv-content'$/);
  });
});

describe("length floor — short names never get edit-distance suggestions", () => {
  // Every 1-char name is one substitution from every 1-char entry (`a` → `@`), so an
  // unbound single-letter variable used to get a WRONG "did you mean `@`" that shadowed
  // the doors that own that case (scope-confusion). Distance-1 requires length ≥ 3.
  it("single-char unbound names get no suggestion", () => {
    for (const name of ["a", "b", "z", "w", "q"]) {
      expect(richErrorFor(name)).toBeUndefined();
    }
  });
  it("two-char unbound names get no edit-distance suggestion", () => {
    expect(richErrorFor("ab")).toBeUndefined();
  });
  it("real typos of structured names still fire", () => {
    expect(richErrorFor("reduse")).toContain("reduce");
  });
});
