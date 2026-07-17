import { port, type Resource } from "@inhuman.tools/arrival/resources";
import type { ReplEvent } from "@inhuman.tools/mcp-substrate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { ActionTool } from "../ActionTool.js";
import { DiscoveryTool } from "../DiscoveryTool.js";
import { McpEnvCapability } from "../McpEnvCapability.js";
import { str } from "../refs.js";
import { ARRIVAL_EVENT_METHOD, type McpTool, registerTools } from "../sdk-adapter.js";

const greeter = (cfg: { who: string }): Resource<{ hello: () => string }> => ({
  kind: "greeter",
  async acquire() {
    return port({ hello: () => `hi ${cfg.who}` }, () => {});
  },
});

function demoTool(): DiscoveryTool {
  const capability = new McpEnvCapability("demo-caps", {
    configuration: { who: z.string() },
    resources: { greeter: (cfg) => greeter(cfg as { who: string }) },
    symbols: {
      greet: {
        fn(this: { resources: { greeter: { live: { hello: () => string } } } }) {
          return this.resources.greeter.live.hello();
        },
      },
    },
    annotations: { greet: { description: "greets the configured person" } },
  });
  return new DiscoveryTool("demo", capability, { description: "demo tool" });
}

/** An ActionTool sharing the same wiring — to prove both tiers register identically. Typed as
 *  `McpTool` (CS-erased): `ActionTool<CS>` is invariant in CS, so a concrete CS won't widen. */
function echoActionTool(): McpTool {
  return new ActionTool<{ docId: string }>("echo-edit", {
    description: "echo action tool",
    context: { docId: str("the doc id") },
    actions: (b) => [
      b.act({
        name: "append",
        needs: ["docId"],
        desc: "append text",
        props: { text: str() },
        handle: (ctx, _r, { text }) => ({ ok: true, doc: ctx.docId, text }),
      }),
    ],
  });
}

/** A real round-trip through the official SDK: Client ↔ Server over a linked in-memory transport. */
async function connectedClient(tools: McpTool[]): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerTools(server, tools, () => ({ session: { id: "s1", state: {} } }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tester", version: "0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("registerTools (official @modelcontextprotocol/sdk round-trip)", () => {
  it("registers BOTH a DiscoveryTool and an ActionTool on one McpServer", async () => {
    const client = await connectedClient([demoTool(), echoActionTool()]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["demo", "echo-edit"]);
    // the ActionTool dispatches a batch and its result object serializes over the wire
    const res = await client.callTool({
      name: "echo-edit",
      arguments: { intent: "echo", docId: "d1", actions: [["append", { text: "hi" }]] },
    });
    expect((res.content as { type: string; text: string }[])[0]!.text).toContain("hi");
    await client.close();
  });

  it("lists a DiscoveryTool through tools/list, with the config-derived input schema", async () => {
    const client = await connectedClient([demoTool()]);
    const { tools } = await client.listTools();
    const demo = tools.find((t) => t.name === "demo");
    expect(demo).toBeDefined();
    // `who` came from the capability's configuration — surfaced as an input property over the wire.
    expect(Object.keys(demo!.inputSchema.properties ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "expr",
      "intent",
      "who",
    ]);
    await client.close();
  });

  it("calls a verb through tools/call — config from args, resource spawned, value back over the wire", async () => {
    const client = await connectedClient([demoTool()]);
    const res = await client.callTool({ name: "demo", arguments: { expr: "(greet)", who: "ada" } });
    expect((res.content as { type: string; text: string }[])[0]!.text).toContain("hi ada");
    await client.close();
  });

  it("a runtime crash comes back as an (error …) form in the content (REPL-style, not a transport fault)", async () => {
    const client = await connectedClient([demoTool()]);
    const res = await client.callTool({ name: "demo", arguments: { expr: "(this-verb-does-not-exist)", who: "ada" } });
    // A statement crash is normal REPL output (a door), not a hard isError — earlier statements stand.
    expect((res.content as { type: string; text: string }[])[0]!.text).toMatch(/^\(error /);
    await client.close();
  });
});

describe("R5 — the dual notification channel over the official SDK (§2.5)", () => {
  it("rich tier: every ReplEvent rides notifications/arrival/event, in event order, BEFORE the final result lands", async () => {
    const client = await connectedClient([demoTool()]);
    const events: ReplEvent[] = [];
    client.fallbackNotificationHandler = async (notification) => {
      if (notification.method === ARRIVAL_EVENT_METHOD) events.push(notification.params as ReplEvent);
    };
    const res = await client.callTool({ name: "demo", arguments: { expr: "(+ 1 1)\n(greet)", who: "ada" } });
    // all frames preceded the response frame (the adapter awaits its send queue pre-lowering)
    expect(events.map((e) => e.kind)).toEqual(["topology", "statement", "statement"]);
    const topology = events[0] as Extract<ReplEvent, { kind: "topology" }>;
    expect(topology.total).toBe(2);
    expect(topology.forms.map((f) => f.source)).toEqual(["(+ 1 1)", "(greet)"]);
    // aggregate law over the wire: content texts ≡ concat of statement events' content texts
    const statementTexts = events
      .filter((e): e is Extract<ReplEvent, { kind: "statement" }> => e.kind === "statement")
      .flatMap((e) => e.content.map((b) => (b.type === "text" ? b.text : "")));
    expect((res.content as { type: string; text: string }[]).map((b) => b.text)).toEqual(statementTexts);
    await client.close();
  });

  it("progress tier: with a progressToken, topology ⇒ 0/total and each statement ⇒ index+1/total with the core text as message", async () => {
    const client = await connectedClient([demoTool()]);
    const progress: { progress: number; total?: number; message?: string }[] = [];
    await client.callTool(
      { name: "demo", arguments: { expr: "(+ 1 1)\n(greet)", who: "ada" } },
      CallToolResultSchema,
      { onprogress: (p) => progress.push(p) }, // the SDK mints _meta.progressToken for this call
    );
    expect(progress.map((p) => [p.progress, p.total])).toEqual([
      [0, 2], // topology — the "it's coming" signal
      [1, 2],
      [2, 2],
    ]);
    expect(progress[1]!.message).toBe("2");
    expect(progress[2]!.message).toBe('"hi ada"');
    await client.close();
  });

  it("without a progressToken the rich tier still flows and the aggregate is unchanged (additive observation)", async () => {
    const client = await connectedClient([demoTool()]);
    let richCount = 0;
    client.fallbackNotificationHandler = async (notification) => {
      if (notification.method === ARRIVAL_EVENT_METHOD) richCount += 1;
    };
    const res = await client.callTool({ name: "demo", arguments: { expr: "(greet)", who: "ada" } });
    expect(richCount).toBe(2); // topology + one statement
    expect((res.content as { type: string; text: string }[])[0]!.text).toContain("hi ada");
    await client.close();
  });

  it("a host-resolved onEvent (from resolveCtx) still observes every event — fan-out, never replacement", async () => {
    const hostEvents: ReplEvent[] = [];
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerTools(server, [demoTool()], () => ({
      session: { id: "s1", state: {} },
      onEvent: (event) => hostEvents.push(event),
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "tester", version: "0" }, { capabilities: {} });
    await client.connect(clientTransport);
    await client.callTool({ name: "demo", arguments: { expr: "(+ 1 1)", who: "ada" } });
    expect(hostEvents.map((e) => e.kind)).toEqual(["topology", "statement"]);
    await client.close();
  });
});
