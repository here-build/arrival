// F6 — Unbound-variable TYPO SUGGESTIONS (P5 errors-as-doors; the typo half of the
// dissolved `polyglot-rich-errors` sub-capability). ONE law: suggestions derive from
// the resolution chain's ACTUAL VOCABULARY — every name the missed lookup could have
// found (real bindings, prelude defines, the declared `symbol.notImplemented` doors,
// lexical program names) — never from a curated side table.
//
// A mistyped name is the one class that CANNOT be a declared capability (it has no
// declaration site), so it survives inside `unboundVariableError` (src/unbound-
// variable.ts, consumed by Environment.get / Resolver.resolveSynth). The EXACT-name
// half of the old registry became declarations: doors resolve through the ordinary
// chain and are thereby typo-suggestible FOR FREE through this same mechanism —
// suggest the door, and calling the door teaches the reason.
//
// GATE UNDER TEST (load-bearing): a hint fires ONLY for a close miss of a name that
// exists in the vocabulary — an arbitrary unbound identifier still gets the PLAIN,
// unenriched "Unbound variable", byte-identical to the pre-enrichment wording (the
// manifold's H-4 one-line-wall contract pins the plain form downstream).

import { describe, expect, it } from "vitest";
import { exec } from "../../index.js";
import { suggestFromVocabulary, unboundVariableError } from "../../unbound-variable.js";

// DEAD (test-invariant-atlas, no longer testable — the OLD richErrorFor/well-known-symbols
// table mechanism these described was itself dissolved by the vocabulary-sourced redesign
// above; there is no curated table left to pin, and the new design deliberately narrows
// hints to real vocabulary members only):
//   - a one-character typo of a FAMOUS-BUT-ABSENT well-known symbol (known to another
//     Lisp dialect, but neither bound nor a declared door here) yields a hint naming the
//     suggestion plus "not implemented in this runtime" — the new vocabulary is sourced
//     from the live resolution chain, so a truly absent name is no longer in-vocabulary
//     and falls into the plain "arbitrary unbound identifier" bucket instead
//   - an exact well-known name gets no hint — moot under the new design: suggestFromVocabulary
//     is only ever reached from an already-unbound lookup, so "exact match" can't occur on this path
//   - the well-known-symbols table has no duplicate canonical names — the table itself is
//     gone; the nearest surviving relative is declared-doors.law.test.ts's "no duplicate door
//     declarations across packs" (a different subject: declared doors, not a curated table)
describe("suggestFromVocabulary — the vocabulary-sourced typo gate (unit, no eval)", () => {
  const VOCAB = ["reduce", "println", "string-split", "list", "dict", "dict?", "@", "@?", "->", "%purity-door"];

  // INVARIANT (carried from the dissolved polyglot-rich-errors/registry's richErrorFor: a
  // typo of a bound name yields a "did you mean" hint — same law, now vocabulary-sourced
  // instead of table-sourced): a one-character typo of a bound well-known symbol yields a
  // "did you mean" hint
  it("fires on a one-character typo of a vocabulary name", () => {
    expect(suggestFromVocabulary("reduse", VOCAB)).toEqual(["reduce"]);
    expect(suggestFromVocabulary("printlm", VOCAB)).toEqual(["println"]);
  });

  // INVARIANT: a canonical-form match (dash/underscore/case variance) yields a "did you mean" hint
  it("fires on a CANONICAL-FORM match (dash/underscore/case variance)", () => {
    expect(suggestFromVocabulary("string_split", VOCAB)).toEqual(["string-split"]);
    expect(suggestFromVocabulary("StringSplit", VOCAB)).toEqual(["string-split"]);
  });

  // INVARIANT: an arbitrary non-well-known identifier gets no hint
  it("does NOT fire for an arbitrary identifier near nothing", () => {
    expect(suggestFromVocabulary("csv-content", VOCAB)).toEqual([]);
    expect(suggestFromVocabulary("my-custom-helper-fn", VOCAB)).toEqual([]);
  });

  // INVARIANT: single-character and two-character unbound names never get edit-distance
  // suggestions (the length floor)
  it("LENGTH FLOOR: short names never get edit-distance suggestions (a 1-char name is one substitution from everything)", () => {
    for (const name of ["a", "b", "z", "ab"]) {
      expect(suggestFromVocabulary(name, VOCAB)).toEqual([]);
    }
  });

  it("`%`-prefixed internals and symbol-typed keys are never suggestion candidates", () => {
    expect(suggestFromVocabulary("purity-door", VOCAB)).toEqual([]);
    expect(suggestFromVocabulary("reduse", [Symbol("reduce"), "reduce"])).toEqual(["reduce"]);
  });

  it("resolver-STRUCTURAL names (c[ad]+r synthesis) are seeded candidates despite being absent from every enumerable vocabulary", () => {
    expect(suggestFromVocabulary("cair", [])).toEqual(["car"]);
    expect(suggestFromVocabulary("cdrr", [])).toContain("cdr");
  });

  it("caps at 3 deterministic (code-unit-sorted) suggestions on a tie", () => {
    const near = suggestFromVocabulary("dact", ["dbct", "dcct", "dect", "dfct", "daat"]);
    expect(near).toHaveLength(3);
    expect(near).toEqual([...near].sort());
  });
});

