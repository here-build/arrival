// elision-e2e — the full path (serializer-elision plan): a REAL bound-tool upstream returns a
// too-long array, through `createManifoldTool`'s default calibration (which now sets
// `DEFAULT_MANIFOLD_OBSERVATION_ELISION` — no test-side override), and the observation the
// model reads back is middle-elided (small head + LOUD "N ... were not rendered" marker + small
// tail) with a trailing `;; Note:` content block. This is the grounding-failure fix itself:
// the real MCP-Atlas forensics (task 6896416f...c8c7) found a 100-book array rendered ~93-deep
// with a tiny `+7 more of 100` marker buried at the very end, read by the model as complete —
// the answer book was in the hidden 7.

import { describe, expect, it } from "vitest";

import { toBoundTools, buildManifoldEnv } from "../bind.js";
import { createManifoldTool, type ManifoldTool } from "../manifold-tool.js";

const texts = (r: { content: unknown }): string[] => (r.content as Array<{ type: string; text: string }>).map((b) => b.text);

// 150 — clearly over the manifold's default `topLevelArrayLimit` (100), so this actually
// elides (an array sitting exactly AT the limit renders in full — no reduction needed at
// all, which is correct: the real MCP-Atlas failure was a small-content array shown almost
// complete via CHAR-budget-driven shrink, not the count boundary itself. 150 removes that
// ambiguity and demonstrates the mechanism unconditionally).
async function libraryTool(): Promise<ManifoldTool> {
  const books = Array.from({ length: 150 }, (_, i) => ({ id: i, title: `Book ${i}`, author: `Author ${i}` }));
  const manifoldEnv = await buildManifoldEnv([
    {
      slug: "library",
      tools: [
        {
          name: "list-books",
          description: "List every book in the catalog",
          inputSchema: { type: "object", properties: {} },
          invoke: async () => books,
        },
      ],
    },
  ]);
  return createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
}

describe("elision e2e — a real bound-tool result that is a too-long array", () => {
  it("middle-elides (small head + LOUD marker + small tail) instead of a near-complete tail dump", async () => {
    const tool = await libraryTool();
    const result = await tool.call({ expr: "(library/list-books)" });
    expect(result.isError).toBeFalsy();

    const blocks = texts(result);
    const observation = blocks.find((t) => t.startsWith("["));
    expect(observation).toBeDefined();
    // Loud middle marker — never a buried tail footnote.
    expect(observation).toMatch(/#\| \d+ .+ were not rendered; total array length is 150 \|#/);
    // Only a SMALL head + tail actually render (id 0..4 and 145..149 — the manifold's default
    // elideHead/elideTail is 5/5), never a near-complete dump like the real failure had.
    expect(observation).toContain(":id 0");
    expect(observation).toContain(":id 149");
    expect(observation).not.toContain(":id 75"); // the hidden middle is genuinely absent
  });

  // RE-PINNED per second-foundation/arrival-bench/docs/benchmark-defect-register.md §E2/§S5: the old `;; Note:` block enumerated
  // ONE line PER elided collection (measured across the benchmark corpus: 1805 lines / 171
  // blocks / 67 files, one file at 125,571 bytes = 33% of the file) and restated the per-shape
  // tautology the serializer's own inline `#| N similar items were not rendered … |#` marker
  // (arrival-serializer/src/serializer.ts) already carries at the elision site — 100% redundant
  // AND worse: both models in the forensic corpus read the enumeration as proof the VALUE itself
  // had been destroyed and permanently abandoned the REPL for python. The invariant this test
  // protects — "exactly ONE note summarizes the elision, regardless of how many collections
  // elided" — still holds; what changed is (a) the note is now ONE line unconditionally (never
  // per-collection), (b) it rides the consolidated `#| ── environment notes ── … |#` trailing
  // block (§E3) instead of a standalone `;; Note:`-prefixed block, and (c) — the actual point of
  // the fix — it now says explicitly that the value is INTACT, the exact missing sentence that
  // drove the python defections.
  it("carries exactly ONE trailing note summarizing the elision, and it says the value is intact", async () => {
    const tool = await libraryTool();
    const result = await tool.call({ expr: "(library/list-books)" });

    const blocks = texts(result);
    const noteBlocks = blocks.filter((t) => t.includes("── environment notes ──"));
    expect(noteBlocks).toHaveLength(1);
    // The whole point of E2/S5: the model must be told the FULL value survives, so it binds and
    // filters in-program instead of concluding the data was lost (the python-defection driver).
    expect(noteBlocks[0]).toContain("the full value is intact in the session");
    expect(noteBlocks[0]).toContain("bind it and filter/aggregate in-program");
    expect(noteBlocks[0]).toContain("large results were sampled for display");
    // No more per-collection enumeration/tautology ("array of 150 items:" / "same shape as
    // shown") — the note is ONE line about the FACT the value survives, not a re-description of
    // what was shown.
    expect(noteBlocks[0]).not.toContain("array of 150 items:");
  });

  it("a call whose result fits within the manifold's limits carries no elision marker and no note", async () => {
    const manifoldEnv = await buildManifoldEnv([
      {
        slug: "library",
        tools: [
          {
            name: "list-books",
            description: "List every book in the catalog",
            inputSchema: { type: "object", properties: {} },
            invoke: async () => Array.from({ length: 5 }, (_, i) => ({ id: i, title: `Book ${i}` })),
          },
        ],
      },
    ]);
    const tool = createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
    const result = await tool.call({ expr: "(library/list-books)" });

    const blocks = texts(result);
    expect(blocks.some((t) => t.includes("were not rendered"))).toBe(false);
    // §E3: a standalone `;; Note:` block no longer exists at all — but the invariant this
    // asserted (nothing elided ⇒ no elision advisory) still needs checking against the new
    // consolidated channel's header.
    expect(blocks.some((t) => t.includes("── environment notes ──"))).toBe(false);
  });
});
