// R0 pin (docs/working-proposals/arrival-mcp-rework-over-phases.md, Part IV — R0):
// "per-call output today's exact shape". `DiscoveryTool.call` returns `Promise<string[]>` — a
// PLAIN array, one element per top-level form of `args.expr`, in program order, with no envelope
// (no `{results: […]}` wrapper, no per-form metadata). This is the exact shape §2.5's `ReplEvent`
// aggregation law must remain compatible with: "the final `CallToolResult` ≡ the ordered
// concatenation of the statement events' FULL `ContentBlock` lists" — i.e. today's `string[]` is
// the degenerate (unstreamed) case of that same ordered-concatenation law.

import { describe, expect, it } from "vitest";

import { DiscoveryTool } from "../DiscoveryTool.js";
import { McpEnvCapability } from "../McpEnvCapability.js";

function demoTool(): DiscoveryTool {
  return new DiscoveryTool("demo", new McpEnvCapability("demo-caps", { symbols: {}, annotations: {} }), {
    description: "demo tool",
  });
}

describe("R0 pin — call() return shape: plain string[], one element per top-level form, in order", () => {
  it("a single form → a single-element array", async () => {
    const out = await demoTool().call({ expr: "(+ 1 1)" }, { session: { id: "s1", state: {} } });
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual(["2"]);
  });

  it("N successful top-level forms → an N-element array in program order (no reordering, no coalescing)", async () => {
    const out = await demoTool().call(
      { expr: "(+ 1 1)\n(+ 2 2)\n(+ 3 3)\n(+ 4 4)" },
      { session: { id: "s1", state: {} } },
    );
    expect(out).toEqual(["2", "4", "6", "8"]);
    expect(out).toHaveLength(4);
  });

  it("no top-level forms (empty expr) → an empty array", async () => {
    const out = await demoTool().call({ expr: "" }, { session: { id: "s1", state: {} } });
    expect(out).toEqual([]);
  });

  it("a parse-time failure (unparseable expr) → a SINGLE-element array: one (error …) door, zero forms executed", async () => {
    const out = await demoTool().call({ expr: "(unterminated" }, { session: { id: "s1", state: {} } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^\(error /);
  });

  it("a runtime crash mid-batch → array length == successes-so-far + exactly one trailing (error …); later forms never run", async () => {
    const out = await demoTool().call(
      { expr: "(+ 1 1)\n(this-verb-does-not-exist)\n(+ 999 999)" },
      { session: { id: "s1", state: {} } },
    );
    expect(out).toHaveLength(2); // NOT 3 — the third form never executes
    expect(out[0]).toBe("2");
    expect(out[1]).toMatch(/^\(error /);
  });

  it("every element is a STRING (the serialized s-expr text), never a structured/object value", async () => {
    const out = await demoTool().call({ expr: '(list 1 "two" 3.0)' }, { session: { id: "s1", state: {} } });
    for (const el of out) expect(typeof el).toBe("string");
  });
});
