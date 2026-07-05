import { describe, expect, it } from "vitest";

import { toSExprString } from "../serializer.js";

describe("streaming truncation (opt-in)", () => {
  it("no opts → uncapped, unchanged behaviour", () => {
    const out = toSExprString(Array.from({ length: 200 }, (_, i) => i));
    expect(out).not.toContain("more of");
    expect(out).toContain("199");
  });

  it("a bare indent number still means 'no caps'", () => {
    const out = toSExprString(Array.from({ length: 200 }, (_, i) => i), 2);
    expect(out).not.toContain("more of");
  });

  it("caps a long array to maxItems with a `+N more of TOTAL` marker", () => {
    const out = toSExprString(
      Array.from({ length: 1000 }, (_, i) => i),
      { maxItems: 10 },
    );
    expect(out).toContain("#| +990 more of 1000 |#");
    expect(out).toContain("9"); // first items shown
    expect(out).not.toContain("999"); // the tail is never serialized
  });

  it("caps a long string with an inline char-count marker", () => {
    const out = toSExprString("x".repeat(5000), { maxStringChars: 20 });
    expect(out).toContain("…(+4980 chars)");
    expect(out).not.toContain("x".repeat(100));
  });

  it("a single large string is shown fine — not squeezed by structure", () => {
    // one big string, generous per-string cap, total budget it fits under → no shrink
    const out = toSExprString("z".repeat(10000), { maxTotalChars: 5000, maxStringChars: 3000 });
    expect(out).toContain("…(+7000 chars)");
    expect(out).not.toContain("⚠");
  });

  it("shrink-to-fit keeps output under maxTotalChars, with a ⚠ note", () => {
    const heavy = Array.from({ length: 80 }, (_, i) => ({ id: i, payload: "y".repeat(400) }));
    const out = toSExprString(heavy, { maxTotalChars: 4000 });
    expect(out).toContain("⚠ output reduced to fit");
    expect(out.length).toBeLessThanOrEqual(4000 + 400); // content bounded + the note + remedy
  });

  it("the reduced-output banner teaches the RELEVANT remedy (collection vs string vs both)", () => {
    // A capped COLLECTION (many small items, no long strings) → filter/map/reduce advice,
    // and NOT the substring advice.
    const manyItems = Array.from({ length: 800 }, (_, i) => ({ id: i }));
    const coll = toSExprString(manyItems, { maxTotalChars: 500 });
    expect(coll).toContain("⚠ output reduced to fit");
    expect(coll).toContain("filter/map/reduce the collection");
    expect(coll).not.toContain("substring");

    // A capped STRING (one huge string forced under a small total) → substring advice, and
    // NOT the collection advice.
    const str = toSExprString("q".repeat(50000), { maxTotalChars: 400, maxStringChars: 30000 });
    expect(str).toContain("⚠ output reduced to fit");
    expect(str).toContain("substring");
    expect(str).not.toContain("filter/map/reduce the collection");

    // BOTH capped → the combined remedy mentions both levers.
    const mixed = Array.from({ length: 800 }, (_, i) => ({ id: i, blob: "z".repeat(500) }));
    const both = toSExprString(mixed, { maxTotalChars: 3000 });
    expect(both).toContain("⚠ output reduced to fit");
    expect(both).toContain("filter/map/reduce the collection");
    expect(both).toContain("substring");
  });

  describe("COMPETENCE v2 remedy modes (collectionRemedyMode / stringRemedyMode)", () => {
    const manyItems = Array.from({ length: 800 }, (_, i) => ({ id: i }));
    const hugeString = "q".repeat(50000);
    const mixed = Array.from({ length: 800 }, (_, i) => ({ id: i, blob: "z".repeat(500) }));

    it("collectionRemedyMode: 'suppressed' drops the collection clause but keeps the factual banner part", () => {
      const out = toSExprString(manyItems, { maxTotalChars: 500, collectionRemedyMode: "suppressed" });
      expect(out).toContain("⚠ output reduced to fit response budget of 500 chars");
      expect(out).toContain("showing ≤");
      expect(out).not.toContain("filter/map/reduce");
      expect(out).not.toContain("substring");
    });

    it("stringRemedyMode: 'suppressed' drops the string clause but keeps the factual banner part", () => {
      const out = toSExprString(hugeString, { maxTotalChars: 400, maxStringChars: 30000, stringRemedyMode: "suppressed" });
      expect(out).toContain("⚠ output reduced to fit response budget of 400 chars");
      expect(out).toContain("showing ≤");
      expect(out).not.toContain("substring");
      expect(out).not.toContain("filter/map/reduce");
    });

    it("suppresses independently — collection suppressed alone still teaches the (verbose) string remedy on a both-capped result", () => {
      const out = toSExprString(mixed, { maxTotalChars: 3000, collectionRemedyMode: "suppressed" });
      expect(out).toContain("⚠ output reduced to fit");
      expect(out).not.toContain("filter/map/reduce");
      expect(out).toContain("slice the long string with substring");
    });

    it("suppresses independently — string suppressed alone still teaches the (verbose) collection remedy on a both-capped result", () => {
      const out = toSExprString(mixed, { maxTotalChars: 3000, stringRemedyMode: "suppressed" });
      expect(out).toContain("⚠ output reduced to fit");
      expect(out).toContain("filter/map/reduce the collection");
      expect(out).not.toContain("substring");
    });

    it("both suppressed → banner has neither remedy clause, only the factual part", () => {
      const out = toSExprString(mixed, {
        maxTotalChars: 3000,
        collectionRemedyMode: "suppressed",
        stringRemedyMode: "suppressed",
      });
      expect(out).toContain("⚠ output reduced to fit");
      expect(out).not.toContain("filter/map/reduce");
      expect(out).not.toContain("substring");
    });

    it("no modes set (regression pin) → default verbose, both clauses present when both cap", () => {
      const out = toSExprString(mixed, { maxTotalChars: 3000 });
      expect(out).toContain(
        "filter/map/reduce the collection in your program to keep only the items you need, instead of paging them all back",
      );
      expect(out).toContain("slice the long string with substring, or scan it with string-contains, to pull just the part you need");
    });

    it("'compact' mode renders the short reminder form of the SAME pattern, per class, and STILL carries an exact-syntax action kernel (errors-as-doors: 'X helps' alone is an anti-door)", () => {
      const collOnly = toSExprString(manyItems, { maxTotalChars: 500, collectionRemedyMode: "compact" });
      expect(collOnly).toContain("(map (lambda (x) (:field x)) coll)");
      expect(collOnly).not.toContain("filter/map/reduce the collection in your program");

      const strOnly = toSExprString(hugeString, { maxTotalChars: 400, maxStringChars: 30000, stringRemedyMode: "compact" });
      expect(strOnly).toContain("(substring s 0 2000)");
      expect(strOnly).not.toContain("slice the long string with substring");

      const both = toSExprString(mixed, { maxTotalChars: 3000, collectionRemedyMode: "compact", stringRemedyMode: "compact" });
      expect(both).toContain("(map (lambda (x) (:field x)) coll)");
      expect(both).toContain("(substring s 0 2000)");
    });

    it("modes are independent per class — one verbose, one compact, on the same both-capped result", () => {
      const out = toSExprString(mixed, { maxTotalChars: 3000, collectionRemedyMode: "verbose", stringRemedyMode: "compact" });
      expect(out).toContain("filter/map/reduce the collection in your program");
      expect(out).toContain("(substring s 0 2000)");
      expect(out).not.toContain("slice the long string with substring");
    });

    it("onRemedyRendered fires exactly for the classes whose clause actually rendered, never for a suppressed or non-capped class", () => {
      const rendered: string[] = [];
      toSExprString(mixed, {
        maxTotalChars: 3000,
        stringRemedyMode: "suppressed",
        onRemedyRendered: (cls) => rendered.push(cls),
      });
      expect(rendered).toEqual(["collection"]);

      const renderedNeither: string[] = [];
      toSExprString("z".repeat(10000), {
        maxTotalChars: 5000,
        maxStringChars: 3000,
        onRemedyRendered: (cls) => renderedNeither.push(cls),
      }); // fits under budget uncapped-by-total (no ⚠ at all) — no clause, no callback
      expect(renderedNeither).toEqual([]);
    });
  });

  it("shrink-to-fit is FAIR across siblings — both PSLIST and PSSCAN survive the diff", () => {
    const pslist = Array.from({ length: 500 }, (_, i) => ({ pid: i, name: `proc${i}` }));
    const psscan = Array.from({ length: 600 }, (_, i) => ({ pid: i, name: `scan${i}` }));
    const out = toSExprString(
      [
        ["PSLIST", pslist],
        ["PSSCAN", psscan],
      ],
      { maxTotalChars: 3000 },
    );
    // The second sibling is NOT tail-cut away — both labels and their `+N more` markers present.
    expect(out).toContain("PSLIST");
    expect(out).toContain("PSSCAN");
    expect(out).toMatch(/of 500/);
    expect(out).toMatch(/of 600/);
    expect(out.length).toBeLessThanOrEqual(3000 + 300);
  });

  it("the truncated form still PARSES — the marker is a #| block comment |#", () => {
    const out = toSExprString(
      Array.from({ length: 100 }, (_, i) => i),
      { maxItems: 5 },
    );
    expect(out).toMatch(/#\| \+95 more of 100 \|#/);
  });

  describe("truncationBanner (A/B measurement knob: silence the announcement, keep the caps)", () => {
    const heavy = Array.from({ length: 80 }, (_, i) => ({ id: i, payload: "y".repeat(400) }));

    it('"none" caps the output exactly like the default, but emits zero ⚠ and no banner text', () => {
      const full = toSExprString(heavy, { maxTotalChars: 4000 });
      const none = toSExprString(heavy, { maxTotalChars: 4000, truncationBanner: "none" });
      expect(full).toContain("⚠ output reduced to fit");
      expect(none).not.toContain("⚠");
      expect(none).not.toContain("output reduced");
      expect(none.length).toBeLessThanOrEqual(4000);
      // The "none" render is exactly the "full" render minus the prepended banner line.
      expect(full.endsWith(`\n${none}`)).toBe(true);
    });

    it('"none" never fires onRemedyRendered — there is no clause to give feedback about', () => {
      const rendered: string[] = [];
      toSExprString(heavy, { maxTotalChars: 4000, truncationBanner: "none", onRemedyRendered: (cls) => rendered.push(cls) });
      expect(rendered).toEqual([]);
    });

    it('"none" still hard-truncates content at the floor for pathologically nested input (caps enforced, only the note differs)', () => {
      // Deeply nested structure that can't shrink below budget via item/string caps alone.
      const deeplyNested = Array.from({ length: 50 }, (_, i) => ({ id: i, nested: { a: 1, b: 2, c: 3, d: 4 } }));
      const out = toSExprString(deeplyNested, { maxTotalChars: 50, truncationBanner: "none" });
      expect(out.length).toBeLessThanOrEqual(50 + 100); // hard-cut marker is separate from the banner
      expect(out).not.toContain("⚠ output reduced to fit");
    });

    it('unset (default) is unchanged — "full" behaviour, banner present', () => {
      const out = toSExprString(heavy, { maxTotalChars: 4000 });
      expect(out).toContain("⚠ output reduced to fit");
    });

    it('explicit "full" is byte-identical to omitting the option', () => {
      const omitted = toSExprString(heavy, { maxTotalChars: 4000 });
      const explicit = toSExprString(heavy, { maxTotalChars: 4000, truncationBanner: "full" });
      expect(explicit).toBe(omitted);
    });

    it('a result that never shrinks is unaffected by truncationBanner either way (no banner in either case)', () => {
      const small = [1, 2, 3];
      const full = toSExprString(small, { maxTotalChars: 4000 });
      const none = toSExprString(small, { maxTotalChars: 4000, truncationBanner: "none" });
      expect(full).toBe(none);
      expect(full).not.toContain("⚠");
    });
  });
});

describe("SerializeOpts.format — a custom formatter rides the caps + shrink machinery", () => {
  // A toy bracket formatter standing in for arrival-manifold's brace/bracket
  // observation renderer — the seam's real consumer. Non-list nodes delegate to the
  // default rendering via String() (enough for numbers and the marker-bearing leaves
  // this suite feeds it).
  const bracketed = (sexpr: unknown): string => {
    if (Array.isArray(sexpr)) {
      const [head, ...tail] = sexpr as unknown[];
      if (head === "list") return `[${tail.map(bracketed).join(" ")}]`;
      return `(${(sexpr as unknown[]).map(bracketed).join(" ")})`;
    }
    if (sexpr !== null && typeof sexpr === "object") {
      // the truncation marker object — render its note like formatSExpr does
      const note = (sexpr as Record<symbol, string>)[Symbol.for("arrival:truncated")];
      if (note !== undefined) return `#| ${note} |#`;
    }
    return String(sexpr);
  };

  it("is used for the no-caps path", () => {
    expect(toSExprString([1, 2, 3], { format: bracketed })).toBe("[1 2 3]");
  });

  it("sees the streaming caps' truncation markers", () => {
    const out = toSExprString(
      Array.from({ length: 100 }, (_, i) => i),
      { maxItems: 5, format: bracketed },
    );
    expect(out.startsWith("[0 1 2 3 4 ")).toBe(true);
    expect(out).toContain("#| +95 more of 100 |#");
  });

  it("is re-invoked by the shrink-to-fit loop — the ⚠ note wraps the CUSTOM rendering", () => {
    const heavy = Array.from({ length: 500 }, (_, i) => i * 1000);
    const out = toSExprString(heavy, { maxTotalChars: 300, format: bracketed });
    expect(out).toContain("⚠ output reduced to fit");
    expect(out).toContain("[");
    expect(out.length).toBeLessThanOrEqual(300 + 300);
  });
});
