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
import { richErrorFor, unboundVariableError, WELL_KNOWN_SYMBOLS } from "../env/polyglot-rich-errors/registry.js";

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

describe("unboundVariableError — the `enriched` structured marker (unit, no eval)", () => {
  // `enriched` is a THIRD signal alongside `.message`/`.publicMessage` — unambiguously true iff
  // richErrorFor found a hint, independent of either string's wording. See registry.ts's
  // unboundVariableError doc comment for why this exists (replaces a manifold-side string-shape
  // sniff on `.message`).
  it("true for a one-character typo of a BOUND well-known symbol", () => {
    expect(unboundVariableError("reduse").enriched).toBe(true);
  });

  it("true for a one-character typo of a STUBBED well-known symbol", () => {
    expect(unboundVariableError("printlm").enriched).toBe(true);
  });

  it("true for a one-character typo of a FAMOUS-BUT-ABSENT well-known symbol", () => {
    expect(unboundVariableError("folf").enriched).toBe(true);
  });

  it("true for a CANONICAL-FORM match (dash/underscore/case variance)", () => {
    expect(unboundVariableError("string_split").enriched).toBe(true);
    expect(unboundVariableError("StringSplit").enriched).toBe(true);
  });

  it("false for an arbitrary, non-well-known identifier", () => {
    expect(unboundVariableError("csv-content").enriched).toBe(false);
    expect(unboundVariableError("my-custom-helper-fn").enriched).toBe(false);
  });

  it("false for an EXACT well-known name (richErrorFor has nothing to suggest)", () => {
    expect(unboundVariableError("reduce").enriched).toBe(false);
    expect(unboundVariableError("fold").enriched).toBe(false);
  });

  it("false for a short name below the edit-distance length floor", () => {
    expect(unboundVariableError("a").enriched).toBe(false);
  });

  it("is a pure addition: `.message`/`.publicMessage` are unchanged by the new field", () => {
    const enriched = unboundVariableError("reduse");
    expect(enriched.message).toBe(
      "Unbound variable `reduse' — did you mean `reduce` (SRFI-1)? it is bound here — left fold, fn(element, acc) convention",
    );
    expect(enriched.publicMessage).toBe(
      "symbol reduse does not exist - look at list of available functions at tool description " +
        "(did you mean `reduce` (SRFI-1)? it is bound here — left fold, fn(element, acc) convention)",
    );
    const bare = unboundVariableError("csv-content");
    expect(bare.message).toBe("Unbound variable `csv-content'");
    expect(bare.publicMessage).toBe("symbol csv-content does not exist - look at list of available functions at tool description");
    expect(bare.enriched).toBe(false);
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

  // `exec` wraps the original throw into an ArrivalError(message, frames, cause) — the
  // original unboundVariableError-produced Error (carrying `.enriched`) survives as `.cause`
  // (errors.ts's ArrivalError), the same access pattern arrival's own bracket-binding door
  // tests use for `.cause.code` (let-bracket-binding-door.test.ts's `doorCode`).
  const causeEnriched = async (src: string): Promise<boolean | undefined> => {
    try {
      await exec(src);
    } catch (e) {
      return (e as Error & { cause?: { enriched?: boolean } }).cause?.enriched;
    }
    throw new Error(`expected exec to reject for: ${src}`);
  };

  it("LIVE: `.cause.enriched` is true when the throw carries a rich hint", async () => {
    expect(await causeEnriched("reduse")).toBe(true);
  });

  it("LIVE: `.cause.enriched` is false for a bare, unenriched unbound-variable throw", async () => {
    expect(await causeEnriched("csv-content")).toBe(false);
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
