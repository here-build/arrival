// Envelope doors (doors.ts + server.ts CallTool boundary + manifold-tool args
// validation) — errors-as-doors: every rejection is fact → reason → action, built as a
// structured payload at the rejection point, rendered verbose on a code's first
// per-session occurrence and terse after (Rule 4), logged as structured stderr lines
// with self-observed follow events (Rule 5). An UNMODIFIED MCP client pointed at the
// manifold gets all of it: doors arrive as ordinary isError tool results, never
// transport throws.

import {
  ambiguousBypassDoor,
  bareToolCallDoor,
  DoorSession,
  nearestBoundNames,
  nonBareKwargKeys,
  normalizeSymbolName,
  renderRetryExpr,
  unboundInExprDoor,
  unknownToolDoor,
  type BoundTool,
  type ToolJsonSchema,
} from "@inhuman.tools/mcp-substrate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildManifoldEnv, toBoundTools } from "../bind.js";
import { connectServer } from "../connect.js";
import { createManifoldTool } from "../manifold-tool.js";
import { ARG_NAME, TOOL_NAME } from "../names.js";
import { buildManifoldServer } from "../server.js";

/** The manifold's own naming — every direct doors.ts call in this file threads it, mirroring
 *  server.ts's own `TOOL_NAMING` fixture (doors.ts no longer imports names.ts directly; see
 *  mcp-substrate's `ToolNaming`). */
const TOOL_NAMING = { toolName: TOOL_NAME, argName: ARG_NAME };

/** Test-only helper: builds a minimal `BoundTool` registry straight from explicit (slug, tool)
 *  pairs — the SAME discipline bind.ts requires of every real caller (never re-split a joined
 *  string). `signature()` is a stub (these tests never inspect it); mirrors bind.test.ts's
 *  identical helper. */
function toolParts(entries: ReadonlyArray<{ slug: string; tool: string }>): ReadonlyMap<string, BoundTool> {
  const map = new Map<string, BoundTool>();
  for (const entry of entries) {
    const qualified = entry.slug === "" ? entry.tool : `${entry.slug}/${entry.tool}`;
    map.set(qualified, {
      qualifiedName: qualified,
      slug: entry.slug,
      tool: entry.tool,
      signature: () => ({ params: [], signatureText: qualified }),
    });
  }
  return map;
}

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((b) => b.text).join("\n");

