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
  });

  it("shrink-to-fit keeps output under maxTotalChars — no top-of-output banner, just the bounded content", () => {
    const heavy = Array.from({ length: 80 }, (_, i) => ({ id: i, payload: "y".repeat(400) }));
    const out = toSExprString(heavy, { maxTotalChars: 4000 });
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).not.toContain("⚠");
    expect(out).not.toContain("output reduced");
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
    expect(out.length).toBeLessThanOrEqual(3000);
  });

  it("the truncated form still PARSES — the marker is a #| block comment |#", () => {
    const out = toSExprString(
      Array.from({ length: 100 }, (_, i) => i),
      { maxItems: 5 },
    );
    expect(out).toMatch(/#\| \+95 more of 100 \|#/);
  });

  it("floor still over budget (pathological nesting) → hard-cut marker, no banner", () => {
    const deeplyNested = Array.from({ length: 50 }, (_, i) => ({ id: i, nested: { a: 1, b: 2, c: 3, d: 4 } }));
    const out = toSExprString(deeplyNested, { maxTotalChars: 50 });
    expect(out.length).toBeLessThanOrEqual(50 + 100); // hard-cut marker is the only note
    expect(out).toContain("output hard-truncated at 50 chars");
    expect(out).not.toContain("⚠ output reduced to fit");
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

  it("is re-invoked by the shrink-to-fit loop — the CUSTOM rendering stays bounded, no banner", () => {
    const heavy = Array.from({ length: 500 }, (_, i) => i * 1000);
    const out = toSExprString(heavy, { maxTotalChars: 300, format: bracketed });
    expect(out).toContain("[");
    expect(out.length).toBeLessThanOrEqual(300);
  });
});
