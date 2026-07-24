// SESSION DECLARATION PERSISTENCE — a top-level `(define ...)` submitted in one manifold
// tool call must be available in the NEXT tool call within the same session.
//
// STEP 1 FINDING (the load-bearing empirical result this file starts with): the manifold
// ALREADY persists defines call-to-call, via mechanism (a) — a PERSISTENT live env. Proof:
// server.ts's `buildManifoldServer` constructs exactly ONE `ManifoldTool` per "world" (see
// its `rebuild()`), and `createManifoldTool` (manifold-tool.ts) closes over that ONE
// `SchemeEnv` instance for every `call()` for as long as the tool lives — every statement
// runs `exec(statement, { env, ... })` against the SAME env object. The world (env + tool)
// is only ever replaced wholesale on a tools/listChanged notification (see
// list-changed.test.ts), which is a DELIBERATE full reset, not a per-call rebuild. So a
// `(define x 5)` in call 1 leaves a binding on the live env that call 2's `(+ x 1)` reads
// straight off it — no serialization or replay is needed for plain cross-call correctness.
// The first `describe` block below exercises this at the full MCP server/client boundary
// (mirroring list-changed.test.ts's harness) as direct confirmation, not new behavior.
//
// STEP 2 — the REPLAY model (V's design, session-history.ts): session state must ALSO be
// RECONSTRUCTABLE from a replay of only the successful top-level define SOURCE statements,
// for compactness + resumability — a session should be reconstructable/migratable from just
// its define history, without requiring the live env to stay resident. See
// session-history.ts's file header for the full design + the tool-valued-define
// skip-and-note tradeoff. The remaining `describe` blocks below cover: persistence,
// rebinding (last-wins), a define that errored not persisting, clearing on listChanged, the
// replay reconstruction itself, and the tool-valued-define handling.

import { exec } from "@inhuman.tools/arrival";
import { replaySessionHistory } from "@inhuman.tools/mcp-substrate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { buildManifoldEnv, type BoundServer, type ManifoldEnv } from "../bind.js";
import { connectServer } from "../connect.js";
import { createManifoldTool } from "../manifold-tool.js";
import { buildManifoldServer } from "../server.js";

const runExpr = (world: Pick<ManifoldEnv, "capabilities" | "config" | "runCtx" | "scope">, expr: string) =>
  exec(expr, { capabilities: world.capabilities, config: world.config, runCtx: world.runCtx, scope: world.scope });

const texts = (r: { content: unknown }): string[] =>
  (r.content as Array<{ type: string; text: string }>).map((b) => b.text);

/** A fake upstream with one tool-valued-friendly `echo` tool, for the server/client tests. */
async function echoUpstream(): Promise<{ clientTransport: InMemoryTransport }> {
  const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
  const tools: Tool[] = [
    {
      name: "echo",
      description: "echoes v",
      inputSchema: { type: "object", properties: { v: { type: "string" } }, required: ["v"] },
    },
  ];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: String((request.params.arguments as { v?: string })?.v ?? "") }],
  }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { clientTransport };
}

async function connectToManifold(manifoldServer: Awaited<ReturnType<typeof buildManifoldServer>>) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

describe("Step 1 finding — mechanism (a): the manifold already persists defines call-to-call", () => {
  it("a define in call 1 resolves in call 2 of the same session, at the full MCP server/client boundary", async () => {
    const upstream = await echoUpstream();
    const connected = await connectServer("up", upstream.clientTransport);
    const manifoldServer = await buildManifoldServer([connected]);
    const client = await connectToManifold(manifoldServer);

    const first = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(define session-var 42)" },
    });
    expect(first.isError).toBeFalsy();

    const second = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(+ session-var 1)" },
    });
    expect(second.isError).toBeFalsy();
    expect((second.content as Array<{ text: string }>)[0]?.text).toBe("43");
  });
});