/** A fake upstream with two filesystem-ish tools, in-memory transport. */
async function fakeUpstream() {
  const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_files",
        description: "Search files",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, pattern: { type: "string" } },
          required: ["path"],
        },
      },
      { name: "read_file", description: "Read a file", inputSchema: { type: "object" } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ok" }] }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

async function manifoldClient() {
  const upstream = await connectServer("filesystem", await fakeUpstream());
  const manifoldServer = await buildManifoldServer([upstream]);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

/** A SECOND fake upstream exposing a tool with the SAME bare name ("search_files") as
 *  `fakeUpstream`'s, under a different slug — the genuine cross-server tie the bypass-
 *  resolution map (bind.ts) must refuse to auto-translate (envelope/bare-tool-call's
 *  "alternates" teaching, never a guess). */
async function fakeBackupUpstream() {
  const server = new Server({ name: "fake-backup", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "search_files", description: "Search backup files", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "backup-ok" }] }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

async function twoServerAmbiguousClient() {
  const filesystem = await connectServer("filesystem", await fakeUpstream());
  const backup = await connectServer("backup", await fakeBackupUpstream());
  const manifoldServer = await buildManifoldServer([filesystem, backup]);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

// The default DoorSession logs via console.error — captured here for the telemetry pins.
let stderrLines: string[];
beforeEach(() => {
  stderrLines = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderrLines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const doorEvents = () =>
  stderrLines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("bypass auto-exec — an UNAMBIGUOUS direct call is translated and EXECUTED (V's design, 2026-07-05)", () => {
  it("executes through the normal manifold path — no transport throw, no teaching — and prepends the auto-exec note", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({
      name: "filesystem_search_files",
      arguments: { path: "/data", pattern: "log" },
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result as { content: unknown });
    // The recovery script IS their call, translated and RUN — parseable by construction.
    // fakeUpstream's "ok" crosses as a plain scheme string, hence the rendered quotes. The
    // attempted name is wire-underscored ("filesystem_search_files"); it resolves to the real
    // `/`-joined qualified symbol via bypassFormsOf's wire-form translation (bind.ts).
    // The auto-exec advisory rides the CONSOLIDATED notes channel, AFTER the answer:
    //   "ok"
    //   #| ── environment notes ──
    //   auto-executed as (…) — call through … next time.
    //   |#
    // It never PREPENDS to the answer: that would make it a SECOND, unlabelled notification
    // channel — the model would have to learn twice where bookkeeping lives, and the one place
    // it is guaranteed to read (the answer) would open with a non-answer. The advisory is
    // bookkeeping ABOUT the call, exactly like the define-introduction and elision notes it sits
    // beside.
    expect(text).toBe(
      '"ok"\n#| ── environment notes ──\nauto-executed as (filesystem/search_files :path "/data" :pattern "log") — call through scheme-repl-with-all-mcp-tools next time.\n|#',
    );
  });

  it("matches the BARE tool name too, resolving it to the qualified symbol", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({ name: "search_files", arguments: { path: "/data" } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result as { content: unknown })).toContain(
      'auto-executed as (filesystem/search_files :path "/data")',
    );
  });

  it("matches the LEGACY '_'-joined (wire) spelling too (still resolves via the normalized fallback — an old-habit guess isn't stranded)", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({ name: "filesystem_search_files", arguments: { path: "/data" } });
    expect(result.isError).toBeFalsy();
    // Resolves to the REAL (`/`-joined) qualified name — the attempted legacy spelling is never
    // echoed back; normalizeSymbolName collapses "/" and "_" identically, so the normalized-key
    // fallback still finds the one real tool.
    expect(textOf(result as { content: unknown })).toContain(
      'auto-executed as (filesystem/search_files :path "/data")',
    );
  });

  it("a hyphen/underscore-drifted spelling of the bare tool name also resolves (normalizeSymbolName)", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({ name: "search-files", arguments: { path: "/data" } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result as { content: unknown })).toContain(
      'auto-executed as (filesystem/search_files :path "/data")',
    );
  });

  it("the retry expr renders nested args in the same literal notation observations use", () => {
    expect(renderRetryExpr("t_create", { name: "a b", tags: ["x", 2], meta: { "weird key!": null, on: false } })).toBe(
      '(t_create :name "a b" :tags ["x" 2] :meta {"weird key!" nil :on false})',
    );
    expect(renderRetryExpr("t_ping", undefined)).toBe("(t_ping)");
  });

  it("renderRetryExpr returns undefined when a TOP-LEVEL arg key isn't a valid scheme keyword — no faithful call exists", () => {
    // A JSON object key with a space / punctuation / leading digit can't be written as a `:keyword`
    // atom (`:weird key 5` reads as THREE tokens — `:weird`, the symbol `key`, `5` — never a kwarg;
    // verified: the reader throws `Unbound variable `key'`). Nor can it be smuggled via a single
    // dict argument — arrival's kwargs runtime rejects that with "kwargs call has a dangling keyword
    // with no value — expected interleaved `:key value` pairs" (verified against the interpreter),
    // and a pipe-escaped `:|weird key|` throws "unterminated |...| symbol literal". So there is NO
    // faithful kwargs call, and the `string | undefined` return makes emitting broken syntax a
    // compile-time impossibility rather than a runtime misfire on the LIVE bypass auto-exec path.
    expect(renderRetryExpr("t", { "weird key": 5 })).toBeUndefined();
    expect(renderRetryExpr("t", { ok: 1, "1leading": 2 })).toBeUndefined(); // leading digit
    expect(renderRetryExpr("t", { "a.b": 1 })).toBeUndefined(); // dotted
    // A non-bare key nested inside a dict-literal VALUE is a DIFFERENT grammar slot renderJsonLiteral
    // quotes correctly — it never makes the top-level call unrenderable (contrast the test above).
    expect(renderRetryExpr("t", { meta: { "weird key!": 1 } })).toBe('(t :meta {"weird key!" 1})');
  });

  it("nonBareKwargKeys names exactly the TOP-LEVEL keys that can't be a `:keyword`", () => {
    expect(nonBareKwargKeys({ ok: 1, "weird key": 2, fine_too: 3, "3rd": 4 })).toEqual(["weird key", "3rd"]);
    expect(nonBareKwargKeys({ ok: 1, "kebab-ok": 2 })).toEqual([]); // kebab/snake/camel are all bare
    expect(nonBareKwargKeys(undefined)).toEqual([]);
    // Nested non-bare keys are a dict-literal concern (renderJsonLiteral quotes them), not a
    // top-level kwarg concern — nonBareKwargKeys never recurses into values.
    expect(nonBareKwargKeys({ meta: { "weird key!": 1 } })).toEqual([]);
  });

  it("bareToolCallDoor degrades its script (names the bad key, never a broken/`undefined` expr) when a key isn't kwargs-renderable", () => {
    const door = bareToolCallDoor(
      "search_files",
      { "weird key": 5, path: "/a" },
      ["filesystem/search_files"],
      TOOL_NAMING,
    );
    expect(door.code).toBe("envelope/bare-tool-call");
    // Never interpolates the literal string "undefined"; never emits a broken `:weird key` fragment.
    expect(door.script).not.toContain("undefined");
    expect(door.script).not.toContain(":weird key");
    expect(door.terse).not.toContain("undefined");
    // Names the offending key, and teaches the keyword-safe call SHAPE on the resolved symbol.
    expect(door.reason).toContain('"weird key"');
    expect(door.script).toContain("(filesystem/search_files :key value");
  });

  it("an executed bypass's OWN failure travels through untouched, note prepended — auto-exec never masks it", async () => {
    // A dedicated upstream declaring `path` REQUIRED. arrival's kwargs decode is strict
    // (args-error-reporting-v2.md §2.5) — the missing required kwarg is rejected at OUR
    // layer (kwargs-rejection.ts's frozen grammar) before the upstream is ever invoked; the
    // bypass path must carry that failure through untouched the same way it carries an
    // upstream domain failure.
    const server = new Server({ name: "fake-strict-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "search_files",
          description: "Search files",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const path = (request.params.arguments as { path?: string } | undefined)?.path;
      if (path === undefined) throw new Error("path is required");
      return { content: [{ type: "text", text: "ok" }] };
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const upstream = await connectServer("filesystem", clientTransport);
    const manifoldServer = await buildManifoldServer([upstream]);
    const [st, ct] = InMemoryTransport.createLinkedPair();
    await manifoldServer.connect(st);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(ct);

    const result = await client.callTool({ name: "filesystem_search_files", arguments: {} });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content: unknown });
    expect(text).toContain("auto-executed as (filesystem/search_files)");
    expect(text).toContain("Error: filesystem/search_files: arguments rejected — 1 problem(s):");
    expect(text).toContain("\n  :path — missing (required)");
  });

  it("DECLINES to auto-exec when an arg key isn't a valid scheme keyword — teaches, never runs broken syntax (no data loss, no misfire)", async () => {
    const client = await manifoldClient();
    // `search_files` resolves UNIQUELY to filesystem/search_files, but the arg key "weird key" is
    // structurally inexpressible as a kwarg (no `:keyword` form, no dict-arg escape hatch — both
    // verified against the interpreter). Auto-executing a degraded `(… :weird key "x")` would read
    // `key` as an unbound variable and silently DROP the datum; declining + teaching is faithful.
    const result = await client.callTool({ name: "search_files", arguments: { "weird key": "x", path: "/data" } });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content: unknown });
    // NOT auto-executed: no "auto-executed as …" note, and never the broken `:weird key` fragment.
    expect(text).not.toContain("[auto-executed");
    expect(text).not.toContain(":weird key");
    // Teaches: the tool is a symbol inside the manifold, names the bad key, shows the safe shape.
    expect(text).toContain("filesystem/search_files");
    expect(text).toContain('"weird key"');
  });

  it("a declined auto-exec logs the bare-tool-call door, NOT a bypass-autoexec event (nothing ran)", async () => {
    const client = await manifoldClient();
    await client.callTool({ name: "search_files", arguments: { "weird key": 5 } });
    const events = doorEvents();
    expect(events.some((e) => e.door === "envelope/bypass-autoexec")).toBe(false);
    expect(events.some((e) => e.door === "envelope/bare-tool-call" && e.tool === "search_files")).toBe(true);
  });
});

