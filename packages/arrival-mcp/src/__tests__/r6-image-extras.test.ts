// Attachment-extraction laws pinned by this suite:
//
//   • STREAMING-INLINE — a scheme program returning a structure with embedded Blobs streams
//     the `#attachment` tags inline in the core text, with the pixels attached as separate
//     blocks (a per-extra label text block, then its binary block).
//   • AGGREGATE — the final `CallToolResult` ≡ the ordered concatenation of the statement
//     events' FULL ContentBlock lists, text AND binary alike (`serializeResult` lowers the
//     aggregate's raw Blobs through the same `lowerBinaryBlob` the events used).
//   • TEXT-BUDGET — an extracted blob charges the s-expr text only its ~40-char tag.
//   • QUOTA — per call (`attachmentQuota`, the AttachmentSink `beginCall(quota)` shape),
//     consulted DURING the serializer walk: overflow drains a NOTE with the count, never
//     silently, and past-quota leaves are NEVER base64-encoded (spied below).
//   • OUTPUT-SHAPE COMPATIBILITY — a blob-free program still returns plain string[].

import type { ReplEvent, ReplStatementEvent } from "@inhuman.tools/mcp-substrate";
import { describe, expect, it, vi } from "vitest";

import { DiscoveryTool } from "../DiscoveryTool.js";
import { serializeResult } from "../dispatch.js";
import { McpEnvCapability } from "../McpEnvCapability.js";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

function shotTool(options: { attachmentQuota?: number } = {}, blobs?: Blob[]): DiscoveryTool {
  const cap = new McpEnvCapability("shot-caps", {
    symbols: {
      shot: { fn: () => blobs?.shift() ?? new Blob([PNG_BYTES], { type: "image/png" }) },
    },
    annotations: { shot: { description: "returns one screenshot blob" } },
  });
  return new DiscoveryTool("shot", cap, { description: "shot tool", ...options });
}

const statements = (events: ReplEvent[]): ReplStatementEvent[] =>
  events.filter((e): e is ReplStatementEvent => e.kind === "statement");

describe("R6 — streaming-inline: embedded Blobs tag inline, blocks attach", () => {
  it("a structure with an embedded Blob renders its tag in core and attaches label + image blocks", async () => {
    const events: ReplEvent[] = [];
    const tool = shotTool();
    const out = await tool.call(
      { expr: '(list "before" (shot) "after")' },
      { session: { id: "s1", state: {} }, onEvent: (event) => events.push(event) },
    );

    // Aggregate: core string (tag inline), label string, raw Blob — in statement order.
    expect(out).toHaveLength(3);
    // (bare-word string rendering inside lists is generic serializer formatting)
    expect(out[0]).toBe('(list before #attachment "att-1 (image/png, 12B)" after)');
    expect(out[1]).toBe("attachment #1: att-1 (image/png, 12B)");
    expect(out[2]).toBeInstanceOf(Blob);

    // Statement event: FULL content — core text, label text, then the binary block.
    const stmts = statements(events);
    expect(stmts).toHaveLength(1);
    const content = stmts[0]!.content;
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: "text", text: out[0] });
    expect(content[1]).toEqual({ type: "text", text: out[1] });
    expect(content[2]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(typeof (content[2] as { data: string }).data).toBe("string");
  });

  it("AGGREGATE law: serializeResult(out) ≡ ordered concat of statement events' FULL block lists", async () => {
    const events: ReplEvent[] = [];
    const tool = shotTool();
    const out = await tool.call(
      { expr: "(+ 1 1)\n(shot)" },
      { session: { id: "s2", state: {} }, onEvent: (event) => events.push(event) },
    );
    const lowered = await serializeResult(out);
    const concat = statements(events).flatMap((s) => [...s.content]);
    expect(lowered.content).toEqual(concat);
  });

  it("text budget is charged tag-only: a big screenshot never eats the s-expr budget", async () => {
    const big = new Blob([new Uint8Array(512 * 1024)], { type: "image/png" });
    const tool = shotTool({}, [big]);
    const out = await tool.call({ expr: "(shot)" }, { session: { id: "s3", state: {} } });
    const core = out[0];
    if (typeof core !== "string") throw new Error("core must be text");
    expect(core).toBe('#attachment "att-1 (image/png, 512kB)"');
    expect(core.length).toBeLessThan(80); // ~40-char tag class, never half a megabyte
  });

  it("a blob-free program still returns plain string[] (R0 output-shape compatibility)", async () => {
    const out = await shotTool().call({ expr: "(+ 1 1)\n(+ 2 2)" }, { session: { id: "s4", state: {} } });
    expect(out).toEqual(["2", "4"]);
  });
});

