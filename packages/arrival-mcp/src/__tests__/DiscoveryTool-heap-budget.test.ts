// `DiscoveryTool.call` is a PROGRAM-SCOPED production entry, so it opts the `exec` primitive's
// heap bound ON by default — the primitive itself stays opt-in (proven by
// `foundations/arrival/arrival/src/__tests__/heap-budget-sequence-ops.test.ts`, which exercises
// the raw `exec()` and shows it's unbounded absent an explicit `heapBudget`).
// Wall-clock is already bounded (`DEFAULT_BUDGET_MS`, DiscoveryTool.ts:223) — this file covers
// only the heap axis.

import { describe, expect, it, afterEach } from "vitest";
import { DiscoveryTool, defaultHeapBudget } from "../DiscoveryTool.js";
import { McpEnvCapability } from "../McpEnvCapability.js";

/** No verbs, no configuration — every call runs on the base sandboxed env alone (which already
 *  provides `map`/`lambda`/list literals, per the standard base's SAFE_BUILTINS). */
const emptyCapability = (): McpEnvCapability => new McpEnvCapability("empty-caps", {});

const lit = (n: number) => `'(${Array.from({ length: n }, (_, i) => i).join(" ")})`;

afterEach(() => {
  delete process.env.ARRIVAL_HEAP_MAX;
});

describe("DiscoveryTool.call — heap budget default ON (gap 1)", () => {
  it("defaultHeapBudget() is the discovery-run.ts precedent absent an env override", () => {
    expect(defaultHeapBudget()).toBe(100_000_000);
  });

  it("ARRIVAL_HEAP_MAX overrides the default — a tight env cap trips a churn expr with no explicit heapBudget option", async () => {
    process.env.ARRIVAL_HEAP_MAX = "50";
    const tool = new DiscoveryTool("demo", emptyCapability(), { description: "demo tool" });
    const out = await tool.call({ expr: `(map (lambda (x) x) ${lit(500)})` });
    expect(out[0]).toMatch(/^\(error /);
    expect(out[0]).toContain("heap budget exceeded");
  });

  it("the built-in default (100M class) is generous — the SAME churn expr succeeds with no env override", async () => {
    const tool = new DiscoveryTool("demo", emptyCapability(), { description: "demo tool" });
    const out = await tool.call({ expr: `(map (lambda (x) x) ${lit(500)})` });
    expect(out[0]).not.toMatch(/^\(error /);
  });

  it("an explicit DiscoveryToolOptions.heapBudget always wins over the env default", async () => {
    process.env.ARRIVAL_HEAP_MAX = "1000000000"; // generous — the explicit option must still beat it
    const tool = new DiscoveryTool("demo", emptyCapability(), { description: "demo tool", heapBudget: 50 });
    const out = await tool.call({ expr: `(map (lambda (x) x) ${lit(500)})` });
    expect(out[0]).toContain("heap budget exceeded");
  });
});