describe("bypass ambiguous — a cross-server tie is never guessed (V's tolerance rule)", () => {
  it("returns the candidates door (no auto-exec) when two servers bind the same bare tool name", async () => {
    const client = await twoServerAmbiguousClient();
    const result = await client.callTool({ name: "search_files", arguments: { path: "/data" } });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content: unknown });
    // `fact` names the ATTEMPTED (bare) name, not either qualified candidate.
    expect(text).toMatch(
      /^Error: search_files is a symbol inside the scheme-repl-with-all-mcp-tools tool's repl-input-scheme-program/,
    );
    expect(text).toContain("also bound as");
  });
});

describe("envelope/unknown-tool — a name bound nowhere at all", () => {
  it("returns a did-you-mean door over the catalog", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({ name: "totally_unbound_operation_zzz", arguments: {} });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content: unknown });
    expect(text).toMatch(/^Error: totally_unbound_operation_zzz is not a tool on this server/);
    expect(text).toContain("Retry — call the scheme-repl-with-all-mcp-tools tool with repl-input-scheme-program = (");
  });

  it("nearestBoundNames: prefix + edit distance over qualified AND bare names, top 3", () => {
    const parts = toolParts([
      { slug: "filesystem", tool: "search_files" },
      { slug: "filesystem", tool: "read_file" },
      { slug: "github", tool: "search-issues" },
      { slug: "github", tool: "create-issue" },
    ]);
    const catalog = [...parts.keys()];
    expect(nearestBoundNames("search_files", catalog, parts)[0]).toBe("filesystem/search_files");
    expect(nearestBoundNames("filesystem_read_file", catalog, parts)[0]).toBe("filesystem/read_file");
    expect(nearestBoundNames("github_search", catalog, parts)[0]).toBe("github/search-issues");
    expect(nearestBoundNames("x", catalog, parts)).toHaveLength(3);
  });
});