describe("unboundVariableError — message shapes + the `enriched` structured marker (unit, no eval)", () => {
  // `enriched` is a THIRD signal alongside `.message`/`.publicMessage` — unambiguously
  // true iff a did-you-mean suffix was appended, independent of either string's wording
  // (replaces a manifold-side string-shape sniff on `.message`; see unbound-variable.ts).
  // INVARIANT: .enriched is true for a typo of a vocabulary name (subsumes the atlas's
  // separate "bound"/"stubbed"/"canonical-form" cases — one mechanism, one flag);
  // .enriched is false for an arbitrary non-well-known identifier and with no vocabulary at all
  it("true for a typo of a vocabulary name, false for a bare miss, false with no vocabulary at all", () => {
    expect(unboundVariableError("reduse", ["reduce"]).enriched).toBe(true);
    expect(unboundVariableError("csv-content", ["reduce"]).enriched).toBe(false);
    expect(unboundVariableError("reduse").enriched).toBe(false);
  });

  // INVARIANT: `.enriched` is a pure addition — `.message`/`.publicMessage` exact wording is
  // unchanged (pins implementation, not behavior)
  it("the enriched wording carries the suggestion; the plain wording is byte-identical to the pre-enrichment form", () => {
    const enriched = unboundVariableError("reduse", ["reduce"]);
    expect(enriched.message).toBe("Unbound variable `reduse' — did you mean `reduce`?");
    expect(enriched.publicMessage).toBe(
      "symbol reduse does not exist - look at list of available functions at tool description (did you mean `reduce`?)",
    );
    const bare = unboundVariableError("csv-content", ["reduce"]);
    expect(bare.message).toBe("Unbound variable `csv-content'");
    expect(bare.publicMessage).toBe(
      "symbol csv-content does not exist - look at list of available functions at tool description",
    );
    expect(bare.enriched).toBe(false);
  });
});

describe("LIVE enrichment at the arrival throw site (default assembled env)", () => {
  // INVARIANT: a typo of a bound symbol throws with the rich "did you mean" hint, live from exec
  it("a typo of a REAL bound symbol suggests it", async () => {
    await expect(exec("reduse")).rejects.toThrow(/Unbound variable `reduse' — did you mean .*`reduce`/);
  });

  // INVARIANT: a typo of a stubbed (declared-door) symbol throws with the rich hint, live from exec
  it("a typo of a DECLARED DOOR suggests it (declaring a stub makes it typo-suggestible for free)", async () => {
    await expect(exec("printlm")).rejects.toThrow(/Unbound variable `printlm' — did you mean .*`println`/);
  });

  it("a typo of a PRELUDE-DEFINED name suggests it (the static table never knew preludes)", async () => {
    // fold-right is a scheme prelude define in srfi-1.ts — in the chain's vocabulary
    // because the vocabulary IS the baked env, not a curated list.
    await expect(exec("fold-rigt")).rejects.toThrow(/did you mean .*`fold-right`/);
  });

  // INVARIANT: a canonical-form miss throws with the rich hint, live from exec
  it("a canonical-form miss (underscore/case spelling of a bound name) suggests it", async () => {
    await expect(exec("string_split")).rejects.toThrow(/did you mean `string-split`\?/);
  });

  it("a typo of a LEXICALLY bound program name suggests it (the Resolver passes its composed scope+capabilities vocabulary)", async () => {
    await expect(exec("(define my-accumulator 41)\nmy-acumulator")).rejects.toThrow(
      /Unbound variable `my-acumulator' — did you mean `my-accumulator`\?/,
    );
  });

  // INVARIANT: an arbitrary unbound identifier throws the plain, unenriched message with no
  // fabricated hint (pins implementation, not behavior)
  it("an arbitrary unbound identifier throws the PLAIN message — no hint fabricated", async () => {
    await expect(exec("csv-content")).rejects.toThrow(/^Unbound variable `csv-content'$/);
  });

  // `exec` wraps the original throw into an ArrivalError(message, frames, cause) — the
  // original unboundVariableError-produced Error (carrying `.enriched`) survives as `.cause`.
  const causeEnriched = async (src: string): Promise<boolean | undefined> => {
    try {
      await exec(src);
    } catch (e) {
      return (e as Error & { cause?: { enriched?: boolean } }).cause?.enriched;
    }
    throw new Error(`expected exec to reject for: ${src}`);
  };

  // INVARIANT: the original enriched Error survives as `.cause` on the wrapped ArrivalError;
  // `.cause.enriched` is true when a hint fired, false for a bare, unenriched unbound-variable throw
  it("LIVE: `.cause.enriched` is true when the throw carries a hint, false for the bare wall", async () => {
    expect(await causeEnriched("reduse")).toBe(true);
    expect(await causeEnriched("csv-content")).toBe(false);
  });

  // INVARIANT: real typos of length-≥3 structured names still fire, including resolver-structural
  // c[ad]+r near-misses with no table backing them
  it("LIVE: a structural c[ad]+r near-miss still routes to `car` without any table", async () => {
    await expect(exec("cair")).rejects.toThrow(/did you mean .*`car`/);
  });
});
