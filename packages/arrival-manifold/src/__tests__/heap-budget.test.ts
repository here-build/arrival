// heap-budget.test.ts — gap 1 of the arrival-promises completion plan (the "B-budget" tranche):
// the manifold eval seam (`foundations/arrival/mcp-substrate/src/runner.ts`'s per-statement
// `exec(form, …)` call) opts the heap bound ON by default — the primitive itself stays opt-in
// (proven by
// `foundations/arrival/arrival/src/__tests__/heap-budget-sequence-ops.test.ts`). Wall-clock was
// already bounded (`timeout.test.ts`, H-1) — this file only covers the NEW heap axis.

import { LexicalScope } from "@inhuman.tools/arrival";
import { assembleAmbient, type AssembledAmbient } from "@inhuman.tools/arrival/env";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createManifoldTool } from "../manifold-tool.js";

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");

const lit = (n: number) => `'(${Array.from({ length: n }, (_, i) => i).join(" ")})`;

// ONE bare ambient (no capabilities, no tools) shared across every test in this file — it is
// stateless and immutable, so sharing it costs nothing; only the SCOPE needs to be fresh per
// test, for isolation between cases.
let ambient: AssembledAmbient;
beforeAll(async () => {
  ambient = await assembleAmbient({});
});
afterAll(async () => {
  await ambient.dispose();
});

afterEach(() => {
  delete process.env.ARRIVAL_HEAP_MAX;
});

describe("manifold-tool — heap budget default ON (gap 1)", () => {
  it("ARRIVAL_HEAP_MAX overrides the default — a tight env cap trips a churn statement with no explicit heapBudget", async () => {
    process.env.ARRIVAL_HEAP_MAX = "50";
    const scope = LexicalScope.fresh("test");
    const tool = createManifoldTool({ ambient, scope }, "CATALOG");
    const result = await tool.call({ expr: `(map (lambda (x) x) ${lit(500)})` });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("heap budget exceeded");
  });

  it("the built-in default (100M class) is generous — the SAME churn statement succeeds with no env override", async () => {
    const scope = LexicalScope.fresh("test");
    const tool = createManifoldTool({ ambient, scope }, "CATALOG");
    const result = await tool.call({ expr: `(map (lambda (x) x) ${lit(500)})` });
    expect(result.isError).toBeFalsy();
  });

  it("an explicit ManifoldToolOptions.heapBudget always wins over the env default", async () => {
    process.env.ARRIVAL_HEAP_MAX = "1000000000"; // generous — the explicit option must still beat it
    const scope = LexicalScope.fresh("test");
    const tool = createManifoldTool({ ambient, scope }, "CATALOG", { heapBudget: 50 });
    const result = await tool.call({ expr: `(map (lambda (x) x) ${lit(500)})` });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("heap budget exceeded");
  });
});