describe("envelope/bypass-autoexec — telemetry (V's design, 2026-07-05)", () => {
  it("logs one {door, seq, tool, resolvedTo} line, distinct from envelope/bare-tool-call", async () => {
    const client = await manifoldClient();
    await client.callTool({ name: "search_files", arguments: { path: "/data" } });
    const events = doorEvents();
    expect(events).toContainEqual({
      door: "envelope/bypass-autoexec",
      seq: 1,
      tool: "search_files",
      resolvedTo: "filesystem/search_files",
    });
  });
});

describe("ambiguousBypassDoor — pure unit tests", () => {
  it("a cross-server tie reuses bareToolCallDoor's alternates teaching verbatim", () => {
    const door = ambiguousBypassDoor(
      "search_files",
      { path: "/a" },
      ["backup/search_files", "filesystem/search_files"],
      TOOL_NAMING,
    );
    expect(door.code).toBe("envelope/bare-tool-call");
    expect(door.script).toContain("also bound as");
    // No globalCollision arg — the door is byte-identical to bareToolCallDoor's own output.
    expect(door).toEqual(
      bareToolCallDoor("search_files", { path: "/a" }, ["backup/search_files", "filesystem/search_files"], TOOL_NAMING),
    );
  });

  it("a global-symbol collision appends the collision sentence to a single-candidate door", () => {
    const door = ambiguousBypassDoor("map", { fn: "double" }, ["utils/map"], TOOL_NAMING, "map");
    expect(door.reason).toContain('"map" is ALSO a bound top-level symbol in this environment');
    expect(door.terse).toContain('"map" is ALSO a bound top-level symbol');
  });
});