describe("R6 — quota: per call, overflow drains a note, past-quota leaves never encoded", () => {
  it("over quota: tag-only core, no blob attached, a note with the count — never silent", async () => {
    const events: ReplEvent[] = [];
    const first = new Blob([PNG_BYTES], { type: "image/png" });
    const second = new Blob([PNG_BYTES], { type: "image/png" });
    const secondEncode = vi.spyOn(second, "arrayBuffer");
    const tool = shotTool({ attachmentQuota: 1 }, [first, second]);

    const out = await tool.call(
      { expr: "(list (shot) (shot))" },
      { session: { id: "q1", state: {} }, onEvent: (event) => events.push(event) },
    );

    const core = out[0];
    if (typeof core !== "string") throw new Error("core must be text");
    expect(core).toContain('#attachment "att-1 (image/png, 12B)"');
    expect(core).toContain('#attachment "over-quota (image/png, 12B)"');

    // exactly ONE blob attached; the note names the overflow count and the quota.
    expect(out.filter((element) => element instanceof Blob)).toHaveLength(1);
    const note = out.find((element) => typeof element === "string" && element.includes("over quota"));
    expect(note).toContain("1 attachment(s) over quota (1)");

    // the past-quota leaf was NEVER base64-encoded (the spy law).
    expect(secondEncode).not.toHaveBeenCalled();

    // the note rides the statement event too (aggregate law holds with overflow).
    const stmts = statements(events);
    const texts = stmts[0]!.content.filter((b) => b.type === "text").map((b) => b.text);
    expect(texts.some((t) => t.includes("1 attachment(s) over quota"))).toBe(true);
  });

  it("quota spans the WHOLE call (all forms share one ExtrasState; ids stay call-unique)", async () => {
    const blobs = Array.from({ length: 3 }, () => new Blob([PNG_BYTES], { type: "image/png" }));
    const tool = shotTool({ attachmentQuota: 2 }, blobs);
    const out = await tool.call({ expr: "(shot)\n(shot)\n(shot)" }, { session: { id: "q2", state: {} } });
    const cores = out.filter(
      (element): element is string => typeof element === "string" && element.startsWith("#attachment"),
    );
    expect(cores[0]).toContain("att-1");
    expect(cores[1]).toContain("att-2");
    expect(cores[2]).toContain("over-quota"); // third form pays the call-level quota, not a fresh one
    expect(out.filter((element) => element instanceof Blob)).toHaveLength(2);
  });

  it("quota 0 attaches nothing and drains the note", async () => {
    const tool = shotTool({ attachmentQuota: 0 });
    const out = await tool.call({ expr: "(shot)" }, { session: { id: "q3", state: {} } });
    expect(out.filter((element) => element instanceof Blob)).toHaveLength(0);
    expect(out.some((element) => typeof element === "string" && element.includes("over quota"))).toBe(true);
  });
});

describe("R6 — non-streaming parity: no listener, same aggregate (encoding deferred to serializeResult)", () => {
  it("the aggregate is shape-identical with and without a listener", async () => {
    const plainTool = shotTool();
    const streamedTool = shotTool();
    const plain = await plainTool.call({ expr: "(shot)" }, { session: { id: "n1", state: {} } });
    const events: ReplEvent[] = [];
    const streamed = await streamedTool.call(
      { expr: "(shot)" },
      { session: { id: "n2", state: {} }, onEvent: (event) => events.push(event) },
    );
    expect(await serializeResult(plain)).toEqual(await serializeResult(streamed));
  });
});