describe("Step 2 — sessionHistory() tracking (session-history.ts)", () => {
  it("records a top-level define's verbatim source, available via sessionHistory() after the call", async () => {
    const env = await buildManifoldEnv([]);
    const tool = createManifoldTool(env, "CATALOG");
    await tool.call({ expr: "(define a 1)" });
    expect(tool.sessionHistory()).toEqual([{ name: "a", source: "(define a 1)", toolValued: false }]);
  });

  it("persists across calls — history accumulates, not just within one call", async () => {
    const env = await buildManifoldEnv([]);
    const tool = createManifoldTool(env, "CATALOG");
    await tool.call({ expr: "(define a 1)" });
    await tool.call({ expr: "(define b 2)" });
    expect(tool.sessionHistory().map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("rebinding a name is last-wins — the newest source replaces the old, moved to newest position", async () => {
    const env = await buildManifoldEnv([]);
    const tool = createManifoldTool(env, "CATALOG");
    await tool.call({ expr: "(define a 1)" });
    await tool.call({ expr: "(define b 2)" });
    await tool.call({ expr: "(define a 99)" });
    expect(tool.sessionHistory()).toEqual([
      { name: "b", source: "(define b 2)", toolValued: false },
      { name: "a", source: "(define a 99)", toolValued: false },
    ]);
  });

  it("a define that ERRORED does not persist into the history", async () => {
    const env = await buildManifoldEnv([]);
    const tool = createManifoldTool(env, "CATALOG");
    const result = await tool.call({ expr: "(define broken (car 42))" });
    expect(result.isError).toBe(true);
    expect(tool.sessionHistory()).toEqual([]);
  });

  it("clears on a tools/listChanged rebuild — a rebuilt tool starts with an empty history", async () => {
    // server.ts constructs a fresh ManifoldTool (and fresh sessionHistory, world-scoped) on
    // every rebuild; simulate that directly the way manifold-tool.test.ts style tests do —
    // two independently-constructed tools stand in for "before" and "after" a rebuild.
    const before = await buildManifoldEnv([]);
    const beforeTool = createManifoldTool(before, "CATALOG");
    await beforeTool.call({ expr: "(define a 1)" });
    expect(beforeTool.sessionHistory()).toHaveLength(1);

    const after = await buildManifoldEnv([]);
    const afterTool = createManifoldTool(after, "CATALOG");
    expect(afterTool.sessionHistory()).toEqual([]);
  });

  it("a tool-valued define is recorded with toolValued: true and does not degrade its stored source", async () => {
    const env = await buildManifoldEnv([
      {
        slug: "shop",
        tools: [
          {
            name: "price",
            description: "price lookup",
            inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
            invoke: async () => 10,
          },
        ],
      },
    ]);
    const tool = createManifoldTool(env, "CATALOG");
    await tool.call({ expr: '(define p (shop/price :item "widget"))' });
    expect(tool.sessionHistory()).toEqual([
      { name: "p", source: '(define p (shop/price :item "widget"))', toolValued: true },
    ]);
  });

  it(
    "regression (found+fixed 2026-07-05): a SLUGLESS bound tool with an underscore-free name " +
      "is ALSO recorded toolValued: true — the `_`-shape heuristic alone misses it (bind.ts's " +
      '`qualifiedName = server.slug === "" ? tool.name : ...`), but the real bound-tool roster ' +
      "threaded from manifold-tool.ts closes the gap",
    async () => {
      const env = await buildManifoldEnv([
        {
          slug: "",
          tools: [
            {
              name: "price", // no underscore anywhere in the qualified name
              description: "price lookup",
              inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
              invoke: async () => 10,
            },
          ],
        },
      ]);
      const tool = createManifoldTool(env, "CATALOG");
      await tool.call({ expr: '(define p (price :item "widget"))' });
      expect(tool.sessionHistory()).toEqual([
        { name: "p", source: '(define p (price :item "widget"))', toolValued: true },
      ]);
    },
  );
});

describe("Step 2 — replaySessionHistory() reconstructs session state from define history", () => {
  it("a fresh env reconstructed from the define-history reproduces the session's plain (non-tool-valued) state", async () => {
    const env = await buildManifoldEnv([]);
    const tool = createManifoldTool(env, "CATALOG");
    await tool.call({ expr: "(define a 1)" });
    await tool.call({ expr: "(define b (+ a 1))" });
    await tool.call({ expr: "(car 42)" }); // errors — must not appear in the replayed state

    const history = tool.sessionHistory();

    // A brand-new env for the SAME (empty) toolset, standing in for "a resumed session" —
    // no live env carried over, only the history.
    const fresh = await buildManifoldEnv([]);
    const result = await replaySessionHistory(history, fresh.capabilities, fresh.config, fresh.runCtx, fresh.scope);
    expect(result).toEqual({ applied: ["a", "b"], skipped: [], failed: [] });

    const [aVal] = await runExpr(fresh, "a");
    const [bVal] = await runExpr(fresh, "b");
    expect(String(aVal)).toBe("1");
    expect(String(bVal)).toBe("2");
  });

  it(
    "ORDERING CAVEAT: a rebind moves a name to newest position, so a statement depending on " +
      "its EARLIER value can replay before it and fail — reported in `failed`, never thrown (session-history.ts)",
    async () => {
      const env = await buildManifoldEnv([]);
      const tool = createManifoldTool(env, "CATALOG");
      await tool.call({ expr: "(define a 1)\n(define b (+ a 1))" });
      await tool.call({ expr: "(define a 100)" }); // rebind a AFTER b depended on its old value

      const history = tool.sessionHistory();
      expect(history.map((e) => e.name)).toEqual(["b", "a"]); // a moved to newest on rebind

      const fresh = await buildManifoldEnv([]);
      const result = await replaySessionHistory(history, fresh.capabilities, fresh.config, fresh.runCtx, fresh.scope);
      // b replays FIRST (history order) and fails — `a` isn't bound yet in the fresh env at
      // that point; a's rebind then succeeds. Best-effort: one failure never aborts the rest.
      expect(result).toEqual({ applied: ["a"], skipped: [], failed: ["b"] });

      const [aVal] = await runExpr(fresh, "a");
      expect(String(aVal)).toBe("100");
      await expect(runExpr(fresh, "b")).rejects.toThrow(/Unbound variable/);
    },
  );

  it("skips tool-valued defines (never re-invokes the tool) and reports them in `skipped`", async () => {
    let invocations = 0;
    const toolset: BoundServer[] = [
      {
        slug: "shop",
        tools: [
          {
            name: "price",
            description: "price lookup",
            inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
            invoke: async () => {
              invocations += 1;
              return 10;
            },
          },
        ],
      },
    ];
    const env = await buildManifoldEnv(toolset);
    const tool = createManifoldTool(env, "CATALOG");
    await tool.call({ expr: "(define plain 5)" });
    await tool.call({ expr: '(define priced (shop/price :item "widget"))' });
    expect(invocations).toBe(1);

    const history = tool.sessionHistory();
    const fresh = await buildManifoldEnv(toolset);
    const result = await replaySessionHistory(history, fresh.capabilities, fresh.config, fresh.runCtx, fresh.scope);

    // The tool was NEVER re-invoked by replay.
    expect(invocations).toBe(1);
    expect(result).toEqual({ applied: ["plain"], skipped: ["priced"], failed: [] });

    // The plain binding replayed; the tool-valued one is unbound in the reconstructed env,
    // same as if the caller never defined it there — exactly the documented tradeoff.
    const [plainVal] = await runExpr(fresh, "plain");
    expect(String(plainVal)).toBe("5");
    await expect(runExpr(fresh, "priced")).rejects.toThrow(/Unbound variable/);
  });

  it(
    "regression (found+fixed 2026-07-05): a slugless underscore-free tool call is ALSO " +
      "skipped on replay, never re-invoked — before the fix, this exact scenario replayed the " +
      "define verbatim and bumped the invocation counter a second time",
    async () => {
      let invocations = 0;
      const toolset: BoundServer[] = [
        {
          slug: "",
          tools: [
            {
              name: "price",
              description: "price lookup",
              inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
              invoke: async () => {
                invocations += 1;
                return 10;
              },
            },
          ],
        },
      ];
      const env = await buildManifoldEnv(toolset);
      const tool = createManifoldTool(env, "CATALOG");
      await tool.call({ expr: '(define p (price :item "widget"))' });
      expect(invocations).toBe(1);

      const history = tool.sessionHistory();
      const fresh = await buildManifoldEnv(toolset);
      const result = await replaySessionHistory(history, fresh.capabilities, fresh.config, fresh.runCtx, fresh.scope);

      // The tool was NEVER re-invoked by replay (before the fix this was 2).
      expect(invocations).toBe(1);
      expect(result).toEqual({ applied: [], skipped: ["p"], failed: [] });
      await expect(runExpr(fresh, "p")).rejects.toThrow(/Unbound variable/);
    },
  );
});