describe("verbosity gate + telemetry (DoorSession)", () => {
  it("same code: verbose once, terse after; different code: verbose again (per-code gate)", () => {
    const lines: string[] = [];
    const session = new DoorSession((l) => lines.push(l));
    const bare = bareToolCallDoor("t_a", { x: 1 }, ["t/a"], TOOL_NAMING);
    expect(session.render(bare, "t_a")).toContain("Why:");
    expect(session.render(bare, "t_a")).toBe("Error: bare tool call again — wrap it: (t/a :x 1)");
    // A DIFFERENT code still gets its own verbose intro.
    const parts = toolParts([{ slug: "t", tool: "a" }]);
    expect(session.render(unknownToolDoor("nope", ["t/a"], parts, TOOL_NAMING), "nope")).toContain("Why:");
  });

  it("logs {door, seq, tool} lines and a {door-followed} line when the next successful expr contains the tool", () => {
    const lines: string[] = [];
    const session = new DoorSession((l) => lines.push(l));
    session.render(bareToolCallDoor("search_files", {}, ["filesystem/search_files"], TOOL_NAMING), "search_files");
    expect(JSON.parse(lines[0]!)).toEqual({ door: "envelope/bare-tool-call", seq: 1, tool: "search_files" });
    // An unrelated success does not count as followed…
    session.observeSuccess("(+ 1 2)");
    expect(lines).toHaveLength(1);
    // …the retry containing the tool name does, exactly once.
    session.observeSuccess('(filesystem/search_files :path "/data")');
    session.observeSuccess('(filesystem/search_files :path "/data")');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual({ "door-followed": "envelope/bare-tool-call", tool: "search_files" });
  });

  it("end-to-end: an AMBIGUOUS bypass door then the successful explicit retry emits door + door-followed on stderr", async () => {
    // A unique bypass no longer renders a door at all (it auto-executes — see the
    // "bypass auto-exec" describe block above) — this end-to-end door+follow-rate
    // telemetry is now exercised via the genuinely ambiguous cross-server tie instead.
    const client = await twoServerAmbiguousClient();
    await client.callTool({ name: "search_files", arguments: { path: "/data" } });
    await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: '(filesystem/search_files :path "/data")' },
    });
    const events = doorEvents();
    expect(events).toContainEqual({ door: "envelope/bare-tool-call", seq: 1, tool: "search_files" });
    expect(events).toContainEqual({ "door-followed": "envelope/bare-tool-call", tool: "search_files" });
  });
});

describe("normalizeSymbolName — the canonical-form primitive", () => {
  it("camelCase, kebab-case, and snake_case all normalize to the same token", () => {
    expect(normalizeSymbolName("searchNodes")).toBe("searchnodes");
    expect(normalizeSymbolName("search-nodes")).toBe("searchnodes");
    expect(normalizeSymbolName("search_nodes")).toBe("searchnodes");
  });

  it("a mixed-separator name still collapses to one token", () => {
    expect(normalizeSymbolName("Search-Nodes_Mixed")).toBe("searchnodesmixed");
  });

  it("a qualified server/tool name normalizes as ONE token — callers strip the prefix themselves first", () => {
    expect(normalizeSymbolName("memory/search_nodes")).toBe("memorysearchnodes");
  });

  it("the legacy '_'-joined (wire) shape still normalizes identically (generality, not just today's convention)", () => {
    expect(normalizeSymbolName("memory_search_nodes")).toBe("memorysearchnodes");
  });
});

describe("envelope/unbound-in-expr — the THREE-TIER tool-resolution door (unboundInExprDoor)", () => {
  const CATALOG_PARTS = toolParts([
    { slug: "filesystem", tool: "search_files" },
    { slug: "filesystem", tool: "directory_tree" },
    { slug: "memory", tool: "search_nodes" },
    { slug: "memory", tool: "create_entities" },
  ]);
  const CATALOG = [...CATALOG_PARTS.keys()];
  // EXAMPLE-CALL TEACHING (V's design, 2026-07-05): schemas for a couple of catalog tools, so
  // the resolved-tool doors below render a REAL stubbed example, not a degenerate bare call.
  // `filesystem/search_files` and `memory/create_entities` are deliberately left schema-less —
  // exercising the "no schema known → bare call" graceful degrade mid-list (tier 3's test).
  const CATALOG_SCHEMAS = new Map<string, ToolJsonSchema | undefined>([
    ["memory/search_nodes", { type: "object", properties: { query: { type: "string" } }, required: ["query"] }],
    ["filesystem/directory_tree", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }],
  ]);

  describe("tier 1 — normalized bare-name match → EXPLICIT fact (a single match is a certainty)", () => {
    it("a camelCase de-namespaced tool name → the exact qualified symbol, stated as fact + the prefix teaching + a full example call", () => {
      const door = unboundInExprDoor("searchNodes", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS);
      expect(door?.fact).toBe(
        "There's no such symbol — the symbol you want is `memory/search_nodes`. Tool symbols keep their full server/tool-name form inside repl-input-scheme-program. For example: (memory/search_nodes :query #|string|#)",
      );
      expect(door?.reason).toBe("");
    });

    it("a unique resolution renders the FULL example call (not just the bare tool name), in both fact and terse", () => {
      const door = unboundInExprDoor("searchNodes", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS);
      expect(door?.fact).toContain("For example: (memory/search_nodes :query #|string|#)");
      expect(door?.terse).toBe(
        "the symbol you want is `memory/search_nodes` — e.g. (memory/search_nodes :query #|string|#).",
      );
    });

    it("a resolved tool with NO schema known degrades to a bare-call example, never a crash", () => {
      // filesystem/search_files carries no entry in CATALOG_SCHEMAS.
      const door = unboundInExprDoor("searchFiles", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS);
      expect(door?.fact).toContain("For example: (filesystem/search_files)");
    });

    it("a kebab-case de-namespaced tool name → the same explicit qualified fact", () => {
      expect(unboundInExprDoor("search-nodes", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS)?.fact).toContain(
        "the symbol you want is `memory/search_nodes`",
      );
    });

    it("a no-slug candidate (single-server empty-slug binding) → the explicit fact with NO prefix teaching", () => {
      const parts = toolParts([
        { slug: "", tool: "search_files" },
        { slug: "", tool: "directory_tree" },
      ]);
      const door = unboundInExprDoor("searchFiles", [...parts.keys()], parts, TOOL_NAMING);
      expect(door?.fact).toBe(
        "There's no such symbol — the symbol you want is `search_files`. For example: (search_files)",
      );
      expect(door?.fact).not.toContain("server/tool-name");
    });

    it("the SAME bare name bound on multiple servers → a genuine tie, NOT explicit — the did-you-mean list stands, every candidate's example call rendered", () => {
      const parts = toolParts([
        { slug: "memory", tool: "search_nodes" },
        { slug: "graph", tool: "search_nodes" },
      ]);
      const schemas = new Map<string, ToolJsonSchema | undefined>([
        ["memory/search_nodes", { type: "object", properties: { query: { type: "string" } }, required: ["query"] }],
        ["graph/search_nodes", { type: "object", properties: { id: { type: "number" } }, required: ["id"] }],
      ]);
      const door = unboundInExprDoor("search_nodes", [...parts.keys()], parts, TOOL_NAMING, schemas);
      expect(door?.fact).toBe(
        "There's no such symbol — did you mean: memory/search_nodes, graph/search_nodes? Tool symbols keep their full server/tool-name form inside repl-input-scheme-program. " +
          "Pick the one you mean — for example: (memory/search_nodes :query #|string|#); (graph/search_nodes :id #|number|#)",
      );
      expect(door?.terse).toBe(
        "did you mean: memory/search_nodes, graph/search_nodes? e.g. (memory/search_nodes :query #|string|#); (graph/search_nodes :id #|number|#)",
      );
    });
  });

  describe("tier 2 — right server, wrong tool (+ wrong-separator special-casing)", () => {
    it("wrong separator '.' that DOES resolve to a real tool → the explicit fact (routed via a tier-2 split)", () => {
      // "memory.search_nodes" contains an `_` (inside the tool-name tail, "search_nodes") even
      // though "." is the string's actual separator — detectServerToolSplit tries `/` first
      // (absent here), then walks WRONG_SEPARATORS ([".", ":", "_"]) in order; "." is tried
      // before "_" and finds the real slug "memory" first, so the split resolves correctly
      // without ever needing to fall through to "_".
      expect(
        unboundInExprDoor("memory.search_nodes", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS)?.fact,
      ).toContain("the symbol you want is `memory/search_nodes`");
    });

    it("wrong separator ':' whose tool part matches nothing on that server → the server's tool menu (unaffected by the example-call upgrade — a zero-match menu, not a resolution)", () => {
      const door = unboundInExprDoor("memory:searchNodez", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS);
      expect(door?.fact).toBe(
        "server `memory` has no tool `searchNodez` — its tools are: search_nodes, create_entities.",
      );
    });

    it("the correct '/' separator that DOES resolve to a real tool → the explicit fact (routed via tier 1's real-slash strip)", () => {
      expect(
        unboundInExprDoor("memory/search_nodes", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS)?.fact,
      ).toContain("the symbol you want is `memory/search_nodes`");
    });

    it("the correct '/' separator whose tool part matches nothing on that server → the server's tool menu", () => {
      const door = unboundInExprDoor("memory/search_nodez", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS);
      expect(door?.fact).toBe(
        "server `memory` has no tool `search_nodez` — its tools are: search_nodes, create_entities.",
      );
    });

    it("legacy wire separator '_' with a garbled tool part → the server's tool menu (the base tier-2 case)", () => {
      const door = unboundInExprDoor("memory_serach_nodes", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS);
      expect(door?.fact).toBe(
        "server `memory` has no tool `serach_nodes` — its tools are: search_nodes, create_entities.",
      );
    });
  });

  describe("tier 3 — fuzzy fallback, tool names only", () => {
    it("a garbled tool name (edit distance 1) with no recognizable server prefix → promoted to the explicit fact (a single TIGHT candidate is still a certainty), with its example call", () => {
      expect(unboundInExprDoor("search_node", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS)?.fact).toBe(
        "There's no such symbol — the symbol you want is `memory/search_nodes`. Tool symbols keep their full server/tool-name form inside repl-input-scheme-program. For example: (memory/search_nodes :query #|string|#)",
      );
      expect(unboundInExprDoor("directory_tre", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS)?.fact).toBe(
        "There's no such symbol — the symbol you want is `filesystem/directory_tree`. Tool symbols keep their full server/tool-name form inside repl-input-scheme-program. For example: (filesystem/directory_tree :path #|string|#)",
      );
    });

    it("a fuzzy multi-candidate list (no single tight match) renders EVERY candidate's example call, one schema-less and one schema-equipped", () => {
      // "search" is a ≥3-char prefix of BOTH "search_files" and "search_nodes" (loose, not
      // tight — edit distance from either bare name is 6, well past the ≤1 tight bar), so
      // tier 3 offers both as a guess list rather than promoting either to a certainty.
      const door = unboundInExprDoor("search", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS);
      expect(door?.fact).toContain("nearest tools:");
      expect(door?.fact).toContain("Pick the one you mean — for example:");
      expect(door?.fact).toContain("(memory/search_nodes :query #|string|#)");
      expect(door?.fact).toContain("(filesystem/search_files)"); // no schema fixture → bare call
      expect(door?.terse).toContain("(memory/search_nodes :query #|string|#)");
    });

    it("a genuinely unknown, far-from-everything, non-literal symbol → undefined (no false teaching)", () => {
      expect(
        unboundInExprDoor("this-symbol-is-unbound", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS),
      ).toBeUndefined();
      expect(unboundInExprDoor("broken", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS)).toBeUndefined();
      expect(unboundInExprDoor("frobnicate", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS)).toBeUndefined();
    });
  });

  describe("library-verb typos are NOT this door's job — arrival owns that enrichment now", () => {
    it("a typo'd library verb (no tool tier matches) → the manifold door fires nothing", () => {
      // string-splt is a typo of a bound SCHEME BUILTIN, not a tool — the manifold door only
      // ever resolves TOOL names (tiers 1-3); arrival's own polyglot-rich-errors capability
      // enriches this inside the frozen first line before this door ever runs (manifold-tool.ts).
      expect(unboundInExprDoor("string-splt", CATALOG, CATALOG_PARTS, TOOL_NAMING)).toBeUndefined();
    });
  });

  describe("the data-literal quoting hint — a separate, orthogonal concern", () => {
    it("`null` → the nil/omit teaching (never a wrong quoting suggestion)", () => {
      const door = unboundInExprDoor("null", CATALOG, CATALOG_PARTS, TOOL_NAMING);
      expect(door?.fact).toBe(
        "JSON null is spelled '() (empty/nil) here; in tool arguments simply OMIT the optional parameter instead of passing null.",
      );
    });

    it("an ISO date / ALL-CAPS enum / dotted domain → the quote-it suggestion", () => {
      expect(unboundInExprDoor("2021-12-31", CATALOG, CATALOG_PARTS, TOOL_NAMING)?.fact).toBe(
        '2021-12-31 looks like a data value, not a symbol — write it as the string "2021-12-31" (or keyword :2021-12-31 where a parameter name is meant).',
      );
      expect(unboundInExprDoor("COMPLETED", CATALOG, CATALOG_PARTS, TOOL_NAMING)?.fact).toContain(
        'write it as the string "COMPLETED"',
      );
      expect(unboundInExprDoor("metmuseum.org", CATALOG, CATALOG_PARTS, TOOL_NAMING)?.fact).toContain(
        'write it as the string "metmuseum.org"',
      );
    });

    it("a tier-1 match that ALSO looks literal (ALL-CAPS) → the explicit fact first, the quoting hint as a second line", () => {
      const door = unboundInExprDoor("SEARCH_NODES", CATALOG, CATALOG_PARTS, TOOL_NAMING);
      expect(door?.fact).toContain("the symbol you want is `memory/search_nodes`");
      expect(door?.reason).toContain('write it as the string "SEARCH_NODES"');
    });
  });

  it("verbosity: first occurrence appends the full teaching, later ones the terse one-liner; telemetry logs the code", () => {
    const lines: string[] = [];
    const session = new DoorSession((l) => lines.push(l));
    const door = unboundInExprDoor("searchNodes", CATALOG, CATALOG_PARTS, TOOL_NAMING, CATALOG_SCHEMAS)!;
    const first = session.enrichInline(door, "searchNodes");
    expect(first).toBe(
      "\n  There's no such symbol — the symbol you want is `memory/search_nodes`. Tool symbols keep their full server/tool-name form inside repl-input-scheme-program. For example: (memory/search_nodes :query #|string|#)",
    );
    const second = session.enrichInline(door, "searchNodes");
    expect(second).toBe(
      "\n  the symbol you want is `memory/search_nodes` — e.g. (memory/search_nodes :query #|string|#).",
    );
    expect(JSON.parse(lines[0]!)).toEqual({ door: "envelope/unbound-in-expr", seq: 1, tool: "searchNodes" });
  });

  it("end-to-end: a real in-expr unbound wall is ENRICHED — the frozen first line stays verbatim, the example call rides on the real tool schema", async () => {
    const manifoldEnv = await buildManifoldEnv([
      {
        slug: "filesystem",
        tools: [
          {
            name: "search_files",
            inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            invoke: async () => ({}),
          },
        ],
      },
    ]);
    const tool = createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
    const result = await tool.call({ expr: '(search_files :path "/data")' });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content: unknown });
    // H-4: the FIRST line is arrival's wall, byte-for-byte; the door is an indented suffix below.
    expect(text.split("\n")[0]).toBe("Error: Unbound variable `search_files'");
    expect(text).toContain("the symbol you want is `filesystem/search_files`");
    // The example call is recovered end-to-end off the REAL env's schema (bind.ts's
    // toolSchemasForEnv), with NO extra wiring beyond the bound-tool registry.
    expect(text).toContain("For example: (filesystem/search_files :path #|string|#)");
  });

  it("end-to-end: a library-verb typo is arrival's OWN enrichment now — the manifold door adds nothing of its own", async () => {
    const manifoldEnv = await buildManifoldEnv([
      {
        slug: "filesystem",
        tools: [{ name: "search_files", inputSchema: { type: "object" }, invoke: async () => ({}) }],
      },
    ]);
    const tool = createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
    const result = await tool.call({ expr: '(string-splt "a,b" ",")' });
    const text = textOf(result as { content: unknown });
    // H-4: the frozen first line is arrival's own message VERBATIM — the `polyglot-rich-errors`
    // capability enriches "Unbound variable" at the interpreter level for its curated well-known
    // symbols (SRFI/R7RS), so its did-you-mean already rides inline on the ONE line. The manifold
    // door (tiers 1-3, tool names only) has nothing to add here — no second, indented suffix line.
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toMatch(/^Error: Unbound variable `string-splt'/);
  });

  it("end-to-end: a genuinely unknown symbol is NOT enriched — the wall is exactly one line", async () => {
    const manifoldEnv = await buildManifoldEnv([
      {
        slug: "filesystem",
        tools: [{ name: "search_files", inputSchema: { type: "object" }, invoke: async () => ({}) }],
      },
    ]);
    const tool = createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
    const result = await tool.call({ expr: "(frobnicate 1)" });
    expect(textOf(result as { content: unknown })).toBe("Error: Unbound variable `frobnicate'");
  });
});

describe("door text discipline", () => {
  it("no stop-words, no raw codes in any rendered door", () => {
    const lines: string[] = [];
    const session = new DoorSession((l) => lines.push(l));
    const parts = toolParts([
      { slug: "t", tool: "a" },
      { slug: "t", tool: "b" },
    ]);
    const rendered = [
      session.render(bareToolCallDoor("t_a", { x: 1 }, ["t/a"], TOOL_NAMING), "t_a"),
      session.render(unknownToolDoor("nope", ["t/a", "t/b"], parts, TOOL_NAMING), "nope"),
    ].join("\n");
    expect(rendered).not.toMatch(/invalid|forbidden|illegal|please|sorry|oops/i);
    expect(rendered).not.toContain("envelope/"); // codes are internal telemetry keys
  });
});
